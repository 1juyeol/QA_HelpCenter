import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000'
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('chart.js')) return 'vendor-chart'
          if (id.includes('react')) return 'vendor-react'
        },
      },
    },
  },
  test: {
    environment: 'node',
  },
})
