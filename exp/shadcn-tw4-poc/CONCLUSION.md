# PoC 结论:shadcn/ui × Tailwind v4 × 统一 radix-ui 地基可行性

- **日期**：2026-07-10
- **目的**：证伪/证实 shadcn 迁移 RFC 对抗 review 的 **FAIL-1（地基风险）**——shadcn CLI 在本项目地基（Tailwind v4 无 config + React 19 + 统一 `radix-ui` 包 + 全局锐角 `!important`）下能否落地。
- **方法**：忠实复刻 ui-v4 地基（`@tailwindcss/vite` v4、无 `tailwind.config`、`@theme` 在 CSS、`radix-ui@^1.6.1` 统一包、`*{border-radius:0!important}`），跑真实 `shadcn@4.13.0` CLI（`init -b radix -t vite -p nova` + `add dialog tabs`），typecheck + build。**无 dev server**（符合 no-auto-server）。

## 结论:地基可行,F1 从 FAIL(阻断)降为 WARN(两个已知处理项)

| review F1 子点 | PoC 实测 | 裁决 |
|---|---|---|
| Tailwind v4 下 shadcn init 跑不通 | `init` 输出 "Validating Tailwind CSS. **Found v4**" ✔，写 components.json + button.tsx + utils.ts + 改 index.css，退出 0 | **证伪**：v4 原生支持 |
| `@theme inline` 与现有 `@theme` 冲突 | index.css 现同时含原 `@theme{}`（`--color-*`）+ shadcn `@theme inline{}`（映射 `--color-background` 等），**共存** | **证伪** |
| `tailwindcss-animate` 在 v4 不工作 | shadcn 自动采用 **`tw-animate-css`**（v4 替代品）+ `@import "tw-animate-css"` | **证伪**：CLI 自动处理 |
| **`shadcn add` 引第二套 scoped `@radix-ui/*`** | button/dialog/tabs 全 `import { X } from "radix-ui"`（**统一包**）；package.json 直接依赖**仅** `radix-ui`，无 scoped；node_modules 的 scoped `@radix-ui/react-*` 是**统一 radix-ui 的传递依赖**（`radix-ui/package.json` 明列 `@radix-ui/react-dialog:1.1.19`），ui-v4 用同一 `radix-ui` 故本就有 | **证伪（最吓人的点）**：无第二套 Radix，与 ui-v4 共用同一套 |
| 整体编译/构建 | typecheck 0 / build 0；**JS 272KB / gzip 86KB**（远轻于 antd PoC 的 920KB/298KB） | 通过 |

### 两个真实待处理项(WARN,均有已知解)

1. **全局 `*{border-radius:0!important}` 架空 shadcn `--radius`（review F6，确认）**：构建产物 CSS 同时含 `border-radius:0!important` 与 shadcn `--radius:.625rem`——前者会压平 shadcn 圆角。**解**：迁移时把该全局规则**作用域化**到 `[data-design=amber-legacy] *{...}`（架子先行阶段做），shadcn 树即可按 `--radius` token 出圆角/锐角。低风险、机械。
2. **token 桥接（OQ-2 落点）**：shadcn init 注入自己的 `--background/--primary/...`（默认中性 oklch）+ `.dark` 变体。现有 B/A 类消费 `--color-*`（amber 命名空间）与 shadcn `--primary` 不同名。**解**：架子的中性化 token 层显式定义两套 preset——`shadcn` preset（OQ-2：中性灰 zinc/slate + 蓝白强调，覆盖 init 的默认 oklch）、`amber` preset（复现 Terminal Amber）；`--color-*` 与 shadcn token 的双向映射在此层完成。这正是「架子先行」要建的通用可扩展层。

### 附带观察

- Nova preset 带 **Geist 字体 + lucide-react**（决策 11 要 lucide，契合）；但 Geist 字体是 Nova 默认，真实迁移按需选（ui-v4 现用 IBM Plex Mono，可换 preset 或自定 `--font-*`）。
- init 把 `shadcn` 自身加进了 deps（CLI 惯例），真实项目可移到 devDeps 或仅用 npx。
- shadcn CLI 有 `-b base|radix`：`radix` = 用统一 `radix-ui`（本 PoC，匹配 ui-v4）；`base` 是另一套 primitive base，未测（我们要 radix 以复用现有 11 处 Radix 封装）。

## 对 RFC v2 的影响

- **F1 不再是阻断**：地基可行,迁移可推进。RFC v2 的「架子先行」阶段（前置地基 commit）落地路径清晰：`shadcn init -b radix -t vite` + 建两 preset token 层 + shiki 双主题 + 全局锐角作用域化。
- **仍需处理**：F6 锐角作用域化 + token 桥接（均在架子阶段）、F2 切换作用点、F3 新树测试策略、F4/F5 A/B 类去 Amber 化中性 token（这是最大工作量,PoC 未触及,仍是 RFC v2 核心）。
- **PoC 未覆盖**：A/B 类 152+29 处 Amber 引用的中性化实际工作量（review F4/F5 的核心）——那是迁移主体,非地基,不在本 PoC 范围。

## 文件

`exp/shadcn-tw4-poc/`：忠实复刻地基 + shadcn init 产物（components.json、ui/{button,dialog,tabs}、lib/utils、改造后 index.css）+ 测试 App（main.tsx 用三组件）。
