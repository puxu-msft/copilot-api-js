# 04 — Vite 配置迁移

## 当前 `ui/history-v3/vite.config.ts`

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { resolve } from 'path'

export default defineConfig(({ command }) => ({
  plugins: [vue(), vuetify({ autoImport: true })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '~backend': resolve(__dirname, '../../src'),
    },
  },
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
    proxy: { /* ... */ },
  },
}))
```

## 必须改动：显式设置 `root: __dirname`

### 问题

Vite 的 `root` 默认是 `process.cwd()`，**不是** config 文件所在目录。
`--config` 参数只影响配置文件查找路径，不改变 root。

从根目录运行 `vite build --config ui/history-v3/vite.config.ts` 时，
Vite 会在根目录查找 `index.html`，导致：

```
Cannot resolve entry module "index.html".
```

**已验证**：此报错在实际运行中复现。

### 修改

在 `vite.config.ts` 顶部加 `root: __dirname`：

```ts
export default defineConfig(({ command }) => ({
  root: __dirname,
  plugins: [vue(), vuetify({ autoImport: true })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '~backend': resolve(__dirname, '../../src'),
    },
  },
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
    proxy: { /* ... */ },
  },
}))
```

加上 `root: __dirname` 后：
- `index.html` 正确解析到 `ui/history-v3/index.html` ✓
- `build.outDir: 'dist'` 相对于 root，输出到 `ui/history-v3/dist/` ✓
- `resolve` alias 本身已使用 `__dirname` 绝对路径，不受 root 影响 ✓

## 无需改动的部分

- `vite.config.ts` **保持在 `ui/history-v3/` 目录**
- `__dirname` 仍然解析到 `ui/history-v3/`
- `resolve(__dirname, 'src')` → `ui/history-v3/src/` ✓
- `resolve(__dirname, '../../src')` → `src/`（后端）✓

### 依赖解析

Vite 从 `root`（设置为 `__dirname` 即 `ui/history-v3/`）开始解析依赖。
合并后 `ui/history-v3/node_modules` 不再存在，Vite 会沿 Node.js 模块解析链向上查找到根 `node_modules`。
这是标准行为，无需配置。

## 结论

Vite 配置文件保留原位，别名定义不变。唯一的必要改动是加 `root: __dirname`。
