import { useUiStore } from "@/stores/ui-store"

/**
 * 把 `store.designVersion` 反射到 `document.documentElement` 的 `data-design` 属性。
 *
 * 落点决策(C0):这是一个模块级 store 订阅,不是 AppShell 组件体内的读取——满足 C6 的
 * INV-FIDELITY-1「L0 本体源码零 designVersion 引用」。它只写 DOM 属性、不渲染任何分支,
 * 故不违反「AppShell 组件体零 designVersion」。C4 的作用域化选择器(`[data-design=amber-legacy]`)
 * 与 preset 作用域都挂在这个根属性上,因此从应用启动即需常驻同步。
 *
 * 返回 unsubscribe 供测试清理;生产在 main.tsx render 前调用一次、无需取消。
 */
export function startDataDesignSync(): () => void {
  const apply = (v: string): void => {
    // dataset.design ↔ 属性 `data-design`;CSS 作用域选择器 `[data-design=amber-legacy]`(C4)据此匹配。
    document.documentElement.dataset.design = v
  }
  apply(useUiStore.getState().designVersion)
  return useUiStore.subscribe((state, prev) => {
    if (state.designVersion !== prev.designVersion) apply(state.designVersion)
  })
}
