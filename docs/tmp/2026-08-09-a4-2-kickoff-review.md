# A4-2 KICKOFF 评审

- **评审范围：** `0244f9a7` 引入的 `KICKOFF-a4-2.md`，以及其声明的 `HANDOVER.md` §B.5.2、正式计划 A4 与 base `11558f81` 代码。
- **已读取／执行的证据：** `git show 0244f9a7`；base 上 `git grep` 的 `onTermination`、`DispatchHandle`、计数释放及测试路由；逐段读取 transport／History 持久化接线。未启动服务器，未触碰 4141。
- **可核验断言：** C2–C6 均确认：四个 `onTermination` 点及生产零设置、`DispatchHandle` 在 h2 client 零命中、五段调用链行号、真实 h2c server／两路由、PING／reservation／散落 decrement 均与 KICKOFF 相符。C1 仅部分成立：snapshot 的 `firstObservedSignal` 等字段见 `src/lib/transport/http2-observation-types.ts:59-77`，但 GOAWAY 只有 `opaqueDataLength` 与 evidence，不含原始 `opaqueData`（`:19-24`）。
- **总体 verdict：** 修复 major 后可进入下一阶段。
- **blocker 数量：** 0。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/a4-h2-diagnostics/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF-a4-2.md:114,119,128` — peer `RST_STREAM(CANCEL)` 的核心验收没有可执行 oracle。现有 `http2-client.it.test.ts` 只有 `/termination` 与 `/termination-trailers`（:450,476），并明确记录 Bun 的 `node:http2` 对 server RST 交付为 `end → close` 且 `rstCode=0`（:300-309）；所以“用现有 h2 server 跑四场景后据此断言”既没有 peer-RST 场景，也不能取得所要求的 code。修复：先以独立 Node runtime／原始帧可见的 probe 定义 peer-RST oracle；若生产 Bun 本身不可观测，正式记录这个能力缺口，不能宣称以该 runtime 的 History 记录区分 peer CANCEL。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/a4-h2-diagnostics/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF-a4-2.md:100-103,114` — “不做 A4-3”与 GOAWAY 验收相互矛盾，直接继承了上游 A4 的未闭合接线。生产 `runHttp2Fetch` 传入 `createLocalTerminationCommitPort()`（`src/lib/transport/http2-client.ts:1150-1153`），故 snapshot 永远是默认空 GOAWAY；唯一 production `goaway` listener 只 `retire` session（:569-583）。原始 `opaqueData` 亦不在 snapshot，只有 `opaqueDataLength`／evidence（`http2-observation-types.ts:19-24`）。修复：把 GOAWAY ledger/session ref 接线完整纳入 A4-3，或从 A4-2 的验收表删除该行并在正式计划作有理由的分批 disposition；不得保留“本批记录 code／lastStreamID”这个不可达承诺。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/a4-h2-diagnostics/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF-a4-2.md:2,34,79-85` — 文档一面声明正式计划／HANDOVER 是最终权威，一面将“本次对账”设为更高权威；而对账实际只证明 callback 存在，未证明它满足 A4 的 stream、session 和持久化契约。这会让接手者以“已有 snapshot 更完备”为由静默缩窄冻结 A4。修复：在正式计划或 HANDOVER 写逐项 disposition：snapshot 已覆盖什么、缺什么、哪些仍属 A4-3～5；KICKOFF 只引用该 disposition，不能自行覆写权威层级。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/a4-h2-diagnostics/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF-a4-2.md:75-85` — 设计分叉未穷举可行方案，且三案都只讨论把对象塞进 `AttemptDiagnostic.data`。遗漏至少一条独立路线：把完整终止／GOAWAY 证据存为有类型、版本化的 History artifact/payload，仅让 dispatch diagnostic 保存稳定引用与摘要；它可同时避免 History 直接耦合 transport object，也避免 C 的同一标量双写。修复：补替代方案表，逐项以 A4 的 detail/export、richest-data-flow、schema 演进、查询需求及证据保留为判据比较，并经裁决后才开始实现。

## 主观建议

无。
