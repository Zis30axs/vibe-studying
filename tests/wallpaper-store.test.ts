import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WallpaperStore, inspectWallpaperRaster } from '../electron/wallpaper-store'
import { defaultAppearancePreferences, MAX_WALLPAPER_BYTES } from '../src/shared/appearance'
import { ModelDebugStore } from '../src/adapters/model-debug'
import { studyStateSchema } from '../src/domain/schemas'

// Synthetic 1×1 PNG. Decoder normalization is injected; these tests do not claim Electron GUI coverage.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNocDjwHwAFRAKAb2WvNQAAAABJRU5ErkJggg==',
  'base64',
)
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup(normalize = vi.fn((input: Buffer) => Buffer.from(input))) {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-wallpaper-test-'))
  directories.push(directory)
  const selected = join(directory, 'PRIVATE-ORIGINAL-PHOTO.png')
  await writeFile(selected, png)
  return {
    directory,
    selected,
    normalize,
    store: new WallpaperStore(directory, normalize),
    restart: () => new WallpaperStore(directory, normalize),
  }
}
function jpeg(width = 3, height = 2) {
  const b = Buffer.alloc(32)
  b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8])
  b.writeUInt16BE(height, 7)
  b.writeUInt16BE(width, 9)
  return b
}
function chunk(kind: string, data: Buffer) {
  const b = Buffer.alloc(8 + data.length + (data.length % 2))
  b.write(kind)
  b.writeUInt32LE(data.length, 4)
  b.set(data, 8)
  return b
}
function webp(width = 3, height = 2, extended = false, canvasWidth = width, animated = false) {
  const data = Buffer.alloc(5)
  data[0] = 0x2f
  data.writeUInt32LE(((height - 1) << 14) | (width - 1), 1)
  const pieces = [chunk('VP8L', data)]
  if (extended) {
    const header = Buffer.alloc(10)
    header[0] = animated ? 2 : 0
    header.writeUIntLE(canvasWidth - 1, 4, 3)
    header.writeUIntLE(height - 1, 7, 3)
    pieces.unshift(chunk('VP8X', header))
  }
  const b = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), ...pieces])
  b.writeUInt32LE(b.length - 8, 4)
  return b
}

describe('wallpaper raster boundary', () => {
  it('sniffs PNG, JPEG and static WebP dimensions before any decoder call', () => {
    expect(inspectWallpaperRaster(png)).toEqual({ width: 1, height: 1, format: 'png' })
    expect(inspectWallpaperRaster(jpeg())).toEqual({ width: 3, height: 2, format: 'jpeg' })
    expect(inspectWallpaperRaster(webp())).toEqual({ width: 3, height: 2, format: 'webp' })
    expect(inspectWallpaperRaster(webp(3, 2, true))).toEqual({
      width: 3,
      height: 2,
      format: 'webp',
    })
  })
  it('rejects arbitrary bytes, SVG, byte/dimension/pixel bombs and animated or misleading WebP', () => {
    const hugePixels = Buffer.from(png)
    hugePixels.writeUInt32BE(8000, 16)
    hugePixels.writeUInt32BE(4000, 20)
    const hugeWidth = Buffer.from(png)
    hugeWidth.writeUInt32BE(8193, 16)
    const zero = Buffer.from(png)
    zero.writeUInt32BE(0, 16)
    const truncatedChunk = webp()
    truncatedChunk.writeUInt32LE(300, 16)
    for (const bytes of [
      Buffer.from('<svg><script>alert(1)</script></svg>'),
      Buffer.alloc(MAX_WALLPAPER_BYTES + 1),
      Buffer.alloc(20),
      hugePixels,
      hugeWidth,
      zero,
      jpeg(9000, 2),
      webp(9000, 2),
      webp(3, 2, true, 1),
      webp(3, 2, true, 3, true),
      truncatedChunk,
    ])
      expect(() => inspectWallpaperRaster(bytes)).toThrow(/请选择/)
  })
})

describe('private local wallpaper persistence', () => {
  it('defaults to no wallpaper, copies normalized PNG, retains no original path, and survives restart', async () => {
    const { store, restart, selected, directory, normalize } = await setup(
      vi.fn(() => Buffer.from(png)),
    )
    expect(await store.get()).toEqual({
      preferences: defaultAppearancePreferences(),
      wallpaper: null,
    })
    const result = await store.importSelectedFile(selected, store.beginSelection())
    expect(result.canceled).toBe(false)
    expect(result.appearance.wallpaper).toEqual({
      width: 1,
      height: 1,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    })
    expect(JSON.stringify(result)).not.toContain(selected)
    expect(normalize).toHaveBeenCalled()
    const files = await readdir(join(directory, 'appearance'))
    expect(files).toHaveLength(2)
    const saved = await readFile(join(directory, 'appearance', 'preferences.json'), 'utf8')
    expect(saved).not.toContain('PRIVATE-ORIGINAL-PHOTO')
    expect(saved).not.toContain('data:image')
    expect(saved).not.toContain(png.toString('base64'))
    expect(await restart().get()).toEqual(result.appearance)
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'appearance'))).mode & 0o777).toBe(0o700)
      expect(
        (
          await stat(
            join(
              directory,
              'appearance',
              files.find((name) => name.endsWith('.png'))!,
            ),
          )
        ).mode & 0o777,
      ).toBe(0o600)
    }
  })
  it('persists rapid preference updates in invocation order without decoding or returning wallpaper bytes', async () => {
    const { store, selected, normalize, restart } = await setup()
    await store.importSelectedFile(selected, store.beginSelection())
    normalize.mockClear()
    const results = await Promise.all(
      Array.from({ length: 36 }, (_, index) =>
        store.save({
          ...defaultAppearancePreferences(),
          theme: 'dark',
          wallpaper: {
            ...defaultAppearancePreferences().wallpaper,
            opacity: index / 100,
            blur: 12,
            fit: 'contain',
            position: 'bottom',
          },
        }),
      ),
    )
    expect(normalize).not.toHaveBeenCalled()
    expect(JSON.stringify(results)).not.toContain('data:image')
    const next = await restart().get()
    expect(next.preferences).toEqual({
      version: 1,
      theme: 'dark',
      wallpaper: { opacity: 0.35, blur: 12, fit: 'contain', position: 'bottom' },
    })
    expect(next.wallpaper).not.toBeNull()
  })
  it('cancellation is read-only and reset invalidates an older open chooser', async () => {
    const { store, selected, directory } = await setup()
    const before = await store.importSelectedFile(selected, store.beginSelection())
    store.beginSelection() // Native chooser canceled: no path is passed to the store.
    expect(await store.get()).toEqual(before.appearance)
    const stale = store.beginSelection()
    await store.remove(true)
    expect(await store.importSelectedFile(selected, stale)).toEqual({
      canceled: true,
      appearance: { preferences: defaultAppearancePreferences(), wallpaper: null },
    })
    expect(await readdir(join(directory, 'appearance'))).toEqual(['preferences.json'])
    expect(await readFile(selected)).toEqual(png)
  })
  it('a reset while validation is in progress wins over the stale import', async () => {
    const setupResult = await setup()
    let pendingReset: Promise<unknown> | undefined
    let store: WallpaperStore
    store = new WallpaperStore(setupResult.directory, (input) => {
      pendingReset = store.remove(true)
      return input
    })
    const result = await store.importSelectedFile(setupResult.selected, store.beginSelection())
    await pendingReset
    expect(result.canceled).toBe(true)
    expect((await store.get()).wallpaper).toBeNull()
  })
  it('a newer selection replaces a stale one and clears only the previous app-owned copy', async () => {
    const { store, selected, directory } = await setup()
    const first = store.beginSelection()
    const second = store.beginSelection()
    expect((await store.importSelectedFile(selected, first)).canceled).toBe(true)
    expect((await store.importSelectedFile(selected, second)).canceled).toBe(false)
    const old = (await readdir(join(directory, 'appearance'))).find((name) =>
      name.endsWith('.png'),
    )!
    await store.importSelectedFile(selected, store.beginSelection())
    expect(await readdir(join(directory, 'appearance'))).not.toContain(old)
    expect(await readFile(selected)).toEqual(png)
  })
  it('rejects unsafe formats, URLs, paths, symlinks, directories, huge files, and damaged decoder inputs without replacing current wallpaper', async () => {
    const { store, selected, directory, normalize } = await setup()
    const previous = (await store.importSelectedFile(selected, store.beginSelection())).appearance
    const svg = join(directory, 'unsafe.svg')
    await writeFile(svg, '<svg><script>evil</script></svg>')
    const disguised = join(directory, 'disguised.png')
    await writeFile(disguised, '<svg><script>evil</script></svg>')
    const oversized = join(directory, 'huge.png')
    await writeFile(oversized, Buffer.alloc(MAX_WALLPAPER_BYTES + 1))
    const folder = join(directory, 'folder.png')
    await mkdir(folder)
    const link = join(directory, 'symlink.png')
    await symlink(selected, link)
    const bomb = join(directory, 'dimensions.png')
    const bytes = Buffer.from(png)
    bytes.writeUInt32BE(9000, 16)
    await writeFile(bomb, bytes)
    normalize.mockClear()
    for (const input of [
      svg,
      disguised,
      oversized,
      folder,
      link,
      bomb,
      'https://private.example/photo.png',
      `file://${selected}`,
      'relative.png',
      join(directory, 'missing.png'),
    ]) {
      await expect(store.importSelectedFile(input, store.beginSelection())).rejects.toThrow(
        /请选择/,
      )
    }
    expect(normalize).not.toHaveBeenCalled()
    const failing = new WallpaperStore(directory, () => {
      throw new Error(`PRIVATE DECODER PATH ${selected}`)
    })
    try {
      await failing.importSelectedFile(selected, failing.beginSelection())
      expect.fail('decoder must reject')
    } catch (error) {
      expect(String(error)).not.toContain(selected)
      expect(String(error)).not.toContain('PRIVATE DECODER')
    }
    expect(await store.get()).toEqual(previous)
  })
  it('recovers missing/corrupt wallpaper while preserving settings and can remove it', async () => {
    const { store, selected, directory, restart } = await setup()
    await store.save({ ...defaultAppearancePreferences(), theme: 'dark' })
    await store.importSelectedFile(selected, store.beginSelection())
    const asset = (await readdir(join(directory, 'appearance'))).find((name) =>
      name.endsWith('.png'),
    )!
    await writeFile(join(directory, 'appearance', asset), '<svg>tampered</svg>')
    const corrupt = await restart().get()
    expect(corrupt.wallpaper).toBeNull()
    expect(corrupt.preferences.theme).toBe('dark')
    expect(corrupt.warning).toMatch(/丢失或损坏/)
    await rm(join(directory, 'appearance', asset))
    expect((await restart().get()).warning).toMatch(/丢失或损坏/)
    expect((await store.remove()).preferences.theme).toBe('dark')
  })
  it('resets corrupt config and orphan copies without following traversal, deleting original, or touching unrelated files', async () => {
    const { store, directory, selected } = await setup()
    await store.importSelectedFile(selected, store.beginSelection())
    await writeFile(
      join(directory, 'appearance', 'preferences.json'),
      JSON.stringify({
        preferences: defaultAppearancePreferences(),
        asset: '../PRIVATE-ORIGINAL-PHOTO.png',
      }),
    )
    await writeFile(join(directory, 'appearance', 'unrelated.txt'), 'keep me')
    await writeFile(join(directory, 'appearance', `${randomUUID()}.tmp`), 'synthetic orphan')
    expect((await store.get()).warning).toMatch(/外观设置无法读取/)
    await store.remove(true)
    expect((await readdir(join(directory, 'appearance'))).sort()).toEqual([
      'preferences.json',
      'unrelated.txt',
    ])
    expect(await readFile(selected)).toEqual(png)
    expect(await readFile(join(directory, 'appearance', 'unrelated.txt'), 'utf8')).toBe('keep me')
  })
  it('does not follow a replaced app-owned directory symlink during reset or import', async () => {
    const { store, directory, selected } = await setup()
    const other = join(directory, 'other')
    await mkdir(other)
    const name = `${randomUUID()}.png`
    await writeFile(join(other, name), png)
    await symlink(other, join(directory, 'appearance'), 'dir')
    await expect(store.remove(true)).rejects.toThrow(/无法重置/)
    await expect(store.importSelectedFile(selected, store.beginSelection())).rejects.toThrow(
      /无法保存/,
    )
    expect(await readFile(join(other, name))).toEqual(png)
  })
  it('strictly excludes appearance from study-state serialization and debug records', async () => {
    const { store, selected } = await setup()
    const appearance = (await store.importSelectedFile(selected, store.beginSelection())).appearance
    expect(
      studyStateSchema.safeParse({
        version: 1,
        drafts: {},
        attempts: [],
        appearance,
        wallpaper: appearance.wallpaper,
        originalPath: selected,
      }).success,
    ).toBe(false)
    const study = studyStateSchema.parse({ version: 1, drafts: {}, attempts: [] })
    const debug = new ModelDebugStore()
    debug.setEnabled(true)
    debug.record({
      requestId: randomUUID(),
      protocol: 'openai-chat',
      model: 'synthetic',
      stage: 'request',
      category: 'ok',
      elapsedMs: 1,
      appearance,
      wallpaper: appearance.wallpaper,
      originalPath: selected,
    } as Parameters<typeof debug.record>[0])
    expect(debug.getState().records).toHaveLength(1)
    for (const serialized of [JSON.stringify(study), debug.copyText()]) {
      expect(serialized).not.toContain('data:image')
      expect(serialized).not.toContain(png.toString('base64'))
      expect(serialized).not.toContain(selected)
      expect(serialized).not.toContain('wallpaper')
    }
  })
})
