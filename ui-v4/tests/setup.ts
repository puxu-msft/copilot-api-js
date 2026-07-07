// jsdom(29)不实现 scrollIntoView,直接调用会 throw;全局 stub 供依赖它的组件/hook 测试。
// 测试可用 `vi.spyOn(Element.prototype, "scrollIntoView")` 覆盖以断言调用。
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

// Radix Primitives(Dialog/DropdownMenu/Select 等)在 jsdom 下依赖若干未实现的 DOM API:
// - ResizeObserver:Popper(DropdownMenu/Select 定位)必需,jsdom 不实现。
// - Pointer capture(has/set/releasePointerCapture):Radix 指针交互调用,jsdom 不实现。
// 缺任一 → Radix 组件在测试里开箱即 throw。全局 stub 之(同 scrollIntoView 的 guard 模式)。
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}
if (typeof Element.prototype.hasPointerCapture !== "function") {
  Element.prototype.hasPointerCapture = function hasPointerCapture() {
    return false
  }
}
if (typeof Element.prototype.setPointerCapture !== "function") {
  Element.prototype.setPointerCapture = function setPointerCapture() {}
}
if (typeof Element.prototype.releasePointerCapture !== "function") {
  Element.prototype.releasePointerCapture = function releasePointerCapture() {}
}
