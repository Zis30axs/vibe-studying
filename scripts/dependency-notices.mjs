import { readFile, readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'

const canvasRepository = 'git+https://github.com/Brooooooklyn/canvas.git'

async function canvasNativeNotices(root, path, installed, packages) {
  // The published canvas platform packages omit LICENSE. Only accept the
  // same-version upstream parent that explicitly pins this exact binary package.
  if (!/^@napi-rs\/canvas-[a-z0-9-]+$/.test(installed.name)) return []
  const parentPath = posix.join(posix.dirname(path), 'canvas')
  const parentEntry = packages[parentPath]
  if (!parentEntry || parentEntry.dev) return []
  const parent = JSON.parse(await readFile(join(root, parentPath, 'package.json'), 'utf8'))
  if (
    parent.name !== '@napi-rs/canvas' ||
    parent.version !== installed.version ||
    parentEntry.version !== parent.version ||
    parent.optionalDependencies?.[installed.name] !== installed.version ||
    parentEntry.optionalDependencies?.[installed.name] !== installed.version ||
    parent.license !== 'MIT' ||
    installed.license !== parent.license ||
    parent.repository?.url !== canvasRepository ||
    installed.repository?.url !== parent.repository.url
  )
    return []

  const license = await readFile(join(root, parentPath, 'LICENSE'), 'utf8')
  const readme = await readFile(join(root, path, 'README.md'), 'utf8')
  const sbomText = await readFile(join(root, path, 'sbom.cdx.json'), 'utf8')
  const sbom = JSON.parse(sbomText)
  if (
    !license.trim() ||
    !readme.includes('binary for `@napi-rs/canvas`') ||
    sbom.bomFormat !== 'CycloneDX' ||
    sbom.metadata?.component?.name !== installed.name ||
    sbom.metadata?.component?.version !== installed.version
  )
    throw new Error(`Invalid canvas native notice evidence: ${path}`)
  return [
    `This native package does not contain a separate license file. Its package metadata declares MIT; the matching ${parent.name}@${parent.version} parent supplies the upstream license below.`,
    `Source: ${parentPath}/LICENSE\n${license}`,
    `Source: ${path}/README.md\n${readme}`,
    `Source: ${path}/sbom.cdx.json (upstream native component inventory and license declarations)\n${sbomText}`,
  ]
}

export async function collectDependencyNotices(root, packages) {
  const notices = []
  for (const [path, entry] of Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path || entry.dev) continue
    let installed
    try {
      installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'))
    } catch (error) {
      // npm records native bindings for every OS in the lock; only absent
      // optional dependencies can be skipped. Installed ones still need notices.
      if (entry.optional && error.code === 'ENOENT') continue
      throw error
    }
    if (installed.version !== entry.version)
      throw new Error(`Dependency differs from lockfile: ${path}`)
    notices.push(
      `\n${installed.name}@${installed.version}\nLicense: ${JSON.stringify(installed.license ?? entry.license ?? 'See package source')}`,
    )
    const packageNotices = []
    for (const name of (await readdir(join(root, path))).sort()) {
      if (
        /^(licen[cs]e|copying|notice)(\.|$)/i.test(name) &&
        (await stat(join(root, path, name))).isFile()
      )
        packageNotices.push(await readFile(join(root, path, name), 'utf8'))
    }
    if (!packageNotices.length)
      packageNotices.push(...(await canvasNativeNotices(root, path, installed, packages)))
    if (!packageNotices.length) throw new Error(`Missing dependency license notice: ${path}`)
    notices.push(...packageNotices)
  }
  return notices
}
