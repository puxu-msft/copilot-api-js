# Phase 4 — Export CSV + 抽屉 a11y + 文档卫生

> **实施状态：已完成**
> **落地**：2026-07 · commits `e0ecf22`/`a51bbcf`/`209f63c`/`f71ea6a`/`33bd5b6`（best-effort）
> **现状锚点**：[models-csv.ts](../../../ui/src/utils/models-csv.ts) · [download.ts](../../../ui/src/utils/download.ts) · [keyboard.ts](../../../ui/src/utils/keyboard.ts) · [ui/CLAUDE.md `/models`](../../../ui/CLAUDE.md)
> **备注**：`docs/2604-ui-models/` 未追踪（`??`）故不 `git mv` 归档、留原位；活文档已无 ModelCard/行内展开 陈旧引用。lint 债（Phase 1/2 遗留）已清。

> 总纲见 [README.md](README.md)。依赖 Phase 1-3。Global Constraints 隐含适用。
> 交付：当前过滤结果 Export CSV（含遥测列，同 join 策略）；抽屉焦点/aria/Esc；文档卫生（归档 `docs/2604-ui-models/`、回填 DESIGN/ui-CLAUDE）。

## 文件结构

- Create `ui/src/utils/models-csv.ts`（纯序列化；导出 `modelsToCsv`）。
- Modify `ui/src/utils/export-entry.ts`（复用/抽出 `triggerDownload`）或新建 `ui/src/utils/download.ts` 收敛 anchor 下载。
- Modify `ui/src/components/models/ModelsToolbar.vue`（Export CSV 按钮）、`VModelsPage.vue`（接线）。
- Modify `ui/src/components/models/ModelDetailDrawer.vue`（a11y：`onKeyStroke` Esc + `isTyping()` 守卫 + aria）。
- Tests：`ui/tests/models-csv.test.ts`、扩展 `ui/vitest/model-detail-drawer.test.ts`（Esc 关闭）。
- 文档：`git mv docs/2604-ui-models docs/archive/2604-ui-models`；回填 `docs/DESIGN.md`（Models 页架构）+ `ui/CLAUDE.md`（陈旧点）。

---

### Task 1: `models-csv.ts` 纯序列化

**Files:** Create `ui/src/utils/models-csv.ts`；Test `ui/tests/models-csv.test.ts`

**Interfaces:**
```ts
export function modelsToCsv(models: Array<Model>, caps: (m: Model) => DerivedCapabilities, telemetryFor: (id: string) => JoinedModelTelemetry | null): string
```
列（扁平）：`id,vendor,version,family,type,context,prompt,output,vision,tool_calls,streaming,thinking,billing_multiplier,premium,restricted_to,requests_7d,failures_7d`。缺失 → 空串。`restricted_to` join `;`。遥测列继承 Phase 1 join（失配模型为空）。CSV 转义：含 `,`/`"`/`\n` 的字段用 `"` 包裹 + `"`→`""`。

- [ ] **Step 1: 写失败测试**

```ts
import type { Model } from "~backend/lib/models/client"
import { describe, expect, test } from "bun:test"
import { deriveCapabilities } from "~backend/lib/models/capabilities"
import { modelsToCsv } from "@/utils/models-csv"

const m = (over = {}): Model => ({ id: "claude-opus-4.8", name: "Opus", vendor: "Anthropic", object: "model", preview: false, model_picker_enabled: true, is_chat_default: false, is_chat_fallback: false, version: "1", billing: { multiplier: 3, is_premium: true, restricted_to: ["pro", "business"] }, capabilities: { type: "chat", family: "claude-opus-4", supports: { vision: true }, limits: { max_context_window_tokens: 1000000 } }, ...over } as Model)

describe("modelsToCsv", () => {
  test("header + one row with telemetry", () => {
    const csv = modelsToCsv([m()], deriveCapabilities, (id) => (id === "claude-opus-4.8" ? { last7d: { model: id, requestCount: 5, successCount: 4, failureCount: 1, totalDurationMs: 0, averageDurationMs: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 } }, sinceStart: null } : null))
    const [header, row] = csv.split("\n")
    expect(header).toContain("id,vendor")
    expect(header).toContain("requests_7d")
    expect(row).toContain("claude-opus-4.8")
    expect(row).toContain("3") // billing multiplier
    expect(row).toContain("pro;business") // restricted_to joined
    expect(row).toContain(",5,") // requests_7d
  })
  test("escapes fields containing commas/quotes", () => {
    const csv = modelsToCsv([m({ name: "a,b\"c" })], deriveCapabilities, () => null)
    // name isn't a column; use a field that is — e.g. a family with a comma
    const csv2 = modelsToCsv([m({ capabilities: { family: "x,y", supports: {}, limits: {} } })], deriveCapabilities, () => null)
    expect(csv2.split("\n")[1]).toContain('"x,y"')
  })
  test("missing telemetry → empty cells", () => {
    const csv = modelsToCsv([m()], deriveCapabilities, () => null)
    expect(csv.split("\n")[1]).toMatch(/,,\s*$|,$/) // trailing empties for requests_7d/failures_7d
  })
})
```

- [ ] **Step 2: 跑确认失败** → FAIL。

- [ ] **Step 3: 写 `models-csv.ts`**

```ts
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import type { JoinedModelTelemetry } from "@/composables/model-telemetry-join"

const HEADERS = ["id", "vendor", "version", "family", "type", "context", "prompt", "output", "vision", "tool_calls", "streaming", "thinking", "billing_multiplier", "premium", "restricted_to", "requests_7d", "failures_7d"] as const

function esc(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v
}
const s = (v: unknown): string => (v == null ? "" : String(v))

export function modelsToCsv(models: Array<Model>, caps: (m: Model) => DerivedCapabilities, telemetryFor: (id: string) => JoinedModelTelemetry | null): string {
  const rows = models.map((m) => {
    const c = caps(m)
    const t = telemetryFor(m.id)?.last7d ?? null
    const cells = [
      m.id, m.vendor, s(m.version), s(m.capabilities?.family), s(m.capabilities?.type),
      s(c.contextWindow), s(c.maxPrompt), s(c.maxOutput),
      String(c.vision), String(c.toolCalls), String(c.streaming), String(c.thinking),
      s(m.billing?.multiplier), s(m.billing?.is_premium), (m.billing?.restricted_to ?? []).join(";"),
      s(t?.requestCount), s(t?.failureCount),
    ]
    return cells.map((cell) => esc(cell)).join(",")
  })
  return [HEADERS.join(","), ...rows].join("\n")
}
```

- [ ] **Step 4: 跑测试 + typecheck** → PASS / 0 error。
- [ ] **Step 5: 提交** — `git add -- ui/src/utils/models-csv.ts ui/tests/models-csv.test.ts && git commit -m "feat(ui): modelsToCsv serializer (flat rows + telemetry columns)"`

---

### Task 2: Export CSV 按钮 + 下载

**Files:** Modify `ModelsToolbar.vue`（Export CSV 按钮，emit `export-csv`）、`VModelsPage.vue`（handler：`modelsToCsv(filteredModels.value, caps, detail.telemetryFor)` → Blob → 下载）。复用 `export-entry.ts` 的 `triggerDownload`（若未导出则抽到 `ui/src/utils/download.ts` 供两处 import）。

- [ ] **Step 1: 抽/复用 `triggerDownload`**——把 `export-entry.ts` 的 `triggerDownload` 提为 `ui/src/utils/download.ts` 的 exported 函数，`export-entry.ts` 改 import 它（行为不变）。

```ts
// ui/src/utils/download.ts
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 2: VModelsPage handler**

```ts
function exportCsv(): void {
  const csv = modelsToCsv(filteredModels.value, caps, detail.telemetryFor)
  triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `models-${new Date().toISOString().slice(0, 10)}.csv`)
}
```
Toolbar 加按钮 `@click="$emit('export-csv')"`，页面 `@export-csv="exportCsv"`。

- [ ] **Step 3: vitest**（Toolbar 点击 emit `export-csv`）+ typecheck。
- [ ] **Step 4: 提交** — `git add -- ui/src/utils/download.ts ui/src/utils/export-entry.ts ui/src/components/models/ModelsToolbar.vue ui/src/pages/vuetify/VModelsPage.vue ui/vitest/... && git commit -m "feat(ui): export current models view as CSV"`

---

### Task 3: 抽屉 a11y（Esc + 焦点 + aria）

**Files:** Modify `ModelDetailDrawer.vue`；扩展 `ui/vitest/model-detail-drawer.test.ts`

- Esc 关闭：`onKeyStroke("Escape", ..., { target })` + `isTyping()` 守卫（参照 `VDetailPage.vue:172-181` 现有模式；`isTyping` 从同源工具导入）。**注**：Vuetify `v-navigation-drawer` `temporary` 自带 scrim 点击关闭——**不手写 `onClickOutside`**（battle-tested，避免双绑）。
- aria：抽屉根 `role="dialog"` `aria-label`（如 `` `Model details: ${model.id}` ``）；关闭按钮已 `aria-label="Close"`。焦点：Vuetify `temporary` drawer 自带 focus trap；确认打开时焦点入抽屉、关闭归还（若原生不足则补 `ref` + `focus()`，先实测原生行为再决定，勿假设）。

- [ ] **Step 1: vitest — Esc 关闭 emit update:modelValue false**

```ts
test("Escape closes the drawer", async () => {
  const w = mountWithVuetifyStubs(ModelDetailDrawer, { props: { modelValue: true, model, caps: deriveCapabilities(model as never), telemetry: null }, attachTo: document.body })
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  await w.vm.$nextTick()
  expect(w.emitted("update:modelValue")?.some((e) => e[0] === false)).toBe(true)
})
```

- [ ] **Step 2-4:** 实现 Esc + aria；跑 vitest + typecheck。先实测 Vuetify 原生 focus/scrim 行为（spec §8：勿假设），仅在原生不足时补最小焦点管理。
- [ ] **Step 5: 提交** — `git commit -m "feat(ui): model-detail drawer a11y (Esc close + aria + focus)"`

---

### Task 4: 文档卫生（收尾）

**Files:** `git mv docs/2604-ui-models docs/archive/2604-ui-models`；Modify `docs/DESIGN.md`（若有 Models 页架构描述则回填新结构）、`ui/CLAUDE.md`（陈旧点：`SplitPane.vue`/`AppHeader.vue` 已删、`onClickOutside` 现由抽屉首次引入）。

- [ ] **Step 1: 归档旧设计**

```bash
git mv docs/2604-ui-models docs/archive/2604-ui-models
```
（`git mv` 保留历史、可恢复；旧文档引用已不存在的 `ModelCard.vue`，不删只归档。）

- [ ] **Step 2: 回填活文档**——`ui/CLAUDE.md` 路由表 `/models` 行补"详情抽屉 + 遥测"；"已知设计问题"若列了 Models 行内展开则更新；勘误 `SplitPane/AppHeader` 陈旧引用。`docs/DESIGN.md` 前端子项目节若描述 Models 页则同步（**跨文档 grep** 验证：`grep -rn "ModelCard\|行内展开\|models.*JSON 展开" docs/ ui/CLAUDE.md` 无遗留旧描述）。

- [ ] **Step 3: 提交** — `git add -- docs/archive/2604-ui-models ui/CLAUDE.md docs/DESIGN.md && git commit -m "docs: archive 2604-ui-models; backfill Models drawer architecture"`

> **注**：`.md` 改动无需 typecheck；但 `git mv` 后确认无源码 import 指向旧路径（`grep -rn "2604-ui-models" src/ ui/src/` 应空）。**不碰 `CLAUDE.md`**（并发会话所有）。

---

## Phase 4 收尾（== 全计划收尾，走 `session-closeout` 五步）

1. **subagent audit**（交付前独立核验；裁判轴：CSV 遥测列 join 一致性、a11y 是否真落实〔焦点/aria/Esc〕、文档卫生跨文档 grep 是否零遗留；**非** ROI/最小化）。
2. **doc-sync + 跨文档 grep 验证**（旧 slug `completion-includes-doc-sync`）：`grep -rn "轮询\|usePolling\|ModelCard\|行内展开" docs/ ui/` 核对无过时描述；spec 的实施状态注解更新。
3. **归档 plan**：本 `docs/plan/ui-v4-models-enhancement/` 各文件头部加实施状态注解（`[done]`/日期/commit 范围）。
4. **提炼教训 + 维护记忆库**（遥测 join key 分裂、抽屉替换行内展开、richest-data-flow full supports 等可复用教训）。
5. **细粒度阶段提交**（每 task 已提交；最终确认 `bun run typecheck:ui` + 全 UI 测试 + 后端 models 测试全绿）。
