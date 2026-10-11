import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import {
  appearancePreferencesSchema,
  defaultAppearancePreferences,
  MAX_WALLPAPER_BYTES,
  MAX_WALLPAPER_DIMENSION,
  MAX_WALLPAPER_PIXELS,
  type AppearancePreferences,
  type AppearanceSnapshot,
} from '../src/shared/appearance'

const ownedFilePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|tmp)$/
const assetPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/
const fileExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp'])
type StoredAppearance = { preferences: AppearancePreferences; asset: string | null }
export class WallpaperError extends Error {}
const imageError = () =>
  new WallpaperError(
    '请选择未损坏的 PNG、JPEG 或 WebP 图片，大小不超过 10 MiB、最长边不超过 8192 像素、总像素不超过 2400 万。',
  )
function dimensions(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_WALLPAPER_DIMENSION ||
    height > MAX_WALLPAPER_DIMENSION ||
    width * height > MAX_WALLPAPER_PIXELS
  )
    throw imageError()
  return { width, height }
}
/** Inspect dimensions BEFORE native decoding; SVG/GIF/unknown formats never reach the decoder. */
export function inspectWallpaperRaster(bytes: Uint8Array): {
  width: number
  height: number
  format: 'png' | 'jpeg' | 'webp'
} {
  if (bytes.length < 24 || bytes.length > MAX_WALLPAPER_BYTES) throw imageError()
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.readUInt32BE(8) === 13 &&
    b.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return { ...dimensions(b.readUInt32BE(16), b.readUInt32BE(20)), format: 'png' }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 0xff) throw imageError()
      while (b[offset] === 0xff) offset++
      const marker = b[offset++]
      if (marker === 0xd9 || marker === 0xda || marker === undefined) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > b.length) break
      const length = b.readUInt16BE(offset)
      if (length < 2 || offset + length > b.length) throw imageError()
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw imageError()
        return {
          ...dimensions(b.readUInt16BE(offset + 5), b.readUInt16BE(offset + 3)),
          format: 'jpeg',
        }
      }
      offset += length
    }
    throw imageError()
  }
  if (
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP' &&
    b.readUInt32LE(4) + 8 === b.length
  ) {
    let canvas: { width: number; height: number } | undefined
    let image: { width: number; height: number } | undefined
    let offset = 12
    while (offset + 8 <= b.length) {
      const kind = b.toString('ascii', offset, offset + 4)
      const length = b.readUInt32LE(offset + 4)
      const body = offset + 8
      if (body + length > b.length) throw imageError()
      if (kind === 'ANIM' || kind === 'ANMF') throw imageError()
      if (kind === 'VP8X') {
        if (offset !== 12 || length !== 10 || b[body] & 2) throw imageError()
        canvas = dimensions(b.readUIntLE(body + 4, 3) + 1, b.readUIntLE(body + 7, 3) + 1)
      } else if (kind === 'VP8 ') {
        if (
          image ||
          length < 10 ||
          b[body + 3] !== 0x9d ||
          b[body + 4] !== 0x01 ||
          b[body + 5] !== 0x2a
        )
          throw imageError()
        image = dimensions(b.readUInt16LE(body + 6) & 0x3fff, b.readUInt16LE(body + 8) & 0x3fff)
      } else if (kind === 'VP8L') {
        if (image || length < 5 || b[body] !== 0x2f) throw imageError()
        const bits = b.readUInt32LE(body + 1)
        image = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
      }
      offset = body + length + (length % 2)
    }
    if (
      !image ||
      offset !== b.length ||
      (canvas && (canvas.width !== image.width || canvas.height !== image.height))
    )
      throw imageError()
    return { ...image, format: 'webp' }
  }
  throw imageError()
}
async function boundedRead(path: string, maxBytes: number): Promise<Buffer> {
  // Reject symlinks, special files and growth during reading. Never use a caller-supplied URL.
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes)
    throw imageError()
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.size !== before.size ||
      info.ino !== before.ino ||
      info.dev !== before.dev
    )
      throw imageError()
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await file.stat()
    if (
      length !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw imageError()
    return buffer.subarray(0, length)
  } finally {
    await file.close()
  }
}
export type NormalizeWallpaper = (input: Buffer) => Buffer
/** One instance per app profile. Assets and preferences are separate from study/export/model data. */
export class WallpaperStore {
  private readonly directory: string
  private readonly settingsPath: string
  private queue: Promise<unknown> = Promise.resolve()
  private selectionRevision = 0
  constructor(
    userData: string,
    private readonly normalize: NormalizeWallpaper,
  ) {
    this.directory = join(userData, 'appearance')
    this.settingsPath = join(this.directory, 'preferences.json')
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async assertDirectory() {
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new WallpaperError('外观存储目录不可用。')
  }
  private async readState(): Promise<StoredAppearance & { warning?: string }> {
    try {
      await this.assertDirectory()
      const raw = JSON.parse(
        (await boundedRead(this.settingsPath, 4096)).toString('utf8'),
      ) as Record<string, unknown>
      const preferences = appearancePreferencesSchema.parse(raw.preferences)
      if (raw.asset !== null && (typeof raw.asset !== 'string' || !assetPattern.test(raw.asset)))
        throw new Error('Invalid asset')
      return { preferences, asset: raw.asset as string | null }
    } catch (error) {
      return {
        preferences: defaultAppearancePreferences(),
        asset: null,
        ...((error as NodeJS.ErrnoException).code === 'ENOENT'
          ? {}
          : {
              warning: '外观设置无法读取，已使用默认外观。可重新设置或恢复默认；学习数据不受影响。',
            }),
      }
    }
  }
  private async snapshot(
    state: StoredAppearance & { warning?: string },
  ): Promise<AppearanceSnapshot> {
    if (!state.asset)
      return {
        preferences: state.preferences,
        wallpaper: null,
        ...(state.warning ? { warning: state.warning } : {}),
      }
    try {
      const bytes = await boundedRead(join(this.directory, state.asset), MAX_WALLPAPER_BYTES)
      const info = inspectWallpaperRaster(bytes)
      if (info.format !== 'png') throw imageError()
      // Validate persisted copies too; tampered/corrupt bytes never become renderer content.
      const clean = this.normalize(bytes)
      const cleanInfo = inspectWallpaperRaster(clean)
      if (cleanInfo.format !== 'png') throw imageError()
      return {
        preferences: state.preferences,
        wallpaper: {
          dataUrl: `data:image/png;base64,${clean.toString('base64')}`,
          width: cleanInfo.width,
          height: cleanInfo.height,
        },
      }
    } catch {
      return {
        preferences: state.preferences,
        wallpaper: null,
        warning: '本地壁纸副本已丢失或损坏，已隐藏壁纸。请重新选择图片；其他外观设置已保留。',
      }
    }
  }
  private async atomicWrite(path: string, bytes: Buffer) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.assertDirectory()
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
  private async writeState(state: StoredAppearance) {
    await this.atomicWrite(this.settingsPath, Buffer.from(JSON.stringify(state)))
  }
  private async removeAsset(asset: string | null): Promise<boolean> {
    if (!asset || !assetPattern.test(asset)) return true
    try {
      await this.assertDirectory()
      await unlink(join(this.directory, asset))
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }
  private async clearOwnedCopies(): Promise<boolean> {
    try {
      await this.assertDirectory()
      const entries = await readdir(this.directory, { withFileTypes: true })
      const results = await Promise.all(
        entries
          .filter((entry) => ownedFilePattern.test(entry.name) && !entry.isDirectory())
          .map(async (entry) => {
            try {
              await unlink(join(this.directory, entry.name))
              return true
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ENOENT'
            }
          }),
      )
      return results.every(Boolean)
    } catch {
      return false
    }
  }
  beginSelection(): number {
    return ++this.selectionRevision
  }
  invalidateSelection(): void {
    this.selectionRevision++
  }
  get(): Promise<AppearanceSnapshot> {
    return this.serial(async () => this.snapshot(await this.readState()))
  }
  save(raw: unknown): Promise<AppearancePreferences> {
    const parsed = appearancePreferencesSchema.safeParse(raw)
    if (!parsed.success)
      return Promise.reject(new WallpaperError('外观设置无效，请检查主题和壁纸参数。'))
    return this.serial(async () => {
      const previous = await this.readState()
      const state = { preferences: parsed.data, asset: previous.asset }
      try {
        await this.writeState(state)
      } catch {
        throw new WallpaperError('无法保存外观设置，请检查本机存储空间后重试。')
      }
      return state.preferences
    })
  }
  /** Only a main-process native chooser may supply selectedPath. Renderer supplies no path. */
  async importSelectedFile(
    selectedPath: string,
    ticket: number,
  ): Promise<{ canceled: boolean; appearance: AppearanceSnapshot }> {
    if (ticket !== this.selectionRevision) return { canceled: true, appearance: await this.get() }
    let clean: Buffer
    try {
      if (
        !isAbsolute(selectedPath) ||
        selectedPath.startsWith('\\\\') ||
        /^[a-z][a-z\d+.-]*:\/\//i.test(selectedPath) ||
        !fileExtensions.has(extname(selectedPath).toLowerCase())
      )
        throw imageError()
      const bytes = await boundedRead(selectedPath, MAX_WALLPAPER_BYTES)
      inspectWallpaperRaster(bytes)
      clean = this.normalize(bytes)
      if (inspectWallpaperRaster(clean).format !== 'png') throw imageError()
    } catch {
      throw imageError()
    }
    return this.serial(async () => {
      if (ticket !== this.selectionRevision)
        return { canceled: true, appearance: await this.snapshot(await this.readState()) }
      const previous = await this.readState()
      const asset = `${randomUUID()}.png`
      try {
        await this.atomicWrite(join(this.directory, asset), clean)
        // Reset/remove/new selection can invalidate a chooser while disk work is in flight.
        if (ticket !== this.selectionRevision) {
          await this.removeAsset(asset)
          return { canceled: true, appearance: await this.snapshot(previous) }
        }
        await this.writeState({ preferences: previous.preferences, asset })
      } catch {
        await this.removeAsset(asset)
        throw new WallpaperError('无法保存本地壁纸，请检查本机存储空间后重试。原壁纸未更改。')
      }
      await this.removeAsset(previous.asset)
      return {
        canceled: false,
        appearance: await this.snapshot({ preferences: previous.preferences, asset }),
      }
    })
  }
  remove(resetAll = false): Promise<AppearanceSnapshot> {
    this.invalidateSelection()
    return this.serial(async () => {
      const previous = await this.readState()
      const state = {
        preferences: resetAll ? defaultAppearancePreferences() : previous.preferences,
        asset: null,
      }
      try {
        await this.writeState(state)
      } catch {
        throw new WallpaperError('无法重置外观，请检查本机存储空间后重试。')
      }
      const cleaned = await this.clearOwnedCopies()
      return this.snapshot({
        ...state,
        ...(cleaned
          ? {}
          : { warning: '壁纸已隐藏，但部分本机副本未能清理。请检查存储权限后重试恢复默认。' }),
      })
    })
  }
}
