import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Node 26 defines `globalThis.localStorage`, and the jsdom environment leaves an existing global
    // alone — so jsdom's own never installs and every persisted-store test fails. Detected rather
    // than version-gated: the flag is fatal on Node 24, which does not define the property at all.
    execArgv: 'localStorage' in globalThis ? ['--no-webstorage'] : [],
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://backend:8000',
        changeOrigin: true,
      },
    },
  },
})
