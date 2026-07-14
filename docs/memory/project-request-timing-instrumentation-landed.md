---
name: project-request-timing-instrumentation-landed
description: 请求首包/时序埋点特性(7 刻)已实现并合并 master(f982e0e3);权威看 ADR/spec/DESIGN 行,记 WS-event-strip 集成陷阱
metadata: 
  node_type: memory
  type: project
  originSessionId: aca9db5c-19cc-44e9-a595-a201c11dc840
---

请求首包/时序埋点特性 `[全部 landed，已合并 master `f982e0e3`]`（隔离 worktree `feat/timing-instrumentation` 13 commits rebase 后 `--no-ff` merge，冲突消解=去 chat-completions/responses handler 里 merge 重复的 `const streamStartMs`；peer 未提交 doc WIP 全保留）。7 个权威时刻:上游 4 刻(`upstream*At` epoch)存 per-attempt attempts[] blob、客户端 3 刻(`*Ms` offset 相对 started_at)存 entries_v2 三列;fleet 分位走遥测 DDSketch(HISTOGRAMS 3 分布 + 3 个 /metrics family)。**权威归属**:ADR `docs/decisions/2026-07-14-request-timing-instrumentation.md`(D1-D6 + 两段投影教训)、spec/plan 同名、DESIGN.md「活的架构现状」timing 行、API.md、deferred-backlog(缓冲扣留 UX + fleet 排除 aborted 盲区)。

承重实现教训(spec/ADR 已载,此处只记最反直觉的集成陷阱):

- **两段显式投影**:新增 per-attempt 字段须过 `Attempt → HistoryEntryData.attempts[]`(request.ts `_attempts.map`)+ `HistoryEntryData → HistoryEntry`(`toHistoryAttempts` allowlist)两段;新增 entry 字段须过 `toHistoryEntry` + `onTerminal` + `updateEntry` Pick + 列式 5 处。任一段漏 = typecheck 绿但静默丢,证伪只能靠**端到端真实终态链 round-trip**。同族 [[settle-freezes-history-entry-record]] / [[fix-all-comparison-sites]]。

- **WS restoreAccumulateCount 剥掉 event 行**(merged-state review 抓到的 HIGH):`responses/ws.ts` 的 `restoreAccumulateCount` 返回 `{ data }` **无 event**(WS 线上无 event 行),而 HTTP responses(`handler-v4.ts`)返回 `{ event: frame.event ?? event.type, data }` 保留 event。**任何在 client-sink 侧读 `frame.event` 的逻辑对 Responses-WS 端点全漏**。教训:openai 家族(cc/responses/gemini)的客户端帧判据一律 **parse `frame.data` 的 `.type`**(data-only),别读 event——才对 HTTP+WS 两传输都健壮。fake-谓词单测会掩盖此集成 bug,须补真实 per-format 谓词正样本(HTTP-event + WS-data-only 两个)。

- **谓词收完整帧非预解析 type**:driver loop-top(`driver.ts:~532`)的 type 派生是 `frame.event ?? (frame.data ? "message" : "keepalive")`、**不 JSON.parse**;openai/gemini 上游 data-only 无 event 行,type-string 相等谓词永不命中。故首包谓词收完整 `{event?,data?}` 帧、openai/gemini 分支自行 parse。

方法论价值:merged-state review(非逐 task)专抓这类「单端点静默丢」集成缝——per-task review + typecheck + 同源 fake 谓词都放过,只有跟真实数据通路第一人称走一遍才暴露。
