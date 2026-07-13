import {
  //
  afterEach,
  describe,
  expect,
  it,
} from "vitest"

import { startDataDesignSync } from "@/lib/data-design"
import { useUiStore } from "@/stores/ui-store"

// C0 守卫(INV-3):data-design 根属性据 store.designVersion 落根,默认 amber-legacy(与 C4 作用域化原子对齐)。
// 落点是模块级 store 订阅(非 AppShell 组件体内),满足 C6「L0 本体零 designVersion 引用」。
// 注:`dataset.design` 即属性 `data-design`(CSS 作用域选择器 `[data-design=...]` 据此匹配)。
describe("data-design root sync", () => {
  afterEach(() => {
    useUiStore.getState().setDesignVersion("amber-legacy")
    delete document.documentElement.dataset.design
  })

  it("writes data-design=amber-legacy on the html root by default", () => {
    const stop = startDataDesignSync()
    expect(document.documentElement.dataset.design).toBe("amber-legacy")
    stop()
  })

  it("reflects setDesignVersion changes onto the root attribute (positive control: attr flips)", () => {
    const stop = startDataDesignSync()
    expect(document.documentElement.dataset.design).toBe("amber-legacy")
    useUiStore.getState().setDesignVersion("shadcn")
    expect(document.documentElement.dataset.design).toBe("shadcn")
    stop()
  })

  it("stops reflecting after unsubscribe", () => {
    const stop = startDataDesignSync()
    stop()
    useUiStore.getState().setDesignVersion("shadcn")
    // 取消订阅后不再更新;属性停在 stop() 时的值。
    expect(document.documentElement.dataset.design).toBe("amber-legacy")
  })
})
