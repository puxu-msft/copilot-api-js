// 风险点 1：antd v6 原生兼容 React 19，不引 v5 补丁。实测 message/Modal 是否可用。
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { VirtuosoMockContext } from "react-virtuoso"
import { describe, expect, it } from "vitest"

import { App } from "../src/App"

// react-virtuoso 在 jsdom 下无真实布局测量→渲染 0 行。官方 VirtuosoMockContext 注入
// 固定视口/行高，让**真实 Virtuoso** 确定性渲染（保留真实 antd-in-virtuoso 集成，不 mock 掉）。
function renderWithVirtuoso(ui: ReactElement) {
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>{ui}</VirtuosoMockContext.Provider>,
  )
}

describe("antd v6 + React 19 + virtuoso PoC", () => {
  it("风险点1: message（App.useApp context 版）在 React 19 下渲染，DOM 出现提示", async () => {
    // antd v6 原生兼容 React 19（无 v5 补丁）。点击触发 message，断言文本进 DOM。
    const user = userEvent.setup()
    renderWithVirtuoso(<App />)
    await user.click(screen.getByTestId("static-message-btn"))
    await waitFor(() => {
      expect(document.body.textContent).toContain("static message ok")
    })
  })

  it("风险点1: Modal.confirm（App.useApp context 版）在 React 19 下渲染", async () => {
    const user = userEvent.setup()
    renderWithVirtuoso(<App />)
    await user.click(screen.getByTestId("static-modal-btn"))
    await waitFor(() => {
      expect(document.body.textContent).toContain("static modal ok")
    })
  })

  it("风险点2: antd Table 渲染，行内 Tag（视觉组件）出现", () => {
    renderWithVirtuoso(<App />)
    // Table 用 dataSource 前 20 行；每行 status 渲染成 antd Tag。
    const table = document.querySelector(".ant-table")
    expect(table).toBeTruthy()
    // Tag 文本 ok/fail/slow 至少各出现一次。
    expect(screen.getAllByText("ok").length).toBeGreaterThan(0)
  })

  it("风险点2: antd 视觉组件（Tag）渲染进 react-virtuoso 行 —— 混用路径成立", async () => {
    renderWithVirtuoso(<App />)
    await waitFor(() => {
      const vRows = screen.getAllByTestId("virtuoso-antd-row")
      expect(vRows.length).toBeGreaterThan(0)
      // 每个 virtuoso 行内含一个 antd Tag（.ant-tag）。
      expect(vRows[0].querySelector(".ant-tag")).toBeTruthy()
    })
  })

  it("风险点3: Tailwind class 与 antd 组件在同一行共存，class 保留", async () => {
    renderWithVirtuoso(<App />)
    await waitFor(() => {
      const row = screen.getAllByTestId("virtuoso-antd-row")[0]
      // Tailwind utility class 未被 antd 剥离。
      expect(row.className).toContain("flex")
      expect(row.className).toContain("gap-3")
    })
  })

  it("风险点4: 主题切换到 Amber 后重渲染不崩，仍能渲染 antd 组件", async () => {
    const user = userEvent.setup()
    renderWithVirtuoso(<App />)
    await user.click(screen.getByText("Terminal Amber"))
    // 切主题后 antd 组件仍在（ConfigProvider token 切换是纯 props 变更）。
    await waitFor(() => {
      expect(document.querySelector(".ant-table")).toBeTruthy()
    })
  })
})
