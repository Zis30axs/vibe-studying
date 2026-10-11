import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectDependencyNotices, type LockedPackage } from '../scripts/dependency-notices.mjs'

const version = '1.0.11'
const parentPath = 'node_modules/@napi-rs/canvas'
const nativeName = '@napi-rs/canvas-win32-x64-msvc'
const nativePath = `node_modules/${nativeName}`
const repository = { type: 'git', url: 'git+https://github.com/Brooooooklyn/canvas.git' }
let root: string
let packages: Record<string, LockedPackage>

async function packageFile(path: string, name: string, content: string) {
  await mkdir(join(root, path), { recursive: true })
  await writeFile(join(root, path, name), content)
}

async function updatePackage(path: string, change: Record<string, unknown>) {
  const pkg = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'))
  await packageFile(path, 'package.json', JSON.stringify({ ...pkg, ...change }))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'examcraft-notices-'))
  packages = {
    [parentPath]: { version, optional: true, optionalDependencies: { [nativeName]: version } },
    [nativePath]: { version, optional: true },
  }
  await packageFile(
    parentPath,
    'package.json',
    JSON.stringify({
      name: '@napi-rs/canvas',
      version,
      license: 'MIT',
      repository,
      optionalDependencies: { [nativeName]: version },
    }),
  )
  await packageFile(parentPath, 'LICENSE', 'MIT License\nCopyright upstream canvas authors')
  await packageFile(
    nativePath,
    'package.json',
    JSON.stringify({ name: nativeName, version, license: 'MIT', repository }),
  )
  await packageFile(nativePath, 'README.md', 'This is the Windows binary for `@napi-rs/canvas`')
  await packageFile(
    nativePath,
    'sbom.cdx.json',
    JSON.stringify({
      bomFormat: 'CycloneDX',
      metadata: { component: { name: nativeName, version } },
      components: [{ name: 'native-library', licenses: [{ expression: 'MIT OR Apache-2.0' }] }],
    }),
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('release dependency notices', () => {
  it('attributes the parent license honestly and preserves the native README and full SBOM', async () => {
    const notices = (await collectDependencyNotices(root, packages)).join('\n')
    expect(notices).toContain(`${nativeName}@${version}`)
    expect(notices).toContain('does not contain a separate license file')
    expect(notices).toContain(`Source: ${parentPath}/LICENSE\nMIT License`)
    expect(notices).toContain(`Source: ${nativePath}/README.md`)
    expect(notices).toContain(`Source: ${nativePath}/sbom.cdx.json`)
    expect(notices).toContain('native-library')
    expect(notices).toContain('MIT OR Apache-2.0')
    expect(notices).not.toContain(`Source: ${nativePath}/LICENSE`)
  })

  it('prefers the native package own license when one is supplied', async () => {
    await packageFile(nativePath, 'LICENSE', 'Native license and copyright')
    const notices = (await collectDependencyNotices(root, packages)).join('\n')
    expect(notices).toContain('Native license and copyright')
    expect(notices).not.toContain('does not contain a separate license file')
  })

  it.each([
    ['different parent version', { version: '1.0.10' }],
    ['missing parent pin', { optionalDependencies: {} }],
    ['range instead of exact pin', { optionalDependencies: { [nativeName]: '^1.0.11' } }],
    ['different parent license', { license: 'Apache-2.0' }],
    ['different parent repository', { repository: { url: 'https://example.invalid/canvas' } }],
  ])('rejects %s', async (_label, change) => {
    await updatePackage(parentPath, change)
    await expect(collectDependencyNotices(root, packages)).rejects.toThrow()
  })

  it.each([
    ['different native license', { license: 'Apache-2.0' }],
    ['missing native license declaration', { license: null }],
    ['different native repository', { repository: { url: 'https://example.invalid/canvas' } }],
    ['unrelated package', { name: '@another/native' }],
  ])('rejects %s', async (_label, change) => {
    await updatePackage(nativePath, change)
    await expect(collectDependencyNotices(root, packages)).rejects.toThrow(
      'Missing dependency license notice',
    )
  })

  it('requires the parent exact pin in the lockfile as well as its manifest', async () => {
    packages[parentPath].optionalDependencies = {}
    await expect(collectDependencyNotices(root, packages)).rejects.toThrow(
      'Missing dependency license notice',
    )
  })

  it('rejects installed dependency versions that differ from the lockfile', async () => {
    packages[nativePath].version = '1.0.10'
    await expect(collectDependencyNotices(root, packages)).rejects.toThrow(
      'Dependency differs from lockfile',
    )
  })

  it.each(['LICENSE', 'README.md', 'sbom.cdx.json'])(
    'requires fallback evidence %s',
    async (name) => {
      await rm(join(root, name === 'LICENSE' ? parentPath : nativePath, name))
      await expect(collectDependencyNotices(root, packages)).rejects.toThrow()
    },
  )

  it('rejects a native SBOM belonging to another package', async () => {
    await packageFile(
      nativePath,
      'sbom.cdx.json',
      JSON.stringify({
        bomFormat: 'CycloneDX',
        metadata: { component: { name: 'other', version } },
      }),
    )
    await expect(collectDependencyNotices(root, packages)).rejects.toThrow(
      'Invalid canvas native notice evidence',
    )
  })

  it('skips only missing optional dependencies, never missing required dependencies', async () => {
    await rm(join(root, nativePath), { recursive: true })
    const notices = (await collectDependencyNotices(root, packages)).join('\n')
    expect(notices).not.toContain(nativeName)
    packages[nativePath].optional = false
    await expect(collectDependencyNotices(root, packages)).rejects.toThrow()
  })

  it('does not count a directory named LICENSE as a dependency notice', async () => {
    await updatePackage(nativePath, { name: 'ordinary-package' })
    await mkdir(join(root, nativePath, 'LICENSE'))
    await expect(collectDependencyNotices(root, packages)).rejects.toThrow(
      'Missing dependency license notice',
    )
  })

  it('collects notices for the actual installed production dependency tree', async () => {
    const project = resolve(import.meta.dirname, '..')
    const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8'))
    const notices = (await collectDependencyNotices(project, lock.packages)).join('\n')
    expect(notices).toContain('react@')
    expect(notices).toContain('pdfjs-dist@')
  })
})
