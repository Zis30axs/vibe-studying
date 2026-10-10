import { spawn } from 'node:child_process'
import electron from 'electron'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.EXAMCRAFT_DEV_URL
const child = spawn(electron, ['.'], { env, stdio: 'inherit', windowsHide: true })
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 0
})
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())
