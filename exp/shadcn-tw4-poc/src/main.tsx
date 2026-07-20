import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import "./index.css"

// PoC 验证:shadcn Button/Dialog/Tabs(统一 radix-ui 底座)在 React 19 + Tailwind v4 下编译 + 渲染。
// 同时对照全局 *{border-radius:0!important}:Button 的 rounded-md 预期被压平(F6),证明需作用域化。
function App() {
  return (
    <div className="p-6">
      <div className="mb-4 flex gap-2">
        <Button>Primary</Button>
        <Button variant="outline">Outline</Button>
        {/* 作用域化验证:此容器标记 data-design=shadcn,配套 CSS 只在 amber-legacy 作用域施加锐角。 */}
        <span data-design="shadcn" className="rounded-md border px-3 py-1">radius test</span>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="secondary">Open Dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>shadcn Dialog</DialogTitle>
          </DialogHeader>
          <p>unified radix-ui Dialog under React 19 + Tailwind v4</p>
        </DialogContent>
      </Dialog>
      <Tabs defaultValue="a" className="mt-4">
        <TabsList>
          <TabsTrigger value="a">Convo</TabsTrigger>
          <TabsTrigger value="b">SSE</TabsTrigger>
        </TabsList>
        <TabsContent value="a">tab A（水平 tabs，对应决策 10）</TabsContent>
        <TabsContent value="b">tab B</TabsContent>
      </Tabs>
    </div>
  )
}

const el = document.querySelector("#root")
if (!el) throw new Error("no root")
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
