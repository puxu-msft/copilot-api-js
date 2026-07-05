// jsdom(29)不实现 scrollIntoView,直接调用会 throw;全局 stub 供依赖它的组件/hook 测试。
// 测试可用 `vi.spyOn(Element.prototype, "scrollIntoView")` 覆盖以断言调用。
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}
