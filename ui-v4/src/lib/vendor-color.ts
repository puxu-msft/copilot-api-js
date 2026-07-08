/**
 * Vendor → chip 颜色（语义对齐 Vue useModelsCatalog.vendorColor：
 * anthropic=purple / openai·azure=blue / google=green / other=pink / none=muted）。
 * Vue 用 Vuetify 色名，这里落地为 Terminal Amber 兼容的 hex；空/未知 vendor
 * 返回 `var(--color-muted)` 让 chip 融入 muted 语义。匹配大小写无关、按子串。
 */
export function vendorColor(vendor: string | undefined): string {
  if (!vendor) return "var(--color-muted)"
  const v = vendor.toLowerCase()
  if (v.includes("anthropic")) return "#b48ead"
  if (v.includes("openai") || v.includes("azure")) return "#5aa2d0"
  if (v.includes("google")) return "#8fbf7f"
  return "#d08fb4"
}
