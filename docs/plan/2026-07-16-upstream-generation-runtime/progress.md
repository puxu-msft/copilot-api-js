# Upstream Generation Runtime Progress

- 2026-07-17：History V3 已合并 master；分支已 merge master（`6d569b23`），`bun run typecheck` 绿色。
- 2026-07-17：P0-T1 完成。新增五条 live route→driver→sink frame-order golden；初始空 expected 与删除 terminal mutation 均精确红，恢复后 10 连跑全绿，typecheck 绿。独立 reviewer PASS（0 blocker）。
- 2026-07-17：P0-T2 完成。锁定 synthetic scaffold、三类 open-block heartbeat、buffered recovery cadence、exhausted/nonretryable terminal、client-abort 与 terminal 后零 heartbeat。Mutation 精确红；独立 reviewer PASS，修复 FakeClock install 未清残留 timer 的 MEDIUM 后全绿。
- 2026-07-17：P0-T3 完成。新增 transport cleanup fault oracle：pending HTTP/2 headers 与 pending SSE frame 的 active-resource 正样本及现状 green cleanup、WS before-first-event wake/busy 释放、adaptive limiter 全局 queue/backoff cleanup；零生产 seam／零生产行为改动。三条已亲跑精确红后转 `test.todo` 留给 P5：per-candidate queued admission 取消、429 backoff 取消、WS loser abort 后旧远端迟到帧污染同 conversation 新 queue（实测新 iterator 收到 `resp_late_from_loser` 而非 `resp_new`）。
- 2026-07-17：P0-T3 独立 reviewer PASS（0 blocker/major）。确认正样本有牙、green 路径均走真实生产原语、三条 todo 对应真实现状缺口；P5 计划已显式要求原地解锁转绿。
- 2026-07-17：Phase 0 独立 verifier PASS（0 blocker/major）。Mutation 删除 terminal 精确红；P0 测试 5 连跑稳定；零生产改动；History V3 arena/egress/terminal oracle有效。Phase 1 可启动。
- 2026-07-17：P1-T1/T2 完成。新增 raw-frame additive envelope/protocol contracts 与 inert CandidateStateFactory；RED 为模块缺失，GREEN 7 pass/48 expect/100% lines。独立 reviewer首轮3 HIGH均已修（四opaque factory fail-fast、terminal boundary矩阵、无requestState路径），复审PASS（0 blocker/major）。
- 2026-07-17：P2-T1 完成。`runResponse` 委托单次 branch-local `ResponseProcessor`，V3 capture/rewrite/render/flush迁入且wrapper不双采样；五格式golden、rewrite cascade、buffered-anchor时序全绿。Reviewer首轮发现额外async-generator微任务回归、TS与capture测试缺口，均修复后复审PASS（0 blocker/major）。
- 2026-07-17：P2-T2 完成。Responses HTTP/WS fallback、Gemini direct/reverse、CC reverse、Anthropic translate 的 closing frames与truncation分类进入 processor自然流末finish；fallback buffered盲区解除，handler post-loop flush旁路归零。59项相关测试+typecheck绿；reviewer blocker（默认outcome形状污染）与buffered finish不对称均修后复审PASS。
- 2026-07-17：P3-T1 完成。新增 generation-owned delivery session、单写者serializer与post-wire ClientBlockLedger；只从真实sink writes推进、跨upstream recovery保持identity/ledger、winner隔离。Reviewer首轮2 major（平行frame类型、缺monotonic write time）及测试缺口均修，复审PASS。
