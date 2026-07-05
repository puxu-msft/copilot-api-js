---
name: debugging-frontend-tests
description: 当调 copilot-api-js ui-v4 前端测试（tests/*.vitest.test.tsx，jsdom + @testing-library/react）遇诡异失败时使用——createPortal 内容落 document.body 不在 container、jsdom 不实现 execCommand/scrollIntoView 须 stub、shiki 异步高亮把首帧 plaintext 重渲成多 span、否定断言不自证正向能力。前端 vitest/jsdom 专有坑，区别于后端单例隔离（skill test-isolation）。
---

# ui-v4 前端测试调试（vitest / jsdom）

ui-v4 前端测试跑在 jsdom + @testing-library/react 下。jsdom 不是真浏览器，一批 API 未实现 / 行为与真浏览器不同，导致「组件明明对、测试却假失败」。后端单例隔离另见 skill `test-isolation`（偏 bun runtime）。

## createPortal 内容落 `document.body`，不在 `render()` 的 `container`

`createPortal` 渲染的内容落到 `document.body`，**不在** `render()` 返回的 `container` 里。断言 modal/portal 内容用 `screen.*` 或 `document.body.textContent`，**绝不用** `container.textContent`（会漏掉 portaled 内容 → 正向断言假失败）。`Modal` 组件 portal 到 body，故 `BlockJsonModal`/`ContentRenderer` 开 modal 的正向 JSON body 断言必须走 `document.body.textContent.toContain(...)`。

## jsdom 不实现 `execCommand`

`vi.spyOn(document, "execCommand")` 抛 `The property "execCommand" is not defined on the object`。改用 `Object.defineProperty(document, "execCommand", { value: vi.fn().mockReturnValue(true), configurable: true })`，并在 `afterEach` 用 `Reflect.deleteProperty(document, "execCommand")` 清理保持隔离。测 `lib/clipboard.ts` 的 execCommand 兜底路径时踩到。

## jsdom(29) 不实现 `scrollIntoView`

直接调 `Element.prototype.scrollIntoView` 抛 `TypeError`。任何组件/hook 用它（`useAnchorScroll` 的 TOC 跳转、`HistoryList` 的 `?at=` 定位滚动）都需全局 stub：`tests/setup.ts` 里 `if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = function () {}`，经 `vitest.config.ts` 的 `setupFiles: ["./tests/setup.ts"]` 接入。要断言「滚到了正确的行」用 `vi.spyOn(Element.prototype, "scrollIntoView")`（setup 已设为可 spy 的函数）+ 查目标 `data-entry-id` 行拿高亮类，别断言真实像素滚动。

## shiki 高亮是异步的

`CodeBlock` → `useHighlightedLines`：**首帧 plaintext**（每行一个 span 含整行文本），随后异步重渲染把 token 拆成多个带 `style="color"` 的 span。想正向断言「某段 JSON/代码文本出现」，用 `container/document.body.textContent.toContain(子串)`（textContent 拼接所有 span、抗 token 拆分），**别用** `getByText(整行)`（高亮后失败）。gutter 行号（`getByText("1")`）在两态都在、可同步断言。参见 `tests/CodeBlock.vitest.test.tsx` 既有的 `hasColoredToken` + `waitFor` 手法。

## 否定断言不自证正向能力

`queryByText(/keys/)` 为 null 证「非 tree 视图」——但否定断言不自证正向能力（空≠功能对），须补正向断言（见 skill `empirical-verification`、[[feedback-pass-null-clean-not-self-validating]]）。
