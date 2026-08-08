import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Builds straight into server/public, which server.js serves as-is.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/rec': 'http://localhost:8080',
      '/status': 'http://localhost:8080',
    },
  },
})
