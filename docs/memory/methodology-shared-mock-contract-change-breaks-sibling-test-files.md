---
name: methodology-shared-mock-contract-change-breaks-sibling-test-files
description: 改被多文件各自 mock 的回调契约(如 itemContent 加参)会静默打爆你没改的那些 fake；per-task review 看不到、只有全量 vitest 抓得到
metadata: 
  node_type: memory
  type: project
  originSessionId: bcb244cc-4f65-450e-8ba1-4ff76efe80f2
---

ui-v4 里**多个测试文件各自**定义了自己的 `vi.mock("react-virtuoso")` FakeTableVirtuoso（`HistoryList.vitest` / `useHistoryInfinite.vitest` / `RequestsListPage.vitest` / `HistoryList.endReached.vitest`）。当生产代码改动一个被它们共同 mock 的**回调契约**——本例 `itemContent` 从 `(index, row)` 加第三参 `(index, row, context)`、且生产端开始读 `context.runs`——只更新了「计划点名的那一个」mock（HistoryList.vitest），其余各自的 fake 仍传两参 → `context` 为 undefined → 渲染期 `context.runs` 崩，把**那些 sibling 测试文件**打红。

**为何 per-task review 漏掉、全量才抓到**：单 Task 的 review package 只含本 Task diff，reviewer 推理「HistoryList.vitest 的 mock 已修、无回归」是对的——但它**看不到别的测试文件自带的 mock**。只有 `bunx vitest run`（全量）才让 sibling 崩溃显形。

**How to apply:**
- 改任何被 mock 的模块/回调契约（签名、新读的字段）前，先 `grep -rl 'vi.mock("<module>"' tests/` 枚举**所有**自带 fake 的文件，逐个更新，别只改计划点名的那个。
- 每个 Task 除跑目标文件测试外，**至少跑一次全量 `vitest run`** 才算终态绿；per-file 绿 ≠ 合并态绿。
- 实现者把 sibling 失败定性为「peer territory / 预存基线」时**不自证**——独立在 master(BASE) 上跑该文件确认：master 通过而分支失败 = 我们的回归、必须修（补第三参是根因修，非症状掩盖）。本例实现者误判 useHistoryInfinite 失败为 peer territory，独立核实后确认是 Task2 引入的回归。→ [[feedback-pass-null-clean-not-self-validating]]、skill `verifying-authoritative-claims`。

**Related:** 归属应下沉 skill `debugging-frontend-tests`（fake Virtuoso mock 家族那节）；实例来自 2026-07-10 session 色带特性 Task2→Task3。
