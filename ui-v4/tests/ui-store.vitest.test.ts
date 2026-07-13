import {
  //
  describe,
  expect,
  it,
} from "vitest"

import { useUiStore } from "@/stores/ui-store"

// C0 守卫:ui-store 从「僵尸 theme 三件套」迁到 designVersion/colorPreset 双树切换地基。
// 断言默认值 + 僵尸字段已删。defaults 断言在任何 mutation 之前跑(声明顺序即执行顺序)。
describe("useUiStore design/color state", () => {
  it("defaults designVersion to amber-legacy and colorPreset to amber", () => {
    const s = useUiStore.getState()
    expect(s.designVersion).toBe("amber-legacy")
    expect(s.colorPreset).toBe("amber")
  })

  it("no longer exposes the zombie theme / setTheme state", () => {
    const s = useUiStore.getState() as unknown as Record<string, unknown>
    expect(s.theme).toBeUndefined()
    expect(s.setTheme).toBeUndefined()
  })

  it("setDesignVersion / setColorPreset mutate their fields", () => {
    useUiStore.getState().setDesignVersion("shadcn")
    expect(useUiStore.getState().designVersion).toBe("shadcn")
    useUiStore.getState().setColorPreset("neutral")
    expect(useUiStore.getState().colorPreset).toBe("neutral")
    // 复位,避免污染同文件后续 / localStorage 残留。
    useUiStore.getState().setDesignVersion("amber-legacy")
    useUiStore.getState().setColorPreset("amber")
  })

  it("keeps wsConnected state intact", () => {
    useUiStore.getState().setWsConnected(true)
    expect(useUiStore.getState().wsConnected).toBe(true)
    useUiStore.getState().setWsConnected(false)
  })
})
