import { create } from "zustand"

/** 设计版本:双树切换的顶层开关。amber-legacy = 现有 Terminal Amber 树;shadcn = 重设计树(C6 起挂载)。 */
export type DesignVersion = "amber-legacy" | "shadcn"
/** 颜色 preset:语义 token 映射的选择器(C1 定义两组映射)。amber = 复现 Terminal Amber;neutral = 中性灰 + 蓝白强调。 */
export type ColorPreset = "amber" | "neutral"

interface UiState {
  designVersion: DesignVersion
  colorPreset: ColorPreset
  wsConnected: boolean
  setDesignVersion: (v: DesignVersion) => void
  setColorPreset: (p: ColorPreset) => void
  setWsConnected: (c: boolean) => void
}

const DESIGN_VERSION_KEY = "copilot-api-v4-design-version"
const COLOR_PRESET_KEY = "copilot-api-v4-color-preset"

function readPersisted<T extends string>(key: string, allowed: ReadonlyArray<T>, fallback: T): T {
  // localStorage 读可能抛(隐私模式 / 禁用),或存了非法值 → 回退默认。内部工具:容错不阻塞。
  try {
    const raw = localStorage.getItem(key)
    return raw !== null && (allowed as ReadonlyArray<string>).includes(raw) ? (raw as T) : fallback
  } catch {
    return fallback
  }
}

function writePersisted(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (err) {
    console.warn(`[ui-store] 持久化失败(${key}):`, err)
  }
}

export const useUiStore = create<UiState>((set) => ({
  designVersion: readPersisted(DESIGN_VERSION_KEY, ["amber-legacy", "shadcn"] as const, "amber-legacy"),
  colorPreset: readPersisted(COLOR_PRESET_KEY, ["amber", "neutral"] as const, "amber"),
  wsConnected: false,
  setDesignVersion: (designVersion) => {
    writePersisted(DESIGN_VERSION_KEY, designVersion)
    set({ designVersion })
  },
  setColorPreset: (colorPreset) => {
    writePersisted(COLOR_PRESET_KEY, colorPreset)
    set({ colorPreset })
  },
  setWsConnected: (wsConnected) => set({ wsConnected }),
}))
