# ui-v4 Plan 05b — Session 增强（client/cost + group-by + subagent 种类名）Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 `ui-v4/docs/HANDOFF.md` + `DESIGN.md §5/§7`。

**Goal:** 给 Plan 05 的 Sessions 加：① SessionSummary 的 **client** 列 + **cost** 列 ② Requests 工作台 **Group by: None/Session/Agent** 开关 ③ subagent **种类名**（从 Task payload `subagent_type` 尽力推断）。

**⚠ 依赖成本持久化决策**：cost 需 entries_v2 持久化 `multiplier`（+ client 列），spec 已定**成本持久化非本轮、暂缓**——本 plan 的 cost/client **取决于先做「成本轮」**（给 entries_v2 加 `multiplier`/`client` 列 + 写路径 serialize/write，richest-data-flow）。**先确认成本轮是否已做**；未做则本 plan 只做 ② group-by + ③ subagent 种类名（不依赖新列），cost/client 留到成本轮后。

## 后端契约 / 改动
- **成本轮（前置，若未做）**：entries_v2 加 `multiplier`（写时从 model index 解析）+ `client`（归一化 user-agent）列 + serialize/write/read 投影。`SessionSummary` 加 `cost`(Σ token×multiplier per-token-type)/`client`。详见 spec §7「新增/改动后端」。
- **group-by**：`/entries?agentId=&mainAgentOnly=` 已接线（Plan 05）；session 分组靠 `?sessionId=` 或前端按 sessionId 归组。
- **subagent 种类名**：deep-read Task tool payload——subagent 首个请求的 system/messages 或父 agent 的 Task 调用 input 里的 `subagent_type`。**尽力推断、非保证**（spec §5：header 无种类名）；推断不出回退短 agentId。

## 文件结构
```
src/lib/history/(若做成本轮) sqlite/{schema,serialize,write,read}.ts + types.ts(SessionSummary +cost/client)
ui-v4/src/
├── components/sessions/{SessionRow,SessionDetailPage}.tsx(修改)  # +cost/client 列、+种类名
├── components/requests/HistoryList.tsx(修改)  # +Group by 开关(None/Session/Agent)
├── stores/list-store.ts(修改)  # +groupBy 状态
└── lib/agent-kind.ts  # 从 entry payload 推断 subagent_type(尽力)
```

## Tasks
- [ ] **Task 0（前置，可选）— 成本轮**：entries_v2 加 multiplier/client 列 + 写路径 + SessionSummary 加 cost/client + querySessionSummaries 算 cost（Σ per-token-type × multiplier）/client。**仅当用户决定做成本持久化时**。
- [ ] **Task 1 — Group by 开关**：HistoryList 加 None/Session/Agent；Session=按 sessionId 折叠分组头；Agent=按 agentId 分组。list-store 加 groupBy。
- [ ] **Task 2 — subagent 种类名推断**：`inferAgentKind(entry)` 从 payload 取 `subagent_type`（尽力），SessionDetailPage 泳道标签用「subagent · <kind>」否则短 agentId。
- [ ] **Task 3（依赖 Task 0）— SessionRow/Detail 加 cost/client 列**。
- [ ] **Task 4 — 独立 Agents 顶级页（可选）**：跨 session 按 agentId 扁平浏览（视需要，spec §5 默认以分组满足）。
- [ ] **Task 5 — 验证 + 回填**。

## 验收
- typecheck/test/build 绿；手动：工作台 group-by、session 详情 subagent 种类名（能推断时）、（若做成本轮）cost/client 列。

## 暂缓
- cost/client 严格依赖成本轮；未做则本 plan 只交付 group-by + 种类名。
