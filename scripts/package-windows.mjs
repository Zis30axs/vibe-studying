import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDependencyNotices } from './dependency-notices.mjs'

// Manual packaging using Electron's official prebuilt runtime. No third-party packager.
// https://www.electronjs.org/docs/latest/tutorial/application-distribution
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build this Windows x64 distribution on Windows x64 (or use GitHub Actions).')
const require = createRequire(import.meta.url)
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || lock.version !== pkg.version)
  throw new Error('Release requires matching, stable package and lockfile versions.')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
if (git('status', '--porcelain', '--untracked-files=normal'))
  throw new Error('Package from a clean, committed checkout so source and binaries match.')
const commit = git('rev-parse', 'HEAD')
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)
  throw new Error('Checkout does not match the commit being verified.')
const electronRoot = dirname(require.resolve('electron/package.json'))
const runtime = join(electronRoot, 'dist')
const runtimeVersion = (await readFile(join(runtime, 'version'), 'utf8')).trim()
if (runtimeVersion.replace(/^v/, '') !== pkg.devDependencies.electron)
  throw new Error('Installed Electron runtime differs from the locked release dependency.')
for (const path of [
  'dist/index.html',
  'dist-electron/main.cjs',
  'dist-electron/preload.cjs',
  'dist-electron/knowledge-pdf-worker.cjs',
  'dist-electron/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'dist-electron/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  'dist-mcp/server.cjs',
]) {
  if (!(await stat(path)).isFile()) throw new Error(`Build output missing: ${path}`)
}
await stat(join(runtime, 'electron.exe'))

const artifact = `ExamCraft-${pkg.version}-win-x64`
const output = resolve('work/release')
const stage = resolve('work/package-windows', artifact)
// Only these fixed generated directories are cleaned; never the user's app profile.
await rm(resolve('work/package-windows'), { recursive: true, force: true })
await rm(output, { recursive: true, force: true })
await mkdir(dirname(stage), { recursive: true })
await mkdir(output, { recursive: true })
await cp(runtime, stage, { recursive: true })
await rename(join(stage, 'electron.exe'), join(stage, 'ExamCraft.exe'))
await rename(join(stage, 'LICENSE'), join(stage, 'LICENSE.electron.txt'))
await rm(join(stage, 'resources/default_app.asar'), { force: true })
const app = join(stage, 'resources/app')
await mkdir(app, { recursive: true })
for (const path of ['dist', 'dist-electron', 'dist-mcp', 'examples'])
  await cp(path, join(app, path), { recursive: true })
await cp('LICENSE', join(app, 'LICENSE'))
await cp('LICENSE', join(stage, 'LICENSE.ExamCraft.txt'))
await writeFile(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      type: pkg.type,
      main: pkg.main,
    },
    null,
    2,
  ) + '\n',
)

// esbuild bundles dependencies, but their copyright/license notices must still ship.
const notices = [
  'ExamCraft bundled npm dependency notices',
  'The Electron runtime notices are in LICENSE.electron.txt and LICENSES.chromium.html.',
  ...(await collectDependencyNotices(root, lock.packages)),
]
await writeFile(join(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n'))
const sourceName = `ExamCraft-${pkg.version}-source.zip`
await writeFile(
  join(stage, 'README.txt'),
  [
    `ExamCraft ${pkg.version} - Windows x64 portable application`,
    '',
    'Extract this entire directory, then open ExamCraft.exe. Node.js is not required.',
    'Keep the resources directory and every runtime file beside the executable.',
    'This build is unsigned; Windows may show an unknown-publisher/SmartScreen warning.',
    'Only run downloads you trust. No installer, automatic updater, or code-signing identity is included.',
    `Windows EXE Properties and the icon retain Electron runtime metadata; the app version is ${pkg.version}.`,
    '',
    'Portable means no installation is needed. Learning data is stored separately in',
    '%APPDATA%/ExamCraft, not beside the executable. Exit the app before backing up that folder.',
    'Back up existing study data before upgrading. New answer fields may not work in older versions.',
    '',
    `Project source and build instructions: ${sourceName} on the same GitHub release.`,
    `https://github.com/Zis30axs/vibe-studying/tree/${commit}`,
    'License: GPL-3.0-only; see LICENSE.ExamCraft.txt. Dependency notices are included.',
    '',
    'Local feedback is a learning aid, not an official exam grade.',
    'DeepSeek is optional and requires your own safe credential setup and consent per request.',
    'No real DeepSeek request or credential is used in release tests.',
    '',
  ].join('\r\n'),
)
const buildInfo = {
  version: pkg.version,
  commit,
  platform: 'win32',
  arch: 'x64',
  electron: runtimeVersion,
}
await writeFile(join(stage, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n')

const zip = join(output, `${artifact}.zip`)
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:EXAMCRAFT_ZIP_SOURCE, $env:EXAMCRAFT_ZIP_TARGET, [System.IO.Compression.CompressionLevel]::Optimal, $true)',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, EXAMCRAFT_ZIP_SOURCE: stage, EXAMCRAFT_ZIP_TARGET: zip },
  },
)
// This is a companion source asset, never substituted for the runnable Windows ZIP.
git(
  'archive',
  '--format=zip',
  `--prefix=ExamCraft-${pkg.version}-source/`,
  `--output=${join(output, sourceName)}`,
  'HEAD',
)
const sums = []
for (const name of [`${artifact}.zip`, sourceName]) {
  const hash = createHash('sha256')
    .update(await readFile(join(output, name)))
    .digest('hex')
  sums.push(`${hash}  ${name}`)
}
await writeFile(join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
console.log(`Created ${zip}\nCommit: ${commit}\nRun npm run test:packaged before distributing.`)
