# M1 测试判据证伪评审

- 评审范围：commit `6333d800`，重点核验测试迁移是否削弱断言、运行时用例集合、6 格 mutation 鉴别力、类型级负测与双入口心跳时钟。
- 总体 verdict：修复 major 后可进入下一阶段。
- blocker 数量：0。


## A. 迁移是否削掉断言

### A1 `message_stop` 是第一个 terminator

**裁决：覆盖真的丢了（major）。** 改前具名用例 `reconcileLiveFrame :: injected: a `message_stop` before any real block (no message_delta) → [stop@0, message_stop]` 直接驱动 `message_stop` 作为首个 terminator；改后没有等价后继。最接近的 `/tmp/gpt-m1-oracle-review/tests/anthropic/live-pump-terminal-anchor-closeoff.http.test.ts` 用例 `zero-content SUCCESS — a message terminator before any real block → content_block_stop@0 precedes message_delta, NO error frame` 实际输入是 `message_delta + message_stop`，anchor 已被 `message_delta` 关闭，因此没有驱动 `message_stop` 自己的关闭分支。该状态并非结构上不可能：`/tmp/gpt-m1-oracle-review/src/lib/anthropic/live-reconcile.ts:156-157` 仍把 `isMessageTerminator(frame)`（含 `message_stop`）作为 owner close 触发条件，说明生产代码仍明确支持这条输入路径。

### A2 anchor 已由 real block 关闭后再收到 `error`

**裁决：有等价后继。** `/tmp/gpt-m1-oracle-review/tests/pipeline/anchor-allocation-owner.it.test.ts` 的 `closeOpenAnchor passes the allocated index explicitly and is idempotent` 先成功关闭同一 anchor，再调用第二次 `closeOpenAnchor`，断言第二次返回 `"none"`、builder 只观察到一次 index、wire 只有一个 `content_block_stop`；同文件 `wire-torn blocks frontier progress but still closes the already allocated anchor exactly once` 还在 wire-torn 后重复关闭并断言只有一个 stop。关闭幂等已迁到唯一权威 owner，触发帧是 `error` 还是其他关闭者不再改变该性质。

### A3 close-off 经 `writeAnchor` 获得 synthetic marker

**裁决：有等价后继。** `/tmp/gpt-m1-oracle-review/tests/pipeline/live-reconcile-collision.it.test.ts` 的 `pre-response silence injects a synthetic prelude; the live resume reconciles (single message_start, anchor@0, real block@1)` 从真实 live stack 驱动首个 real block，断言 forwarded track 精确包含 `content_block_stop@0#anchor`，并断言 raw wire 顺序。独立 mutation 把 close envelope 的 synthetic kind 从 `anchor` 改为 `keepalive` 后，该用例实际报 `Expected content_block_stop@0#anchor / Received content_block_stop@0#keepalive`，退出码 1；这比原 decorator stub 更直接覆盖 C7。

## B. 运行时用例名集合 diff

用 JUnit reporter 运行时枚举（不是 grep）了 `6333d800^` 与 `6333d800` 的全部 8 个改动测试文件。命令结果：改前 `before=69`，改后 `after=73`，`net=4`，两侧 `skipped=0`。完整后端门另行实跑：父提交 `6824 tests · 6824 pass · 0 fail · 33.69s`；本提交 `6828 tests · 6828 pass · 0 fail · 32.05s`。因此基线 6824→6828 与改动文件的运行时集合净增 +4 一致，未发现被 skip 的测试。

运行时集合新增 13 条：

- `live-reconcile`: `injected + content blocks are remapped while close state stays owner-owned`
- `live-reconcile`: `injected: message terminators pass through while owner owns terminal close`
- `live-reconcile`: `injected zero-content completion leaves stop emission to the owner`
- `live-reconcile`: `injected terminal errors pass through while owner emits the balancing stop`
- `live-reconcile`: `injected without a delivery owner remaps but emits no out-of-owner anchor stop`
- `live-reconcile`: `a bare sink cannot become a second anchor-close authority`
- `anchor-remap-single-authority`: `migration bridge remap predicates are confined to the three not-yet-migrated legs`
- `package-boundaries`: `owner-failure stays pure and legacy anchor state writes stay on the migration allowlist`
- `request-buffered-merge-info`: `persists owner post-commit diagnostics and survives a later full pipeline replacement`
- `anchor-allocation-owner`: `wire-torn blocks frontier progress but still closes the already allocated anchor exactly once`
- `anchor-allocation-owner`: `owner block and anchor-close writes advance the heartbeat activity clock`
- `owner-failure`: `classifies every reachable owner failure without losing committed state`
- `owner-failure`: `OwnerResult excludes committed session-terminating and wire-torn failures`

运行时集合删除 9 条：

- `injected + first content_block_start closes the anchor exactly once (later blocks just +1)`
- `injected: message_delta / message_stop AFTER a real block closed the anchor pass through unchanged (real usage/stop_reason delivered)`
- `injected: a message_delta before any real block (zero-content completion) → [stop@0, message_delta]`
- `injected: a message_stop before any real block (no message_delta) → [stop@0, message_stop]`
- `injected: a terminal error event before any real block → [stop@0, error] (close-off precedes the error)`
- `injected: error after the anchor was already closed by a real block → no second stop@0`
- `injected: write expands the real sequence onto inner; the close-off routes via writeAnchor (synthetic mark)`
- `close-off falls back to inner.write when the inner sink has no writeAnchor`
- `no source file gates a remap on anchorsOpened()`

## C. Mutation 鉴别力

所有 mutation 都在 `/tmp/gpt-m1-oracle-review`（detached `6333d8009e91886947f9165a42a95a3843283727`）完成，每格恢复后以 `git diff --exit-code -- <路径>` 确认生产文件回到基线。

1. **wire-torn close：咬住。** 将 `closeOpenAnchor` preflight 从 `closeUnavailable()` 改回 `ownerUnavailable()`；具名测试 `wire-torn blocks frontier progress but still closes the already allocated anchor exactly once` 实际输出 `owner unexpectedly rejected: wire-torn`，`0 pass / 1 fail`，退出码 1。
2. **heartbeat／`closeOpenAnchor`：咬住。** 删除 close 成功路径的 `lastWriteAtMonotonic = writtenAt`；具名测试 `owner block and anchor-close writes advance the heartbeat activity clock` 实际输出 `Expected: 20 / Received: 10`，退出码 1。
3. **heartbeat／`writeBlockFrame`：咬住且与上一入口独立。** 只删除 block 成功路径的同一更新、保留 close 更新；同一具名测试实际输出 `Expected: 40 / Received: 30`，退出码 1。故只补任一入口都会被另一段断言抓住。
4. **legacy writer allowlist：自报 mutation 咬住。** 将允许写 `anchorClosed` 的集合清空；具名测试 `owner-failure stays pure and legacy anchor state writes stay on the migration allowlist` 报出 `lib/pipeline/delivery/session.ts` offender，退出码 1。
5. **partial-delivery History projection：咬住。** 删除 `mergedPipelineInfo()` 对 `_wirePartialDeliveryInfo` 的投影；具名测试 `persists owner post-commit diagnostics and survives a later full pipeline replacement` 在首次 pipelineInfo 断言即失败，退出码 1。
6. **owner→owner exactly-once：咬住。** 删除 `openAnchorIndex === undefined → "none"` 短路，并让无 index 时再次写 `stop@0`；`closeOpenAnchor passes the allocated index explicitly and is idempotent` 与 wire-torn 用例均输出 `Expected: "none" / Received: "closed"`，`0 pass / 2 fail`，退出码 1。
7. **13 个关闭者漏迁一处：代表性单行 mutation 咬住，但计划要求的通用门不成立（major）。** 把 handler 站点 1 改成同一行 `sink.writeAnchor?.(anchorHooks?.stopFrame(0))`，架构测试报 `routes/messages/handler-v4.ts:anchor-stop`，退出码 1；但等价且合法的多行写法 `const legacyStop = anchorHooks?.stopFrame(0); if (legacyStop) await sink.writeAnchor?.(legacyStop)` 在 `bun run typecheck` 下退出码 0，架构具名测试却 `1 pass / 0 fail`。冻结计划 `/tmp/gpt-m1-oracle-review/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:289,293,336-337` 要求“任意一处改回 legacy 即转红／owner 外零生产写点”；当前 regex 只匹配 `writeAnchor` 与 `stopFrame` 同行，判据可被普通变量提取绕过，不能充当 M1 门。

## D. 类型级负测

**裁决：是真正的类型级负测。** `/tmp/gpt-m1-oracle-review/tests/pipeline/owner-failure.unit.test.ts:53-60` 有两个合法正样本（`session-terminating`、`wire-torn` 均为 `committed:false`）并有两个 `@ts-expect-error` 非法字面量。独立删除两条 `@ts-expect-error` 后运行 `bun run typecheck`，实际得到两条 TS2322：`Type 'true' is not assignable to type 'false'`，退出码 2；恢复后 typecheck 退出码 0。

## E. 心跳时钟鉴别力边界

**裁决：两个入口各自独立可红。** 只破坏 close 入口得到 `Expected 20 / Received 10`；只破坏 block 入口得到 `Expected 40 / Received 30`。该用例不是“任一入口更新即可整体绿”的合并断言。


## 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/anthropic/live-reconcile.unit.test.ts`（改前被删用例；生产分支在 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:63-68,156-157`）— `message_stop` 作为首个 terminator 的关闭行为失去 oracle — 独立 mutation 将 `isMessageTerminator` 从 `message_delta || message_stop` 改为只接受 `message_delta`，完整 `FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` 仍为 `6828 tests · 6828 pass · 0 fail`、退出码 0；现有 zero-content HTTP 测试先发送 `message_delta`，因此无法判别后续 `message_stop` 分支是否存在 — 补一条真实 owner/live-stack 测试，让 injected anchor 后直接收到 `message_stop`，断言 wire 恰有一个 `stop@0` 且它位于 `message_stop` 前；再用上述 mutation 证明转红。

[major] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/tests/architecture/package-boundaries.unit.test.ts:590-610` — “owner 外零 anchor-stop 写点／13 个关闭者漏迁任一处必红”守卫是 spelling-specific 欠近似，未满足冻结计划的 M1 门 — 同行 `sink.writeAnchor?.(anchorHooks?.stopFrame(0))` 会红，但编译合法的变量提取写法 `const legacyStop = anchorHooks?.stopFrame(0); if (legacyStop) await sink.writeAnchor?.(legacyStop)` 在 typecheck 绿的同时让该守卫 `1 pass / 0 fail`；冻结依据见 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:289,293,336-337` — 不再给 regex 补一种拼写；把不变量下沉到能结构性约束写出的能力边界，优先让 raw sink 的 anchor-stop 能力只由 owner 持有，或建立可解析的 owner API allowlist，并用多行变量 witness 走真实扫描入口作正控。

[minor] `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:77-107,146-150` — 注释仍宣称纯 `reconcileLiveFrame` 返回 `[stopFrame, ...]`、翻转 `anchorClosed`，并由 decorator 把该 stop 路由到 `writeAnchor`；实际代码 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:109-130,153-160` 已改为 owner 在 decorator 前置关闭，纯 transform 只 remap 且不碰 `anchorClosed` — 这与 M1 调查结论③及新测试名直接矛盾，会误导 M4 接手者跨已迁移边界再次设计旧机制 — 同步重写函数与 decorator 注释，以 owner close、纯 remap、owner envelope synthetic marker 为唯一现状。

## 主观建议

未提出主观建议。

## 总体结论

- 评审范围：commit `6333d8009e91886947f9165a42a95a3843283727` 的测试迁移与新增 oracle，依据 M1 调查结论①–⑧及进度文件；未修改被评审代码，仅在隔离 scratch worktree 做 mutation。
- 已读取／执行的证据：运行时枚举改前／改后改动测试全集；父提交与本提交完整 unit+it+http 门；6 个要求机制共 7 组 mutation（heartbeat 两入口分开）；类型负测 compile-red；额外做 `message_stop` 全套 mutation 与 guard 绕过 witness。所有 mutation 已恢复。
- 总体 verdict：**修复 major 后可进入下一阶段，不可定稿**。
- blocker 数量：**0**。
- 计数：**major 2，minor 1，nit 0**。
