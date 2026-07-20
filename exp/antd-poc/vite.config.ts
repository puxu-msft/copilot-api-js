import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// 复刻 ui-v4 的构建环境（React 19 + Tailwind v4 + Vite 7），保证 PoC 结论可迁移。
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
})
