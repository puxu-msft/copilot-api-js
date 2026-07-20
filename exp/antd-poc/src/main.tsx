// 风险点 1：antd v6 原生兼容 React 19（v5 才需 @ant-design/v5-patch-for-react-19）。
// 本 PoC 刻意不引补丁，实测 v6 静态 message/Modal 在 React 19 下是否可用。
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import "./styles.css"

const rootEl = document.querySelector("#root")
if (!rootEl) throw new Error("root element not found")

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
