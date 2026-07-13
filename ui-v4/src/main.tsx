import { QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router-dom"

import { router } from "@/App"
import { startDataDesignSync } from "@/lib/data-design"
import { queryClient } from "@/lib/query"
import "@/styles/theme.css"

const rootEl = document.querySelector("#root")
if (!rootEl) throw new Error("root element not found")

// data-design 根属性据 designVersion 常驻同步(默认 amber-legacy)。在 render 前调用,保证首帧即带属性,
// 使 C4 作用域化选择器 `[data-design=amber-legacy]` 与 preset 作用域从第一帧起生效。见 lib/data-design.ts。
startDataDesignSync()

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
