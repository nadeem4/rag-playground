/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': here('./src'),
      // Geist is self-hosted from the npm package: no font CDN, ever.
      '@fonts': here('./node_modules/geist/dist/fonts'),
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
  test: {
    environment: 'jsdom',
    // tokens.test.ts reads tokens.css?raw; without this Vitest stubs CSS to ''.
    css: { include: [/tokens.css/] },
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
