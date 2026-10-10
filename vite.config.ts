import { randomBytes } from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(24).toString('base64') : undefined
  return {
    plugins: [
      react(),
      {
        name: 'examcraft-dev-csp',
        apply: 'serve',
        transformIndexHtml: {
          order: 'pre',
          // Permit Vite's React Refresh preamble only during this local dev session.
          handler: (html) =>
            html.replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`),
        },
      },
    ],
    html: nonce ? { cspNonce: nonce } : undefined,
    base: './',
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
  }
})
