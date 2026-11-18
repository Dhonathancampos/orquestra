import { defineConfig } from 'vite'
export default defineConfig({
  base: './',
  server: { proxy: { '/api': 'http://127.0.0.1:7777', '/ws': { target: 'ws://127.0.0.1:7777', ws: true } } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
})
