import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { resolve } from 'path'

export default defineConfig(({ command }) => ({
  root: __dirname,
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
  ],
  optimizeDeps: {
    include: ["vue-json-pretty", "diff", "diff2html"],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '~backend': resolve(__dirname, '../../src'),
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
          vue: ['vue', 'vue-router'],
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
      '/ws': {
        target: 'ws://localhost:4141',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:4141',
        changeOrigin: true,
      },
      '/models': {
        target: 'http://localhost:4141',
        changeOrigin: true,
      },
    },
  },
}))
