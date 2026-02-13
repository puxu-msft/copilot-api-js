import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // In dev mode, serve from root for convenience; in build, use /history/v3/ prefix
  base: command === 'serve' ? '/' : '/history/v3/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vue: ['vue'],
          vendor: ['vue-json-pretty', 'diff', 'diff2html'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/history/api': {
        target: 'http://localhost:4141',
        changeOrigin: true,
      },
      '/history/ws': {
        target: 'ws://localhost:4141',
        ws: true,
      },
    },
  },
}))
