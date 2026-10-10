import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'
await import('./build.mjs')
const server = await createServer()
await server.listen()
const env = { ...process.env, EXAMCRAFT_DEV_URL: 'http://127.0.0.1:5173' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.'], { env, stdio: 'inherit', windowsHide: true })
let closing = false
async function close(code = 0) {
  if (closing) return
  closing = true
  child.kill()
  await server.close()
  process.exit(code)
}
child.on('exit', (code) => void close(code ?? 0))
child.on('error', (error) => {
  console.error(error)
  void close(1)
})
process.on('SIGINT', () => void close())
process.on('SIGTERM', () => void close())
console.log(
  'ExamCraft development desktop started. Renderer hot reload is enabled; restart for main/preload changes.',
)
