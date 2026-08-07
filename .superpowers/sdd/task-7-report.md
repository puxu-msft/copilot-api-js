# Task 7 实施报告

## 状态

- 状态：实现与验证完成，待提交。
- 起始 SHA：`6d4314817c0492019477e04a8f25b4864e39f6fb`。
- 目标提交：`feat: record HTTP2 dispatch termination snapshots`。

## 实施结果

- `/home/xp/src/copilot-api-js/.worktree/agent-abfcda647aa10a966/src/lib/transport/http2-observation-types.ts` 成为 Task 8／10 复用的唯一 serializable schema，定义 `TransportTerminationSnapshot`、`GoawaySnapshot`、`GoawayEventSnapshot`、`GoawayProtocolViolation`、`EvidenceCapture`、泛型 `GoawaySnapshotSource`／`GoawayFreezeResult` 与 `Http2TerminationCommitPort`；未反向导入 operation lease 实现。
- `/home/xp/src/copilot-api-js/.worktree/agent-abfcda647aa10a966/src/lib/transport/http2-termination.ts` 实现 ordinary-zero default source、无 callback／无 snapshot store 的 local commit port，以及只依赖 commit port 的 first-terminal recorder。Snapshot 在 observer 前递归冻结；observer 异常被隔离。
- `/home/xp/src/copilot-api-js/.worktree/agent-abfcda647aa10a966/src/lib/transport/http2-client.ts` 为每个 physical request 建 local port／recorder，接入 headers、trailers、end、error、close-before-end、body cancel、post-response abort 与 physical close 冷路径。DATA callback 保持 `req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))` 逐字不变。
- `/home/xp/src/copilot-api-js/.worktree/agent-abfcda647aa10a966/src/lib/transport/upstream-fetch.ts` 仅新增 `onTermination` observer option。
- 未接 RequestContext、生产 GOAWAY ledger 或 History leases；stream-first／session-first shared violation 的动态证明按独立 verifier 边界留给 Task 8＋10。

## 红绿证据

- 编辑前基线硬门：`git merge-base --is-ancestor 6d4314817c0492019477e04a8f25b4864e39f6fb HEAD` 退出码 0；`git rev-parse HEAD` 输出 `6d4314817c0492019477e04a8f25b4864e39f6fb`，无需 fast-forward。
- RED：`bun test tests/transport/http2-termination.unit.test.ts` 退出码 1；失败来自新模块 `~/lib/transport/http2-termination` 不存在，确认测试先于生产实现。
- GREEN：`bun test tests/transport/http2-termination.unit.test.ts tests/transport/http2-client.it.test.ts` 最终为 `47 pass, 0 fail, 113 expect() calls`。
- `bun run typecheck` 退出码 0。
- `bunx eslint src/lib/transport/http2-observation-types.ts src/lib/transport/http2-termination.ts src/lib/transport/http2-client.ts src/lib/transport/upstream-fetch.ts tests/transport/http2-termination.unit.test.ts tests/transport/http2-client.it.test.ts` 退出码 0；仅打印依赖 `baseline-browser-mapping` 数据陈旧提示，无 lint error／warning。
- `git diff --check` 退出码 0。

## DATA AST guard 与四类 mutation

被测对象边界是 `http2-client.ts` 中唯一 `req.on("data", ...)` callback 的 AST body；guard 要求恰好一个 callback，且 body 精确等于 `controller.enqueue(new Uint8Array(chunk))`。

四次 mutation 均先构造仅含目标变异的 exact patch，`git apply --check` 后注入，测试红后先执行 `git apply --reverse --check`，再反向应用同一冻结 patch恢复；每次失败均来自 AST guard 的 expected／received body 差异：

1. 时钟：注入 `Date.now()`，红。
2. 对象：注入 `{ chunk }`，红。
3. copy：改成 `chunk.slice()`，红。
4. callback：注入 `init.onStreamClosed?.()`，红。

恢复后再次运行 clean guard，最终包含在 `47 pass` 中；`git diff` 显示 DATA 行仅为 context，无修改。

## Ownership 三控

1. 首次成功：local port 先 CAS，再 freeze／builder 各一次；recorder 在 port 返回 true 后 observer 恰一次。测试同时验证 observer 在模拟 `controller.close` 前发生。
2. 拒绝／second terminal：local port second write 返回 false；freeze／builder计数保持一次，拒绝路径 observer 零次；late close／second terminal不改 snapshot。
3. observer throw：recorder catch 隔离；模拟 close 仍执行，模拟 error 仍抛原始 body error，而不是 observer error。

额外覆盖 ordinary-zero exact union、nested snapshot freeze、UTF-8 code-point bounded text、循环对象 cancel reason never-throw、remote error 不获得 local-cancel provenance，以及真实 h2c body cancel／post-response signal abort 来源区分。

## Self-review

- 更好的内部替代方案：没有采用让 local port 保存 snapshot 或调用 observer的捷径，因为这会产生双 owner／双 observer；现有 builder closure 符合冻结接口并允许 Task 10 原位替换 port。
- 判据判别力：正样本 clean callback 通过，四种独立错误状态均红；ownership 同时检查 successful 与 rejected 两方向，避免只证 false-green 或只证 false-red。
- 成熟第三方方案：serializable union、CAS ownership 与 recorder 是项目域契约，不适合引入第三方状态机；UTF-8 截断使用平台 `TextEncoder`／`TextDecoder`，未手写 byte decoder。

## 结构怪味扫描

- `src/lib/transport/http2-client.ts:1093`，怪味类型：trailers 观测此前被 `init.onTrailers` callback 条件化，导致“是否存在外部 callback”与“transport 是否观测事实”职责耦合。处置：本轮修复，始终监听并先更新 recorder，外部 callback仍仅在配置时运行。
- `src/lib/transport/http2-termination.ts:118`，怪味类型：若只冻结顶层 snapshot，会泄漏 nested mutable aliases并允许 observer late mutation。处置：本轮修复，集中 `freezeSnapshot()` 深冻结 schema 全部嵌套对象／数组。
- `src/lib/transport/http2-client.ts:1030`，怪味类型：Task 7 local port是有意的过渡实现，Task 10 会替换为 RequestContext port；当前若再并列持有 source会形成双 owner。处置：本轮不提前接 Task 10；recorder只持 port，local port独占 default source，并在未决事项中明确替换点。

## 未决事项

- Task 8 实现 real session GOAWAY ledger／dispatch source，并导入本任务唯一 schema。
- Task 10 用 RequestContext port 替换 per-request local port，并完成 stream-first／session-first shared violation、operation lease 与 History 接线。
- 未启动或终止 4141；未 push。
