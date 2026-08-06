# Commit -1 final implementation report

## Integrated execution state

Commit -1 T0.0a/b/c/e is complete in the integration execution tree `/home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1` at HEAD `3b5ac1e41d87ab089becd55afe38f788643a4390`. Earlier agent worktrees named below are historical execution locations only; they are not current state sources.

Final integrated evidence supplied by the coordinator: `bun run test:backend` on that HEAD ran unit/it/http in 16 shards with `6728 pass，0 fail，6915 executed，26 skipped，36.68s`. `bun run typecheck` is green. Focused canonical capture `bun test tests/history/v3/canonical-performance.unit.test.ts --rerun-each=20` is green. These numbers supersede all earlier branch-local backend counts.

## Plan completion

- [x] T0.0a：实际 shard JUnit identity 与 runtime file identity 对账。
- [x] T0.0b：executed/skipped 与 strict testcase/suite skipped identity multiset；已退役不再成立的 V2 FIFO skip。
- [x] T0.0c：runner artifact transfer、producer、v1 discovery baseline、manifest atomicity，及 post-balance／reporter／collection target mutations。
- [x] T0.0e：validator C1～C11、receipt v1、EV-01～EV-28 synthetic fixtures 和 runtime closure provenance。
- [x] Commit -1 integrated gates：focused controls、typecheck、format/diff checks 和 backend。
- [ ] whole-branch merged-state review。
- [ ] 将 Commit -1 merge 到 `master`。

T0.0f、T0.0d、真实 A/P/P receipt 消费与 T0.1 都是 `master` merge 后的独立阶段，不是 Commit -1 未完成项；本阶段没有生成或消费真实 future A/P evidence。

## TDD、mutation 与历史证据

早期 parser、baseline schema、producer 和 validator 均按 RED→GREEN 落地。target mutations 保留为实现鉴别力证据：runner 的 post-balance bucket drop、reporter-only refresh、collection drop；validator C1～C11/EV-01～EV-28 arms；PTY raw/cooked 与 startup condition；同 entry summary WeakMap hit removal；以及 canonical capture sealed-arena quadratic traversal。每项 mutation 均使用 exact patch，reverse-check 后 reverse apply，未整文件恢复共享树。

历史 wall-clock flake 未删除：`canonical-performance.unit.test.ts` 曾在 backend contention 下收到 `sseRatio=8.5025`／`10.3039`，而 standalone 同类运行可以通过。这不是 runner identity 回归。当前它由 deterministic recorder-work gate 替代：4× conversation 为 `101→389`（`3.8515×`），4× SSE 为 `1029→4101`（`3.9854×`）；生产 sealed-arena quadratic mutation 分别为 `14.9093×` 与 `15.9530×`，均精确变红。wall-clock 输出仅保留为诊断。

## Structural-smell scan

- `scripts/parallel-test.ts:121-235` — artifact producer 与 shard result 可能漂移。处置：本轮以原子 JUnit/runtime/skipped artifacts 与 producer/validator independent reparse 修复。
- `scripts/capture-entry-evidence.ts:147-217`、`scripts/validate-entry-evidence.ts:292-429` — trust policy 两处实现。处置：保留为刻意的独立 evidence legs；validator 不信 manifest 自述，最终合并态审查该接缝。
- `scripts/validate-entry-evidence.ts:92-357` — dynamic runtime dependency drift。处置：ENTRY_SHA closure provenance 在 receipt 前阻断，并有 helper mutation。
- `tests/shutdown/fixtures/two_signal_pty.py:13-67` — log 被误当 lifecycle readiness。处置：以 READY 和 terminal lflag condition gate 修复。
- `src/lib/history/in-flight.ts:42,108,148` — test observer 泄漏。处置：已纳入 shared resetter，same/fresh instance deterministic tests 覆盖。
- `src/lib/context/model-operation-record.ts:595-613,811-813` — observer 与 recursive freeze algorithm 漂移。处置：仅一个 production recursive primitive，并有 source-shape guard。

扫描范围是 runner／producer／validator／shutdown／history observers；判据为重复算法、职责错位、同源弱 oracle、module-global test leakage、动态 import drift、condition/log readiness 混淆。未发现上述处置之外的新结构怪味。

## Reflection

- 更好的内部替代：复用 runner artifacts、canonical recorder 和 shared resetter，不建立第二套性能或 evidence pipeline。
- 判据判别力：关键 gate 均有 target mutation；正确状态与错误状态分别经 exact patch green/red 验证，且 current capture gate 明确不覆盖 fixture 未变化的 metadata/extensions/headers 或 dispatch/candidate/transform copy paths。
- 成熟第三方方案：没有为 Bun-stable JUnit shape 或 narrow recorder work count 引入 XML parser/profiler；前者没有复杂 XML 需求，后者会带回 sampling/scheduling 噪声。若将来引入 namespace/CDATA input 或新的 capture scaling axis，需重新评估。

## Current action

先执行 whole-branch merged-state review，review 无 blocker/major 后 merge Commit -1 到 `master`；只有 merge 后才能开始真实 T0.0f/T0.0d/P/T0.1。
