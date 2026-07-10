# 实施计划: ui-v4 shadcn 重设计 — 架子先行阶段 (C0-C7)

- 状态: **Draft-for-execution**（据 RFC v3 `../rfc/2026-07-10-shadcn-redesign/design.md` §4 C0-C7 派生）
- 日期: 2026-07-10
- 范围: **仅架子先行阶段 C0-C7**（通用可扩展地基 → 全域中性化 → 双树切换机制 → 水平 Tabs primitive）。逐页 P1-P8 + 收尾 Z1 **待架子落地后另立 plan**。
- 派生自: RFC v3（Approved-for-planning，3 轮对抗 review 收敛）+ 地基 PoC `../../../../exp/shadcn-tw4-poc/`
- 方法论: skill `large-refactor`（RFC-first + commit invariants + 过渡态显式无害 + golden 预捕获）、`superpowers:test-driven-development`、`superpowers:subagent-driven-development`
- 裁判轴: **长远正确 + 完整**（非 ROI/YAGNI）。架子必须做成可扩展（新 preset / 新页零重复脚手架），中性化据实覆盖全域 450，不缩范围。

---

## Global Constraints（实现者红线，每个 Task 通用，不重述）

1. **no-auto-server**：绝不跑 `bun run dev` / `dev:ui-v4` / `start` 或任何启服务器命令。需验证运行期行为时**记为「手动 UX 检查项」交用户启动**。可跑 `typecheck` / `build` / `test` / `lint` 等非服务器命令。
2. **INV-4 四绿（每 commit 硬门）**：
   - `bun run typecheck:ui-v4`（= `tsc --noEmit`，根 filter）
   - `bun run build:ui-v4`（= `vite build`；**含 bundle 体积对账**，PoC 基线 JS 272KB / gzip 86KB，膨胀需记录）
   - `bun run test:ui-v4`（ui-v4 `test` = `bun run test:bun && bun run test:vitest`；即 **bun 27 + vitest 66** 全绿）
   - 单文件 lint 用**无缓存** `bunx eslint <path>`（`lint` 带 `--cache` 会假绿；`.tsx` 测试不在 test-relaxation glob）
3. **细粒度 pathspec 提交**：一律显式 `git add -- <精确路径>` / `git commit -F <msgfile> -- <精确路径>`；每语义单元一提交；conventional commits；**不加模型署名**。本项目无 pre-commit 门禁，lint 靠手动 + subagent review。
4. **中性化零改可视化算法**：C2/C3 只把**颜色字面量**（`var(--color-*)` / 六位 hex / 三位 hex）替换为中性语义 token，**结构 class（布局 / 间距 / 尺寸 / 对齐）逐字保留**，diff/SSE 累积/shiki 分词/内容解析逻辑一行不动。
5. **grep 守卫 `designVersion` 不进 A/A′/B**：每 commit 跑 `grep -rn designVersion src/lib src/hooks src/stores src/components/detail src/components/tools src/components/common src/components/models/detail-tabs src/components/learned src/components/sessions src/components/overview` 须**零命中**（INV-1；R1）。`designVersion` 只允许出现在 D-shell / chrome / dock（C6 及逐页）。
6. **并发会话共享 master**：本仓库常有并发 agent，**实现在隔离 worktree + 独立分支**（放 `./.worktrees/`），最终提交用 pathspec 免疫 peer 的 index race。→ skill `git-preference:isolating-from-a-shared-git-worktree`。
7. **no-destructive-workspace-loss**：唯一判据是可恢复性；撤销自己刚做的编辑用**重新编辑**而非回退；C 类 legacy（`shared/*`）**冻结不删**（Z1 才删）。
8. **命令路径**：本 plan 全部 `file:line` 锚点相对 `ui-v4/`（如 `src/stores/ui-store.ts:3`）。根命令带 `:ui-v4` 后缀。

---

## 阶段依赖与顺序

```
C0 地基+data-design落根 ─┐
                          ├─> C1 语义token层+两preset ─> C2 A′中性化 ─┐
                          │                                            ├─> C4 全局amber规则族作用域化 ─> C6 双树切换机制 ─> C7 水平Tabs primitive
                          │                            C3 B内容体中性化(全域)┘
                          └─> C5 C primitives落地(与C1-C4正交,可并行,排C6前)
```

- C0→C1→C2→C3 严格串行（token 层是 C2/C3 的落点；C3 依赖 C1 的 `--surface-*` 族）。
- C4 依赖 C0（`data-design` 根属性，B7 原子性）+ C2/C3（中性化后 legacy 像素等价可 golden 验证）。
- C5（`components/ui/*` 落地）与 C1-C4 正交，**建议排 C4 后、C6 前**（C6 的 shadcn shell 骨架需 C primitive）。
- C6 依赖 C4（作用域化后 shadcn 树才出圆角/不泄漏 amber）+ C5。
- C7 依赖 C6（fork 机制就位）。

**共 8 个 Task（C0-C7）。** 每 Task 后 INV-4 四绿是硬门。

---

## Task C0 · 地基 + `data-design` 落根

- **对应 RFC**: §4 C0、§3「僵尸字段处置」、round1-F1（PoC 证伪）、round2-B7（原子性）、round1-W6
- **目标（commit 终态）**: shadcn 地基就位（`components.json` new-york + `components/ui/` + `lib/utils.ts` `cn` + `tw-animate-css` + lucide-react），ui-store **删僵尸 `theme`/`setTheme`/`ThemeMode`**、加 `designVersion`（默认 `amber-legacy`）+ `colorPreset`（默认 `amber`），DOM 根据 `designVersion` 写 `data-design` 属性。**视觉零变化。**
- **commit invariant**:
  - INV-3：`data-design=amber-legacy` **本 commit 即写进 DOM 根**（与 C4 作用域化原子对齐，杜绝 C4→C6 窗口丢锐角）。
  - INV-4 四绿；grep 守卫（`designVersion` 未进 A/B）。
  - 视觉零变化（僵尸 theme 按钮删除除外——它本是死代码，无消费者）。

### 改动 file 锚点

- `src/stores/ui-store.ts`：
  - **删** `ThemeMode`（`:3`）、`theme` 字段（`:6`）、`setTheme`（`:8`,`:17-20`）、`STORAGE_KEY`（`:12`，theme 用）。
  - **加** `designVersion: "amber-legacy" | "shadcn"`（默认 `"amber-legacy"`，持久化到新 localStorage key）+ `setDesignVersion`；`colorPreset: "amber" | "neutral"`（默认 `"amber"`）+ `setColorPreset`。（`wsConnected`/`setWsConnected` 不动。）
- `src/components/shell/TopBar.tsx`：**删** theme 读取（`:5-6`）+ `◐ {theme}` 按钮（`:16-22`）。**本 commit 不加 designVersion 按钮**（C6 加，避免此时无 shadcn 树可切）。`wsConnected` 显示不动。
- `src/main.tsx` 或新建根挂载副作用：据 `designVersion` 响应式 `document.documentElement.setAttribute("data-design", designVersion)`。**建议独立成一个订阅 store 的 effect**（放 `main.tsx:13` render 前的模块级订阅，或 AppShell 之上的薄 wrapper——但 C6 会把 `designVersion` 读取下沉，故此处**只写 DOM 属性、不渲染分支**，不违反「L0 本体零 designVersion 引用」，因为它不在 AppShell 组件体内）。落点决策写进 commit message。
- `src/index.css` 或 `src/styles/theme.css`：`shadcn init -b radix -t vite` 注入的 shadcn CSS 变量层（`--background`/`--primary`/`--radius`/... + `@theme inline{}` + `@import "tw-animate-css"`），与现有 `@theme{}`（theme.css:4-16 的 `--color-*`）**共存**（PoC 证实）。
- 新增 `components.json`（new-york style，`baseColor: neutral`，`iconLibrary: lucide`，aliases 对齐 ui-v4 的 `@/` 路径）、`src/lib/utils.ts`（`cn`）、`components/ui/`（init 产物 button 起步）。
- `package.json`：加 `lucide-react`、`clsx`、`tailwind-merge`、`tw-animate-css`（PoC 依赖对照）。
- 参照 PoC 落地形态：`exp/shadcn-tw4-poc/{components.json,src/index.css,src/lib/utils.ts,src/components/ui/}`。**注意 PoC 用 `style: radix-nova`；本项目决策要 new-york，init 时选对 preset。**

### TDD 步骤

1. **先写守卫测试**（红）`tests/ui-store.vitest.test.ts`（或复用现有）：断言 `useUiStore` 有 `designVersion` 默认 `"amber-legacy"` + `colorPreset` 默认 `"amber"`；断言 `theme`/`setTheme` **不再存在**（`expect((store as any).theme).toBeUndefined()`）。
2. **写 data-design 落根测试**（红）`tests/data-design-root.vitest.test.ts`：挂载根副作用 → `expect(document.documentElement.getAttribute("data-design")).toBe("amber-legacy")`；切 `setDesignVersion("shadcn")` → 属性变 `"shadcn"`。
3. **改 ui-store + TopBar + 根副作用**（绿）。跑 `shadcn init`（离线校验产物，不跑 dev）。
4. **回归**：现有 TopBar 相关测试若断言 theme 按钮，同步改（断 WS 状态而非 theme 按钮）。
5. INV-4 四绿。

### 可扩展性

token 变量层 + `components.json` + `data-design` 根属性就位，后续 `shadcn add X` 零配置接入；`colorPreset` 加第三 preset 只需加映射。

### 验收 gate

- INV-4 四绿；grep 守卫 `designVersion` 未进 lib/hooks/stores/B 目录（此时只在根副作用，允许）。
- `data-design=amber-legacy` 在 DOM 根（守卫测试证）。
- `theme`/`setTheme`/`ThemeMode` 全仓零残留（`grep -rn 'setTheme\|ThemeMode\|s.theme' src tests` 零命中）。
- **手动 UX 检查项（交用户）**：启动后视觉与迁移前一致（TopBar 少了 theme 按钮）。

### 提交指引

```
git add -- ui-v4/src/stores/ui-store.ts ui-v4/src/components/shell/TopBar.tsx ui-v4/src/main.tsx ui-v4/src/index.css ui-v4/components.json ui-v4/src/lib/utils.ts ui-v4/src/components/ui ui-v4/package.json ui-v4/bun.lock ui-v4/tests/ui-store.vitest.test.ts ui-v4/tests/data-design-root.vitest.test.ts
git commit -F <msg> -- <上述路径>
```
`feat(ui-v4): scaffold shadcn foundation + data-design root, drop zombie theme state`

---

## Task C1 · 中性化语义 token 层 + 两 preset

- **对应 RFC**: §3 第 2 层、round2-B5（token 家族爆炸 + `--surface-*` scale 族）、§4 C1、R10
- **目标**: 在 shadcn token 之上定义**设计中性的语义 token 家族** + `amber`/`neutral` 两 preset 映射 + `--color-*` ↔ 语义 token 桥接。**只加层、不改消费者，视觉零变化。**
- **commit invariant**:
  - INV-3：`amber` preset 下每个语义 token 解析回**等价 amber 值**（消费者尚未切换，纯零变化）。
  - INV-4 四绿。

### 改动 file 锚点

- `src/styles/theme.css`（或独立 `src/styles/tokens.css` 由 theme.css `@import`）：定义语义 token 家族，每 preset 各一组映射。**据实测色值建 token**（源自 theme.css:4-16 + 全域 hex 审计）：
  - **内容语义** `--content-*`（含同角色多 shade 独立 token）：thinking 至少 3 紫——`ThinkingBlock` 用 `#a89ac0`/`#6a5a8a`、`amber-theme.ts:45` keyword `#9a8ad0`、`DetailTocTree` 紫；须 `--content-thinking` / `--content-thinking-dim` / `--content-thinking-accent`。tool 至少 2 绿。add/del/system/muted 各自 token。
  - **信号语义** `--signal-*`：`--signal-ok`（`#7fd99a`/theme.css:12）/`--signal-fail`（`#e08a8a`/`:14`）/`--signal-warn`（`#d4a04a`/`:13`）/`--signal-live`。覆盖 request-columns / model-status / model-table-columns。
  - **厂商语义** `--vendor-*`：`--vendor-anthropic`（`#b48ead`/vendor-color.ts:10）/`--vendor-openai`（`#5aa2d0`/`:11`）/`--vendor-google`（`#8fbf7f`/`:12`）/`--vendor-other`（`#d08fb4`/`:13`）/`--vendor-muted`。
  - **表面/近黑语义** `--surface-*` scale 族（**round2-B5，C3 最大工作量根源**）：实测约 29 个 surface/near-black hex（`#1a1820`/`#1e1e24`/`#100e0b`（amber-theme.ts:33 code bg）/`#14141a`（DetailSubRail:17）/`#3a2f1a`（rdp/active bg）…）**无 `--content-*`/`--signal-*` 可归**。建 `--surface-base`/`--surface-raised`/`--surface-overlay`/`--surface-sunken` + 每独立 shade 一 token。
  - **preset 组织**：`amber` preset 复现 Terminal Amber 等价值（`--radius:0`、琥珀阶、mono）；`neutral` preset = 中性灰 zinc/slate + 蓝白强调（OQ-2，覆盖 shadcn init 默认 oklch）。preset 作用域用 `[data-design=amber-legacy]` / `colorPreset` 属性（与 C0 落根属性对齐）。
  - **桥接**：`--color-*`（amber 命名空间，现 B/A′ 消费）别名指向语义 token（或反向），PoC WARN-2 处理项。**本 commit 桥接后 `--color-*` 仍解析回原值**（消费者未改，零变化）。
- 参照 PoC `exp/shadcn-tw4-poc/src/index.css:12-19,27-68`（`@theme` 与 `@theme inline` 共存形态）。

### TDD 步骤

1. **先写 token 存在性 + 等价性守卫**（红）`tests/semantic-tokens.vitest.test.ts`：用 jsdom `getComputedStyle` 或直接断言 CSS 文本含所有语义 token 名 + 两 preset 块；**关键等价断言**：amber preset 下 `--signal-ok` 解析（或桥接后 `--color-ok`）= `#7fd99a` 等（golden 色值表）。
2. **写 CSS token 层 + 两 preset 映射 + 桥接**（绿）。
3. **回归**：现有测试全绿（消费者未改，零变化）。
4. INV-4 四绿。

### 可扩展性

新 preset = 加一组映射，零结构改动（新页/新树免改 token 层）。

### 验收 gate

- INV-4 四绿。
- 语义 token 家族齐全（`--content-*` 含多 shade / `--signal-*` / `--vendor-*` / `--surface-*` scale 族），守卫测试证存在 + amber 等价。
- 消费者零改动（`git diff --stat` 只含 CSS + 测试）。

### 提交指引

```
git add -- ui-v4/src/styles/theme.css ui-v4/src/styles/tokens.css ui-v4/tests/semantic-tokens.vitest.test.ts
git commit -F <msg> -- <上述路径>
```
`feat(ui-v4): add neutralized semantic token families + amber/neutral presets`

---

## Task C2 · A′ 中性化（列/单元构建器 + shiki 双主题 + bun 断言迁移）

- **对应 RFC**: §2 A′ 类、§3 第 3 层、round1-F5、round2-A4（锚点修正）、round2-B4（shiki baked hex 安全）、**§8.1a（bun A′ 断言必纳入本 commit）**、§4 C2
- **目标**: A′ 四处 lib + `model-table-columns.tsx` 颜色字面量 → 语义 token；shiki 单主题 → 双主题按 `colorPreset` 切。**amber-legacy 像素等价。A′ 升格为 A。**
- **commit invariant**:
  - INV-1：中性化后 A′ 零 `designVersion` 分支、零新颜色字面量（只经语义 token）。
  - INV-3：amber-legacy 下解析回等价 amber 值（像素等价）；shiki baked hex 随 amber 主题走等价（round2-B4）。
  - INV-4 四绿——**含 bun 27**（vendor-color.bun + model-status.bun 断言必须同 commit 迁移，否则卡红）。

### 改动 file 锚点

- `src/lib/vendor-color.ts`（6 处颜色，`:8` muted + `:10-13` 四 hex）：`#b48ead`→`var(--vendor-anthropic)`、`#5aa2d0`→`var(--vendor-openai)`、`#8fbf7f`→`var(--vendor-google)`、`#d08fb4`→`var(--vendor-other)`、`var(--color-muted)`→`var(--vendor-muted)`。
- `src/lib/model-status.ts`（3 处 `colorVar`，`:42` fail / `:43` muted / `:44` muted）：`var(--color-fail)`→`var(--signal-fail)`、`var(--color-muted)`→`var(--signal-muted)`（或保 `--content-muted`，与 C1 命名一致）。
- `src/lib/request-columns.ts`（12 处 `var(--color-*)`/hex，返回带 amber class 的 `ReactNode`）→ 语义 token（signal/content）。
- `src/components/models/model-table-columns.tsx`（**round2-A4 新锚点**：`:114`(muted) `:171`(primary) `:175`(primary) `:177`(muted) `:180`(muted) `:219`(`#aaa`) `:234/238/279/283`(`#cdb`) `:245`(muted) `:254`(ok+`#3a3a42`) `:271`(ok+`#3a3a42`) `:291`(primary) + `import { vendorColor }` `:20`、`:124` 调用、`:209` `m.colorVar`）→ 语义 token；vendorColor/statusMeta 已在上游中性化，本文件消费其结果。
- `src/lib/highlight/shiki.ts`（`:44` `THEME_NAME`、`:90-108` 单例、`:102` `themes:[AMBER_THEME]`、`:180` `codeToHast({theme:THEME_NAME})`）：加中性主题，`codeToHast` 的 `theme` 按当前 `colorPreset` 选（amber→terminal-amber，neutral→中性）。**注意 `highlighterPromise`/`loadedHighlighter` 是模块私有 `let`、无 reset 导出**（`:90-91`，仅导出 `getHighlighter`/`getLoadedHighlighter`）——双主题时 `createHighlighterCore({themes:[AMBER_THEME, NEUTRAL_THEME]})` 一次注册两主题、按参数选，**无需 reset**。
- 新增 `src/lib/highlight/neutral-theme.ts`（镜像 `amber-theme.ts` 的 `ThemeRegistration`，中性/蓝白配色，scope 覆盖同 `AMBER_THEME`）。
- **bun 断言迁移（§8.1a，硬 gap）**：
  - `tests/vendor-color.bun.test.ts`（`:20-34` **9 处** `.toBe("#...")` + `:38-39` 两 muted）：改断**语义 token 名**（`expect(vendorColor("Anthropic")).toBe("var(--vendor-anthropic)")` 等），而非解析 hex。
  - `tests/model-status.bun.test.ts`（`:40` `var(--color-muted)` / `:47` `var(--color-fail)` / `:54` `var(--color-muted)`，共 3 处 colorVar）：改断新语义 token 名。

### TDD 步骤

1. **golden 预捕获（§8.4，前置于中性化）**：为 `model-table-columns` 渲染的行/单元、含 vendorColor 的 chip、CodeBlock 高亮体先建 golden（同步体直接 `toMatchSnapshot`；含 CodeBlock 的 code-bearing 体 `beforeEach: await getHighlighter()` **仅预热**、不 reset，锁 amber-legacy 渲染）。
2. **先改 bun 断言 → 语义 token 名**（此步单独会红，因源码未改）——但**与源码改动同 commit**，故顺序上先写断言目标再改源码。
3. **改 A′ 源码**（vendor-color / model-status / request-columns / model-table-columns / shiki + neutral-theme）（绿）。
4. **golden 复跑**：中性化后 amber-legacy golden 须**仍过**（像素等价证据）。
5. INV-4 四绿——**特别确认 bun 27 绿**（vendor-color + model-status bun 断言已迁）。
6. grep 守卫：A′ 文件零 `designVersion`、零裸 hex/`var(--color-*)`（`grep -nE '#[0-9a-fA-F]{3,6}|var\(--color-' src/lib/vendor-color.ts src/lib/model-status.ts src/lib/request-columns.ts src/components/models/model-table-columns.tsx` 零命中）。

### 可扩展性

A′ 升格为 A；任何树消费同一份中性化构建器；shiki 双主题按 preset 切，新 preset 加一主题即可。

### 验收 gate

- INV-4 四绿（尤其 bun 27，vendor-color/model-status 断言已迁）。
- A′ 文件零颜色字面量、零 `designVersion`。
- amber-legacy golden 全过（像素等价）。
- **手动 UX 检查项**：amber-legacy 下 Models 表 vendor chip / status dot / 代码高亮与迁移前视觉一致。

### 提交指引

```
git add -- ui-v4/src/lib/vendor-color.ts ui-v4/src/lib/model-status.ts ui-v4/src/lib/request-columns.ts ui-v4/src/components/models/model-table-columns.tsx ui-v4/src/lib/highlight/shiki.ts ui-v4/src/lib/highlight/neutral-theme.ts ui-v4/tests/vendor-color.bun.test.ts ui-v4/tests/model-status.bun.test.ts ui-v4/tests/<golden 测试>
git commit -F <msg> -- <上述路径>
```
`refactor(ui-v4): neutralize A' color builders + shiki dual-theme, migrate bun color assertions`

---

## Task C3 · B 内容体中性化（全域，非仅 detail/）

- **对应 RFC**: §2 B 类 + scope 分解表、§3 第 2 层、round2-A4（全域扩范围）、round2-A3（B↔C 适配器）、§8.2、§4 C3、R5/R8
- **目标**: **全域 B 内容体**颜色字面量 → 中性语义 token（含 `--surface-*` 族）；B↔C 边界解耦（裸中性元素或 design-agnostic 适配器，含 `BlockJsonModal` 的 Dialog API 归一）。**grep 守卫扩到全部 B 目录。amber-legacy 像素等价。**
- **commit invariant**:
  - INV-1：C3 后中性化红线对**所有域 B** 生效（非仅 detail/）；零 `designVersion`、零新颜色字面量。
  - INV-3：amber-legacy 全域 B 像素等价。
  - INV-4 四绿。
- **注意（可拆子 commit）**: C3 面大（detail 152 + 其它域 B ~80）。**建议按域拆多个 commit**（detail / tools+common / models-detail-tabs / learned / sessions / overview / requests-row + 适配器），每子 commit 独立 INV-4 四绿。本 Task 视为一组同构子 commit。

### 改动 file 锚点（据 §2 scope 分解表，仅 B 子集，D-shell 不动）

- **detail/（152 `var(--color)` + 29 六位 hex）**：`detail/blocks/*`（ThinkingBlock 3 紫→`--content-thinking*`、ToolUseBlock/ToolResultBlock 绿→`--content-tool*`、TextBlock/SystemMessage/GenericBlock/ImageBlock）、`detail/diff/*`（DiffRow/InlineParts/MessageDiffView/SseFrameDiff/UnifiedLineDiff add/del→`--content-add`/`--content-del`）、`detail/segments/*`（ConvoSegment/HeadersSegment/MetaSegment/ResponseSegment/SseEventsSegment/StagesSegment/SystemSegment/LegShell）、`detail/ContentRenderer` `detail/CodeBlock` `detail/LineNumberedText` `detail/MessageBlock` `detail/ConversationView` `detail/DiagnosticBar`、`detail/toc/DetailTocTree`（紫映射）。
  - **注意**：`detail/DetailSubRail.tsx`（`:17` `#14141a` + `var(--color-border)`、`:23` `#3a2f1a`+primary）**属 D**（tab 容器，逐页 P3 改），**不在 C3**；但其 segment 内容体（B）中性化。`detail/DetailPanel.tsx`、`detail/toc/TocSidebar` 属 D，不在 C3。
- **tools/**：`JsonTreeView.tsx`（21）= B（C3）；`JsonToolsPage`（11）= D-shell（P8，不动）。
- **common/**：`RawJsonView.tsx`（6）= B（C3）。
- **models/**：`detail-tabs/{DetailParts,TelemetryTab,OverviewTab,...}`（11）+ `UnmatchedTelemetry.tsx`（7）= B（C3）。其余 models/*（ModelsFilterBar 25 / ColumnMenu 10 / ModelDetail 9 / ModelsPage 6 / ModelsTable 4 / ModelDetailSubRail 3）= D-shell（P4，不动）。
- **learned/**：`LearnedRow.tsx`（12）+ `StatusBadge.tsx`（3）= B（C3）；`LearnedPage`（12）= D-shell（P7，不动）。
- **sessions/**：`SessionRow.tsx`（6）+ `AgentLane.tsx`（4）= B（C3）；`SessionsPage`+`SessionDetailPage`（各 2）= D-shell（P5，不动）。
- **overview/**：`StatCard.tsx`（4）= B（C3）；`OverviewPage` = D-shell（P1，不动）。
- **requests/**：仅 `RequestRow.tsx`（6，行内容体）= B（C3）；其余 requests/*（LiveDock 19 / LiveGroup 18 / HistoryList 14 / RequestsColumnMenu 10 / RequestFilterChips 8 / DateRangePopover 7 / RequestsFilterBar 4 / RequestDetailPage 2）= D-shell（P2/P3，不动）。
- **B↔C 边界（round2-A3，一等硬工作量）**：
  - `src/components/detail/BlockJsonModal.tsx`（`:2` `import { Modal } from "@/components/shared/Modal"`——**B 目录对 shared/* 唯一直接 import**）：建 **design-version-agnostic 的 Dialog 适配器**，规范化 `shared/Modal`（`Modal.tsx:24` `title`/`onClose`/`:34` `data-testid=modal-backdrop`/`:45` `Dialog.Title`/`:46` `Dialog.Close`）与 shadcn `Dialog`（slot 组合式）两套 API，**保住 `title`/`onClose`/`data-testid=modal-backdrop` 测试契约**（`BlockJsonModal.vitest.test.tsx` + `Modal.vitest.test.tsx` 依赖）。
  - `src/components/detail/ExportButton.tsx` / `JsonModalButton.tsx` / `ToolJumpButton.tsx`：走**裸中性元素路径**（用中性 token 的 `<button>`/`<span>`，round2-A3 证 ExportButton 顺畅）。

### TDD 步骤

1. **golden 预捕获**（§8.4，中性化前锁 amber-legacy）：detail segment 渲染、diff 行、JsonTreeView、LearnedRow、SessionRow、StatCard 等——同步体直接 snapshot；含 CodeBlock 的（ConvoSegment/ResponseSegment/MessageBlock）`beforeEach: await getHighlighter()` 仅预热。
2. **8 个颜色断言 vitest 文件迁移**（§8.1）：`DetailTocTree` / `RequestRow` / `ModelsTable` / `segments` / `ConvoSegment` / `SessionRow` / `diff-primitives` / `CodeBlock`——从断具体 `var(--color-*)`/hex 改为断**语义 token 名 / `data-*` role / `getByRole`+可访问名**（B1：tab-role 断言可迁）。**注意**：`ModelsTable`/`DetailTocTree`/`ConvoSegment` 实测确含颜色断言（grep 证实）。
3. **按域改 B 内容体**（绿），逐域 grep 守卫零残留颜色字面量。
4. **B↔C 适配器**：先写适配器契约测试（保 `data-testid=modal-backdrop`/`title`/`onClose`），再实现适配器，改 `BlockJsonModal` 走适配器。
5. **golden 复跑**：amber-legacy 全域 B golden 仍过。
6. INV-4 四绿 + **全域 grep 守卫**：`grep -rnE '#[0-9a-fA-F]{6}|var\(--color-' src/components/detail src/components/tools/JsonTreeView.tsx src/components/common/RawJsonView.tsx src/components/models/detail-tabs src/components/models/UnmatchedTelemetry.tsx src/components/learned/LearnedRow.tsx src/components/learned/StatusBadge.tsx src/components/sessions/SessionRow.tsx src/components/sessions/AgentLane.tsx src/components/overview/StatCard.tsx src/components/requests/RequestRow.tsx` 零命中（DetailSubRail/DetailPanel/TocSidebar 等 D 除外）。

### 可扩展性

全域 B 内容体自此 design-agnostic；新 preset/新树免改内容体；INV-1「中性化全前置」对所有域成立。

### 验收 gate

- INV-4 四绿；全域 B grep 守卫零颜色字面量。
- 8 个颜色断言测试已迁语义/role 层。
- B↔C 适配器保住 `data-testid=modal-backdrop` 契约（适配器测试证）。
- amber-legacy 全域 B golden 全过。
- **手动 UX 检查项**：amber-legacy 下 detail/tools/learned/sessions/overview 各页内容体视觉一致。

### 提交指引（按域多子 commit，示例）

```
git add -- ui-v4/src/components/detail/... ui-v4/tests/<相关 golden+迁移>
git commit -F <msg> -- <detail 子集>
```
`refactor(ui-v4): neutralize detail/ content bodies to semantic tokens` /
`refactor(ui-v4): neutralize tools+common+models-detail-tabs content bodies` /
`refactor(ui-v4): decouple B↔C boundary via design-agnostic Dialog adapter` 等。

---

## Task C4 · 全局 amber 规则族审计与作用域化

- **对应 RFC**: §1(3)、round1-F6、round2-B8（扩为规则族）、round2-B7（原子性）、PoC WARN-1、§4 C4、R2
- **目标**: `theme.css` 全局 amber 规则**整族**作用域化到 `[data-design=amber-legacy]`（不止锐角）。shadcn 树自此按 `--radius` token 出圆角、不出 toc-flash 暖底。**amber-legacy 像素等价。**
- **commit invariant**:
  - INV-3：`data-design=amber-legacy` 根属性已在 C0 落地（B7 原子性）；作用域化后 amber-legacy 树**保持全局锐角 + toc-flash 暖底等价**，shadcn 树不受影响。
  - INV-4 四绿。

### 改动 file 锚点（`src/styles/theme.css`）

作用域化整族到 `[data-design=amber-legacy]`（选择器前缀化）：
- `:29` `*, *::before, *::after { border-radius: 0 !important; ... }` → `[data-design=amber-legacy] *, [data-design=amber-legacy] *::before, ...`（`box-sizing` 可留全局；只作用域化 `border-radius:0!important`）。
- `:34` `.livedock-island { border-radius: 2px !important; }`（**实测在 :34，comment :32-33**；RFC C4 文本笔误写 `:32`）→ 作用域化（legacy 2px 例外）。
- `:40-44` `.toc-flash { outline; background:#2a2212; ... }`（**round2-B8**：由共享 `useAnchorScroll.ts:10` `FLASH_CLASS="toc-flash"` 施加于 B 段、泄漏进 shadcn 共享 B）→ 作用域化 legacy 暖底；shadcn 树的 toc-flash 用中性 token（`--surface-overlay` 或语义 flash token，C1 已备）。**注意 `background:#2a2212` 在 :42**（RFC 写 `:40` 指整规则块）。
- `:53-69` `.rdp-amber { ... }` + `.rdp-amber .rdp-day_button:hover`（day-picker 重映射，DateRangePopover）→ 作用域化。
- `:73-80` `@keyframes drawer-overlay-in` / `drawer-slide-in`（ModelDetail.tsx:96,104 消费）→ 按需归属（keyframes 本身设计无关，若 shadcn drawer 复用可保全局；若 amber 专属则作用域化——审计后定，写进 commit message）。
- **保留全局**：`:47-49` `.row-anomaly{font-weight:600}`（非颜色，结构）、`:83-89` `@media prefers-reduced-motion`（无障碍，全局）、`:30` `.mono`（字体，全局或按 preset）。

### TDD 步骤

1. **golden 前置**（若 C2/C3 已建含 toc-flash/圆角的 golden 则复用）：锁 amber-legacy 的锐角 + toc-flash 渲染。
2. **写作用域化守卫测试**（红）`tests/scoped-amber-rules.vitest.test.ts`：断言 CSS 文本中 `border-radius:0!important` / `.toc-flash` / `.rdp-amber` 规则**均前缀 `[data-design=amber-legacy]`**（正样本证检查触达：先断言未作用域化时命中，改后不命中全局形态）。
3. **改 theme.css**（绿）：整族前缀化。
4. **golden 复跑**：amber-legacy 仍过（根属性在，锐角/暖底等价）。
5. INV-4 四绿。

### 可扩展性

全局 amber 规则不再污染新树，preset 完全掌控圆角 + 瞬态高亮。

### 验收 gate

- INV-4 四绿；作用域化守卫测试证整族前缀化。
- amber-legacy golden 全过（锐角 + toc-flash + rdp 等价）。
- **手动 UX 检查项**：amber-legacy 全局锐角 + toc 跳转暖底闪 + 日期选择器 amber 皮肤保持；（shadcn 树此时尚未挂，圆角效果 C6 后验）。

### 提交指引

```
git add -- ui-v4/src/styles/theme.css ui-v4/tests/scoped-amber-rules.vitest.test.ts ui-v4/tests/<golden>
git commit -F <msg> -- <上述路径>
```
`refactor(ui-v4): scope global amber rule family to [data-design=amber-legacy]`

---

## Task C5 · C primitives 落地

- **对应 RFC**: §2 C 类、§4 C5、OQ-1（旧树冻结、双份）、PoC（dialog/tabs/button 已跑通）
- **目标**: `components/ui/*`（button/input/select/dialog/tabs/badge/slider/…）落地，映射现有 `shared/*` 封装能力。**旧 `shared/*` 不动（冻结，双份）。**
- **commit invariant**:
  - C 类过渡期**双份**（`shared/*` legacy + `components/ui/*` shadcn 并存）；`shared/*` 零改动。
  - INV-4 四绿。

### 改动 file 锚点

- `shadcn add dialog tabs button input select badge slider ...`（据现有 `shared/*` 能力清单选）→ 落 `src/components/ui/`。
- 映射对照（能力对齐，非删旧）：
  - `src/components/shared/Modal.tsx`（Radix Dialog 封装，`title`/`onClose`/`data-testid=modal-backdrop`）→ `components/ui/dialog.tsx`（C3 适配器已消费）。
  - `src/components/shared/FilterSelect.tsx` → `components/ui/select.tsx`。
  - `src/components/shared/RangeSlider.tsx` → `components/ui/slider.tsx`。
- `shared/*`（实测 23 处 `var(--color)`）**随冻结保持 amber，Z1 才删**——本 Task 零改动。
- 参照 PoC `exp/shadcn-tw4-poc/src/components/ui/{dialog,tabs,button}.tsx`。

### TDD 步骤

1. **写 C primitive smoke 测试**（红→绿）`tests/ui-primitives.vitest.test.tsx`：渲染 button/dialog/tabs（复用 `radix-smoke.vitest.test.tsx` 模式 + `setup.ts` 的 ResizeObserver/pointer stub），断 `role`/交互。
2. `shadcn add` + 落 `components/ui/*`（绿）。
3. **回归**：`shared/*` 测试（`Modal.vitest.test.tsx` 等）全绿（冻结未改）。
4. INV-4 四绿。

### 可扩展性

新页直接 import `components/ui/*`，无需再造原语；`shadcn add X` 增量接入。

### 验收 gate

- INV-4 四绿；C primitive smoke 测试绿。
- `shared/*` 零改动（`git diff --stat` 不含 shared/）。

### 提交指引

```
git add -- ui-v4/src/components/ui ui-v4/tests/ui-primitives.vitest.test.tsx ui-v4/package.json ui-v4/bun.lock
git commit -F <msg> -- <上述路径>
```
`feat(ui-v4): land shadcn C primitives (components/ui/*), freeze legacy shared/*`

---

## Task C6 · 双树切换机制（三 fork 点 + 结构隔离）

- **对应 RFC**: §5 切换作用点、§5b INV-FIDELITY-1、round1-F2、round2-A1（结构隔离 > 纪律）、round1-W4、§4 C6、§6 INV-2、R3/R4
- **目标**: AppShell 拆常驻 L0（`useWs`+`useLiveRequests`+`LiveDock` 挂载，本体**零 `designVersion` 引用**）；`designVersion` 读取**下沉到 L0 之下子组件**；chrome/页元素/LiveDock 呈现层三 fork 点互斥挂载。新 chrome 加 `designVersion` 切换按钮。shadcn shell 先最小骨架。
- **commit invariant**:
  - INV-2：三 fork 点各**互斥挂载**一棵（绝不双挂）。
  - INV-FIDELITY-1（**结构隔离强制**）：切换**绝不**重挂 L0（`useWs`/`useLiveRequests`/live-store 订阅）；**L0 本体源码零 `designVersion` 引用** + `useWs` effect deps **保持为空**。
  - INV-3：两版都可运行且自洽（amber-legacy 像素等价，shadcn 最小骨架可用）。
  - INV-4 四绿。

### 改动 file 锚点

- `src/components/shell/AppShell.tsx`（现 L0 = `useWs`@`:14` + `useLiveRequests`@`:19` + `LiveDock`@`:31` + `NavRail`@`:22` + `TopBar`@`:24` + `Outlet`@`:26`）：
  - **保 L0 常驻本体**：`useWs`/`useLiveRequests`/`setWsConnected` 订阅 + `<LiveDock/>` 挂载点。**L0 本体不 import、不读 `designVersion`**（round2-A1 结构隔离）。
  - **拆出 fork A（chrome）子组件** `ShellChrome`：读 `designVersion`，互斥挂载 legacy `<NavRail/><TopBar/>` vs shadcn 骨架（加宽 NavRail + lucide 图标 + TopBar + `<Outlet/>` 布局）。放在 L0 之下。
  - **拆出 fork C（LiveDock 呈现层）子组件** `LiveDockFork`：读 `designVersion` fork 呈现（订阅同一常驻 live-store，切换不丢数据）；挂载点仍在 L0（`:31`）。
- `src/main.tsx` / `App.tsx`：**单 router 不变**（`main.tsx:16` 单 `RouterProvider`、`App.tsx:20` 单 `createHashRouter`）；`QueryClientProvider`（`main.tsx:15`）常驻在 router 之上（跨切换存活）。**不换两套 router**（round1-W4：会重挂 AppShell 丢一次性 connected 快照）。
- **fork B（页元素）**：每个 RoutePage 内部按 `designVersion` 互斥挂载 legacy/shadcn 页壳——**C6 只建机制 + 一个示范页壳**（如给某页加同构 fork 骨架），逐页填充留 P1-P8。
- 新 chrome 加 `designVersion` 切换按钮（替代 C0 删的 theme 按钮）——放 shadcn TopBar 骨架 / ShellChrome。
- 新增 shadcn shell 骨架文件（如 `src/components/shell/shadcn/NavRail.tsx` + `TopBar.tsx`，最小：加宽 + 图标 + Outlet）。

### TDD 步骤

1. **写 INV-FIDELITY-1 结构守卫测试**（红）`tests/AppShellForkStructure.vitest.test.ts`：
   - ① **fork 点在 L0 之下**：断 AppShell L0 本体源码零 `designVersion`（可 grep 断言 `src/components/shell/AppShell.tsx` 不含 `designVersion` 字面量，或渲染断 L0 不随 designVersion 重渲）。
   - ② **`useWs` deps 保持为空**（行为回归，扩展 `AppShellLiveSubscription.vitest.test.tsx`）：快照到达后 `setDesignVersion` 切换 → 在飞请求**仍在 live-store**、订阅未断、AppShell 未重挂（用 `render` + rerender + 断 `wsClient.acquire` 未二次调用 / live-store 数据留存）。
2. **写 INV-2 互斥挂载守卫测试**（红）`tests/DesignVersionForks.vitest.test.tsx`：三 fork 点各断——`designVersion=amber-legacy` 只挂 legacy chrome/dock，`=shadcn` 只挂 shadcn，**绝不双挂**（`queryAllByTestId` 长度 1）。
3. **重构 AppShell**（绿）：拆 L0 / ShellChrome / LiveDockFork，`designVersion` 下沉。
4. **回归**：`AppShell.vitest.test.tsx` + `AppShellLiveSubscription.vitest.test.tsx` 全绿。
5. INV-4 四绿 + grep 守卫（`designVersion` 未进 L0 本体、未进 B/A′）。

### 可扩展性

切换在 chrome/页元素/dock 三 fork 点；新页接入只需在其页元素加同构 fork，无新脚手架。

### 验收 gate

- INV-4 四绿。
- INV-FIDELITY-1 结构守卫绿（L0 零 `designVersion` + useWs deps 空 + 切换不重挂）。
- INV-2 三 fork 点互斥挂载守卫绿。
- **手动 UX 检查项**：切 `designVersion` 两版 chrome/dock 互斥无双挂闪烁；切换保留 WS 快照 + 在飞请求 + react-query 缓存 + 当前 URL；shadcn 骨架 shell 出圆角（C4 作用域化生效验证）。

### 提交指引

```
git add -- ui-v4/src/components/shell/AppShell.tsx ui-v4/src/components/shell/shadcn ui-v4/src/components/requests/LiveDock.tsx ui-v4/tests/AppShellForkStructure.vitest.test.ts ui-v4/tests/DesignVersionForks.vitest.test.tsx ui-v4/tests/AppShellLiveSubscription.vitest.test.tsx
git commit -F <msg> -- <上述路径>
```
`feat(ui-v4): dual-tree designVersion switch via 3 fork points + structural L0 isolation`

---

## Task C7 · 水平 Tabs 内容布局 primitive 抽取（收窄）

- **对应 RFC**: §2 D 类、round2-A2（撤销 DetailContainer 过度抽象）、§4 C7、决策 10、R9
- **目标**: **只抽「水平 Tabs 内容布局 primitive」**（shadcn `Tabs` horizontal + 段内容槽），供 shadcn Requests（形态 A 整页）与 shadcn Models（抽屉）各自嵌入。**抽屉-chrome 与整页-chrome 各自实现，不归并成模式开关容器。** legacy `DetailPanel`/`ModelDetail` 冻结不动。
- **commit invariant**:
  - **不引入模式开关容器**（round2-A2：DetailPanel 内联整页 Tabs vs ModelDetail Radix Dialog+portal+overlay+resize+focus-trap 交互模型迥异，唯一真共享 = 竖→横 Tabs 布局）。
  - legacy `DetailPanel.tsx` / `ModelDetail.tsx` 零改动（OQ-1 冻结）。
  - INV-4 四绿。

### 改动 file 锚点

- **新增** `src/components/shared/HorizontalTabs.tsx`（或 `components/ui` 下）：薄封装 shadcn `Tabs`（horizontal orientation）+ 段内容槽 API。抽取的**唯一共享** = 竖→横 Tabs 布局，**不含** Dialog/portal/overlay/resize/focus-trap（那些是抽屉专属）也不含整页 chrome。
- **参照（不改，只抽公共形状）**：
  - `src/components/detail/DetailPanel.tsx`（`:36-85` `Tabs.Root orientation="vertical"` + `DetailSubRail` + 7 个 `Tabs.Content`；内联整页、无 Dialog）——shadcn 侧 P3 将其竖→横，嵌 C7 primitive。
  - `src/components/detail/DetailSubRail.tsx`（`:15-28` Radix `Tabs.List` + 7 `Tabs.Trigger`；B1：`role=tab` 迁 shadcn 不碎）。
  - `src/components/models/ModelDetail.tsx`（`:87-117` `Dialog.Root`+`Portal`+`Overlay`+`Content`+`useResizableWidth`+`drawer-slide-in` animate+`onEscapeKeyDown` focus-trap；6 竖 tabs）——shadcn 侧 P4 抽屉 chrome **各自实现**，只嵌 C7 primitive 做 tab 布局。
  - `src/components/models/ModelDetailSubRail.tsx`（`MODEL_DETAIL_TABS`）。
- **C7 只交付 primitive + 单元测试**，不接线到任何 legacy 页（P3/P4 才接线）。

### TDD 步骤

1. **写 primitive 单元测试**（红）`tests/HorizontalTabs.vitest.test.tsx`：断 `role=tablist`/`role=tab`/`role=tabpanel`（水平 orientation）、键盘导航、tab↔panel aria、内容槽渲染。用 `setup.ts` stub。
2. **实现 `HorizontalTabs`**（绿）：shadcn `Tabs` horizontal + 段槽。
3. **确认零接线**：`DetailPanel.tsx`/`ModelDetail.tsx`/`DetailSubRail.tsx`/`ModelDetailSubRail.tsx` **零改动**（`git diff --stat` 不含它们）。
4. INV-4 四绿。

### 可扩展性

未来 peek（backlog 形态 C）复用同一水平 Tabs primitive；抽屉/整页 chrome 各自演进不互相牵制。

### 验收 gate

- INV-4 四绿；primitive 单元测试绿（水平 tab role/键盘/aria）。
- legacy `DetailPanel`/`ModelDetail` 零改动。
- **无模式开关容器**（code review 确认：primitive 不含 Dialog/portal/resize）。

### 提交指引

```
git add -- ui-v4/src/components/shared/HorizontalTabs.tsx ui-v4/tests/HorizontalTabs.vitest.test.tsx
git commit -F <msg> -- <上述路径>
```
`feat(ui-v4): extract horizontal Tabs content-layout primitive (no mode-switch container)`

---

## 架子阶段收尾（C7 后，逐页 plan 前）

- **subagent audit**：派 `ecc:react-reviewer` + 对抗 reviewer 审 C0-C7（**prompt 显式裁判轴：长远正确 + 完整 + 架子可扩展**，非 ROI/YAGNI），核 INV-1..4 + INV-FIDELITY-1 全成立、grep 守卫全域零泄漏。
- **doc-sync**：更新 `../../DESIGN.md`「活的架构现状」（双树 + designVersion/colorPreset + 语义 token 层 + 三 fork 点）；RFC §4 标注 C0-C7 实施状态；跨文档 grep 验证一致。
- **逐页 plan 立项**：架子稳定后另立 `2026-07-1x-shadcn-redesign-per-page.md`（P1-P8 + Z1），P2/P4 依赖 C7、P1-P8 天然可并行。
- **手动 UX 全量检查项**（交用户）：`designVersion` 两版各自完整、三 fork 点无双挂闪烁、virtuoso 真虚拟化保真、切换保留 WS 快照/在飞请求（§5b、§11）。

---

## golden 测试策略要点（§8.4，C2/C3/C4 通用）

- **无 `toMatchSnapshot` 基线现状**（实测 `toMatchSnapshot` 零）→ golden 从零建。
- **分两类**：
  - **纯同步体**（Meta/Headers/非高亮 segment、JsonTreeView、LearnedRow、SessionRow、StatCard）：直接 `toMatchSnapshot`。
  - **含 CodeBlock 的 code-bearing 体**（ConvoSegment/ResponseSegment/MessageBlock/CodeBlock）：`beforeEach: await getHighlighter()` **仅预热**（`shiki.ts:90-91` `highlighterPromise`/`loadedHighlighter` 模块私有 `let`、**无 reset 导出**——按字面「beforeEach 置 undefined」不可操作；预热到单一确定性高亮态即可作 golden）。**唯有确需跨测试隔离**才在 `shiki.ts` 显式加 test-only `resetHighlighter()` 导出并写清「reset → 重新 await getHighlighter → 再 snapshot」顺序，默认取仅预热。
- **golden 生命周期**：中性化前锁 `amber-legacy` 渲染，中性化（C2/C3）+ 作用域化（C4）后须**仍过**（像素等价证据），作 INV-3 闸。
- **CodeBlock.test 现有模式参照**：`tests/CodeBlock.vitest.test.tsx` 用 `await waitFor`（`:39,:50,:85,:114`）绕开异步单例二态——golden 改用预热单例（确定性），不用 waitFor+snapshot 组合（会 flaky）。

---

## 与 RFC 核实时发现的锚点/事实差异（供实现者注意）

**全部为 RFC 文本的次要笔误，不影响架构结论；已在对应 Task 锚点就地校正：**

1. **`.livedock-island` 实际在 `theme.css:34`**（comment 在 `:32-33`），RFC §4 C4 写 `:32`。已在 C4 校正。
2. **`.toc-flash` `background:#2a2212` 在 `:42`**（规则块 `:40-44`），RFC 写 `:40`（指整规则块，可接受）。已在 C4 校正。
3. **`model-status.bun.test.ts` 的 3 处 colorVar 断言**：`:40` `var(--color-muted)` / `:47` `var(--color-fail)` / `:54` `var(--color-muted)`——RFC §8.1a 措辞「3 处 `.toBe("var(--color-muted)")`」暗示三处同值，实为 2 muted + 1 fail。计数 3 正确，迁移都要改。已在 C2 校正。
4. **`vitest 66` = 64 `.vitest.test.tsx` + 2 `.vitest.test.ts`**（`clipboard.vitest.test.ts` + `learned.vitest.test.ts`），RFC「66 vitest」是总 vitest 文件数，正确。

**RFC 核心事实经实测精确确认（无差异）**：
- 全域 `var(--color-*)` = **450**，且**逐目录分解与 §2 scope 分解表逐项吻合**（detail 152 / requests 88 / models 85 / tools 32 / learned 27 / shared 23 / sessions 14 / shell 12 / config 7 / common 6 / overview 4）。
- `lib/model-columns.ts` **零色**（纯 A，非 A′）；`request-columns.ts` **12** 处色。
- `vendor-color.bun.test.ts` **9** 处 hex 断言（`:20-34`）。
- `useWs.ts:29` effect deps `[]`；AppShell L0 锚点 `useWs:14`/`useLiveRequests:19`/`Outlet:26`/`LiveDock:31` 全吻合。
- `VirtuosoMockContext` 零命中；真实基建 = `RequestsListPage.vitest.test.tsx:52-78` 手写 `FakeTableVirtuoso`（`forwardRef` + 硬编码 `<thead>`/`<tbody>`/`TableRow` 契约）+ `setup.ts:11-17` `ResizeObserver` stub。
- `BlockJsonModal.tsx:2` 是 B 目录对 `shared/*` 唯一直接 import；`shared/Modal.tsx:34` `data-testid=modal-backdrop` + `:24` `title`/`onClose` 契约。
- `DetailPanel`（内联整页 `Tabs.Root vertical`，无 Dialog）vs `ModelDetail.tsx:87-117`（`Dialog`+`Portal`+`Overlay`+`useResizableWidth`+`drawer-slide-in` animate+`onEscapeKeyDown`）交互模型确迥异，C7 收窄成立。
