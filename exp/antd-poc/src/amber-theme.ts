import { theme, type ThemeConfig } from "antd"

// PoC 风险点 4：把 ui-v4 现有的 Terminal Amber token（src/styles/theme.css 的 --color-*）
// 映射成 antd v5 的 ThemeConfig。证明"保留 Amber 为可切换主题"在 antd ConfigProvider
// 下是一等公民——一个 theme switcher 在两套 algorithm/token 间切，无需两套组件。

const IBM_PLEX_MONO = `"IBM Plex Mono", ui-monospace, monospace`

/** 企业蓝白（antd 默认观感）——用户选定的默认皮肤。 */
export const enterpriseBlueTheme: ThemeConfig = {
  token: {
    colorPrimary: "#1677ff",
    borderRadius: 6,
  },
}

/** Terminal Amber 工业风——复现锐角 + 暖近黑 + 琥珀 + 等宽字体。 */
export const terminalAmberTheme: ThemeConfig = {
  // darkAlgorithm 提供暗色派生；再用 token 覆盖成 Amber 调色板。
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#d4a04a",
    colorBgBase: "#141210",
    colorBgContainer: "#16161a",
    colorBorder: "#2a2a32",
    colorText: "#d8cdbb",
    colorTextSecondary: "#8a7a55",
    colorSuccess: "#7fd99a",
    colorWarning: "#d4a04a",
    colorError: "#e08a8a",
    borderRadius: 0, // 全局锐角——对应旧主题的 `border-radius: 0 !important`
    fontFamily: IBM_PLEX_MONO,
  },
}

export type PocThemeName = "blue" | "amber"

export const themeByName: Record<PocThemeName, ThemeConfig> = {
  blue: enterpriseBlueTheme,
  amber: terminalAmberTheme,
}
