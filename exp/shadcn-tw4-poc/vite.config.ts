import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import { defineConfig } from "vite"

// 忠实复刻 ui-v4:Tailwind v4 经 @tailwindcss/vite 插件(无 tailwind.config)、@ 别名。
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
})
