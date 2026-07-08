# Phase 4 — 态与交互

**依赖**：Phase 3（虚拟列表就位）+ Phase 0（清空历史消费 scoped delete）。

**Goal:** error/empty 三态 + 列表键盘导航 + 筛选感知清空历史确认。paused 行内更新已在 Phase 1（Task 1.3 门控顺序）落地，本阶段做 UI 呈现层收尾 + 端到端验证。

---

### Task 4.1: error / empty 三态

**Files:**
- Modify: [ui-v4/src/components/requests/HistoryList.tsx](../../src/components/requests/HistoryList.tsx)
- Test: `ui-v4/tests/HistoryList.vitest.test.tsx`（追加）

**Interfaces:**
- Consumes: `isError`/`error`/`refetch`（Task 1.3）；`hasAnyFilter`/`clearAll`（1.1/1.2）。

**三态**（在 `isLoading` 现有分支旁）：
- **error**（`isError`）：图标 + `String(error)` 消息 + 「重试」按钮（`onClick={() => void refetch()}`）。
- **empty**（`!isLoading && entries.length === 0`）：「无匹配请求」；`hasAnyFilter(filters)` 时额外「清除筛选」按钮（`onClick={clearAll}`）。
- loading：保留现有。

- [ ] **Step 1: 失败测试** — mock `useHistoryInfinite` 返回 `{ isError: true, error: Error("boom"), refetch }` → 渲染 error + 点重试调 refetch；返回 `{ entries: [], isLoading: false }` + 有筛选 → 渲染「清除筛选」，点击调 clearAll；无筛选 → 只「无匹配请求」。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** — 三态分支。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 提交** — msg `feat(ui-v4): HistoryList error/empty states`。

---

### Task 4.2: 列表键盘导航（↑/↓/Enter/Esc）

**Files:**
- Modify: [ui-v4/src/components/requests/HistoryList.tsx](../../src/components/requests/HistoryList.tsx)
- Test: `ui-v4/tests/HistoryList.vitest.test.tsx`（追加）

**Interfaces:**
- 维护 `focusedIndex: number`（`useState`），容器 `onKeyDown`：↓ `min(i+1, len-1)`、↑ `max(i-1, 0)` + `virtuosoRef.scrollToIndex({ index, align: "auto" })`、Enter → `selectRow(entries[i].id)`、Esc → 清焦点（`setFocusedIndex(-1)` + blur）。`isTyping(e.target)` 守卫（复用 detail 页思路：target 是 input/textarea/contenteditable 则不拦）。焦点行视觉高亮（区别于 selected）。

- [ ] **Step 1: 失败测试** — 3 条 entries，容器聚焦：`keyDown ArrowDown` ×2 → focusedIndex=2 + scrollToIndex 调用；`Enter` → navigate 到该 id；在 input 内 `ArrowDown` 不移动焦点行（isTyping 守卫）。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** — `onKeyDown` + focusedIndex + isTyping 守卫 + 焦点高亮传入 itemContent。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 提交** — msg `feat(ui-v4): HistoryList keyboard nav (arrows/Enter/Esc)`。

---

### Task 4.3: 筛选感知清空历史 + 确认 Modal

**Files:**
- Modify: [ui-v4/src/components/requests/HistoryList.tsx](../../src/components/requests/HistoryList.tsx)（header 加「清空」入口 + 确认流程）
- Test: `ui-v4/tests/HistoryList.vitest.test.tsx`（追加）

**Interfaces:**
- Consumes: `shared/Modal`（[Modal.tsx](../../src/components/shared/Modal.tsx)）；`api.delete<{ success: boolean; deleted?: number }>`（Task 0.3）；`toQueryString`（1.1）；`hasAnyFilter`；`total`（1.3）；`queryClient.invalidateQueries`。

**流程**：
1. header 「清空」按钮 → 打开 `Modal`。
2. 文案：`hasAnyFilter(filters)` → 「删除当前筛选命中的 {total} 条？」；否则 → 「清空全部 {total} 条？」。
3. 确认 → `await api.delete(`/history/api/entries${toQueryString(filters) ? `?${toQueryString(filters)}` : ""}`)` → `invalidateQueries(["history-infinite", …])` + 关 Modal。（后端返回 `{ deleted }` 可 toast/console 回填。）
4. **落地前 grep**（M5）：`cd ui-v4 && grep -rn "api.delete\|/history/api/entries" src/` 确认无其他清空历史入口（避免双入口）。

- [ ] **Step 1: 失败测试** — 有筛选（`{ endpoint }`, total=3）：点「清空」→ Modal 文案含「筛选命中的 3」；确认 → `api.delete` 收到含 `endpoint=` 的 URL + invalidate 调用。无筛选：文案「全部」+ `api.delete` 收到无 query 的 `/history/api/entries`。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** — `useState` 控 Modal 开合 + 确认 handler。
- [ ] **Step 4: 确认通过** → PASS。
- [ ] **Step 5: 门禁 + 提交** — typecheck + eslint + vitest；msg `feat(ui-v4): filter-aware clear history with confirm modal`。

---

### Task 4.4: paused 行内更新端到端验证 + 收尾

**Files:**
- Test: `ui-v4/tests/HistoryList.vitest.test.tsx` 或 `useHistoryInfinite.vitest.test.tsx`（补端到端）
- Modify: 文档同步（见下）

- [ ] **Step 1: 端到端测试** — paused（tailOn=false）+ 列表含 e1：`onEntryUpdated(e1 with new usage)` → 列表内 e1 行数据更新（原地）、**bufferedIds 不增**（不误进缓冲横幅）。这验证 Phase 1 Task 1.3 的门控顺序在真实渲染下成立。
- [ ] **Step 2: 确认通过**（若失败 → 回 Task 1.3 修门控顺序，非在此打补丁）。
- [ ] **Step 3: 全量门禁** — `cd ui-v4 && bun run typecheck && bun run test && bun run --filter copilot-api-ui-v4 build`（根目录跑 build）；仓库根 `bun test tests/history/`（Phase 0 后端回归）。全绿。
- [ ] **Step 4: 文档同步（session-closeout 步②）**:
  - [DESIGN.md](../../DESIGN.md)「活的架构现状」表：Requests 列表新增筛选层/虚拟化/scoped delete 标为活路径。
  - [TODO.md](../../TODO.md)「Activity」节：🔴筛选/URL、🟡错误态/paused 更新、🟢空态/键盘/清空历史 标对等达成；🟡双向翻页标「有意不补（tail+缓冲替代）」。
  - 跨文档 grep 验证无悬挂引用。
- [ ] **Step 5: 提交** — msg `docs(ui-v4): sync DESIGN + TODO — Activity parity achieved`。

---

### Task 4.5: 收尾 — subagent audit + 记忆维护

- [ ] **Step 1: subagent 独立核验**（显式裁判轴：长远正确 + 完整 + 与 spec/ADR 一致；不用 ROI/YAGNI）——审全量改动是否落全 spec §1 目标、红线 1-6 未破、search 维确未进门控、scoped delete 确照 deleteSession 模式。读它引用的每个 `file:line` 再采信。
- [ ] **Step 2: 折叠 audit 发现**（阻塞级修，建议级记录取舍）。
- [ ] **Step 3: 记忆/plan 归档** — plan 头部标实施状态；若有新战例（如 Virtuoso jsdom stub 方案、TanStack+Virtuoso 集成坑）→ 下沉 skill `debugging-frontend-tests` 或新 skill，MEMORY.md 留 stub。
- [ ] **Step 4: 最终提交** — 细粒度收尾提交。

---

**Phase 4 完成判据**：error/empty/键盘/清空历史全落地并测试；paused 行内更新端到端验证；全量门禁绿（typecheck + test + build + 后端 bun test）；文档同步；subagent audit 通过。**至此闭合全部 Activity 缺口。**
