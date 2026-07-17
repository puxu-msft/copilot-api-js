# Upstream Generation Runtime Progress

- 2026-07-17：History V3 已合并 master；分支已 merge master（`6d569b23`），`bun run typecheck` 绿色。
- 2026-07-17：P0-T1 完成。新增五条 live route→driver→sink frame-order golden；初始空 expected 与删除 terminal mutation 均精确红，恢复后 10 连跑全绿，typecheck 绿。独立 reviewer PASS（0 blocker）。
- 2026-07-17：P0-T2 完成。锁定 synthetic scaffold、三类 open-block heartbeat、buffered recovery cadence、exhausted/nonretryable terminal、client-abort 与 terminal 后零 heartbeat。Mutation 精确红；独立 reviewer PASS，修复 FakeClock install 未清残留 timer 的 MEDIUM 后全绿。
- 2026-07-17：P0-T3 完成。新增 transport cleanup fault oracle：pending HTTP/2 headers 与 pending SSE frame 的 active-resource 正样本及现状 green cleanup、WS before-first-event wake/busy 释放、adaptive limiter 全局 queue/backoff cleanup；零生产 seam／零生产行为改动。三条已亲跑精确红后转 `test.todo` 留给 P5：per-candidate queued admission 取消、429 backoff 取消、WS loser abort 后旧远端迟到帧污染同 conversation 新 queue（实测新 iterator 收到 `resp_late_from_loser` 而非 `resp_new`）。
- 2026-07-17：P0-T3 独立 reviewer PASS（0 blocker/major）。确认正样本有牙、green 路径均走真实生产原语、三条 todo 对应真实现状缺口；P5 计划已显式要求原地解锁转绿。
- 2026-07-17：Phase 0 独立 verifier PASS（0 blocker/major）。Mutation 删除 terminal 精确红；P0 测试 5 连跑稳定；零生产改动；History V3 arena/egress/terminal oracle有效。Phase 1 可启动。
- 2026-07-17：P1-T1/T2 完成。新增 raw-frame additive envelope/protocol contracts 与 inert CandidateStateFactory；RED 为模块缺失，GREEN 7 pass/48 expect/100% lines。独立 reviewer首轮3 HIGH均已修（四opaque factory fail-fast、terminal boundary矩阵、无requestState路径），复审PASS（0 blocker/major）。
