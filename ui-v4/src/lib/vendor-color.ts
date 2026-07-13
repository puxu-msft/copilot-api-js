/**
 * Vendor → chip 颜色（语义对齐 Vue useModelsCatalog.vendorColor：
 * anthropic=purple / openai·azure=blue / google=green / other=pink / none=muted）。
 * C2 中性化：不再返回 baked hex，而是返回**设计中性的 `--vendor-*` 语义 token**
 * （theme.css 的 amber/neutral 两 preset 各自拥有具体色；amber preset 解析回旧
 * amber 品牌 hex，逐值等价由 semantic-tokens 独立 oracle 守卫）。空/未知 vendor 返回
 * `var(--vendor-muted)` 让 chip 融入 muted 语义。匹配大小写无关、按子串。
 */
export function vendorColor(vendor: string | undefined): string {
  if (!vendor) return "var(--vendor-muted)"
  const v = vendor.toLowerCase()
  if (v.includes("anthropic")) return "var(--vendor-anthropic)"
  if (v.includes("openai") || v.includes("azure")) return "var(--vendor-openai)"
  if (v.includes("google")) return "var(--vendor-google)"
  return "var(--vendor-other)"
}
