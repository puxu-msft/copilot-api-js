# Refusal 抑制：剩余任务追踪

> 状态：**执行中**（2026-07-28 起）。分支 `feat/refusal-diagnostics`（worktree `.worktrees/refusal-diagnostics`）。
> 设计源：[docs/spec/2026-07-27-refusal-diagnostics-and-typing.md](../spec/2026-07-27-refusal-diagnostics-and-typing.md)（§5 穷尽接线表、§6 测试策略、§8 blocker）。
> 评审记录：同目录 `-review-architect.md` / `-review-adversarial.md`。取证：[exp/refusal-samples/FINDINGS.md](../../exp/refusal-samples/FINDINGS.md)。

## 已完成

| 提交 | 内容 |
|---|---|
| `f66fe5a5` | spec 定稿 + 三份评审 + 取证报告 |
| `5b421ad7` | 纯逻辑层：provenance 解析 / 诚实 thinking tokens / `isContentlessRefusal` 改名 / 新占位符 / 去谎报默认文案 |
| `6eb04733` | **默认翻成 `end_turn` 抑制** + B-1 合成 `message_stop` + B-2 请求级不可变策略快照 + B-3 driver 终态门 + accumulator 收 `stop_details` + `RefusalPolicy` 叶子（解 SCC）|

| `12212856` | 请求计数口径：`requestBucket()` 结构性互斥 + 遥测 `success` 改读请求裁决（T1）|
| 本批 | `docs/refusal-recovery.md` 改写为现状契约（旧文写「thinking-only」「默认 error」，已与代码不符）|

验证基线：`typecheck` 干净；`unit+it+http` 6495 pass / 14 fail，**14 个全是 history-search sidecar**（stash 掉本改动后基线同样失败——缺 Rust 二进制，本机 rustup 未配 toolchain，属既有环境问题）。两条新不变量均通过 mutation control。

## 待办（按执行顺序）

### ~~T1 —— 修聚合口径：`failed` + `upstreamSucceeded` 的双计~~ ✅ 已完成

**问题**（对抗评审第三轮发现）：抑制模式下请求终态是 `failed`，但上游腿诚实地记 `success:true`。遥测 sink 按 upstream success 判定，会把一个 `request.failed` 记成成功；History stats 会让**同一请求同时递增 success 与 failure**。

**为什么排第一**：它现在就在污染真实运维数据，且与已落地的 verdict 解耦直接相关。

**判据**：一个抑制掉的 refusal 请求，在 `/api/stats` 与 History stats 中**只**计入请求失败侧一次；`successCount` / `failureCount` 明确表达互斥的客户端请求裁决。上游腿仍诚实显示 `success:true`，并以独立的 `upstreamLegSuccessCount` measure 恢复可聚合健康度；两个概念不得互相覆盖。

**触点**：`src/lib/observability/sinks/telemetry.ts`、`src/lib/history/stats.ts`。

**落地方式**：`stats.ts` 抽出纯函数 `requestBucket()`——互斥性变成**结构性保证**（单一返回值）而非四个并列 `if` 恰好维持的性质；遥测 sink 的 `success` 改读**请求裁决**（`event.kind === "request.completed"`）而非上游腿，同时把 committed upstream response 的 `success` 投影为独立 `upstreamLegSuccessCount`。该 measure 经开放 counters bag、内存泛型投影、SQLite additive outbox / rollup / readback 全链贯通，旧库打开时幂等补列，无持久版本 bump。守卫 `tests/history/stats-verdict-buckets.unit.test.ts` 覆盖互斥请求裁决，`tests/observability/thinking-block-metrics.unit.test.ts` 覆盖 sink→registry 双信号，`tests/telemetry/dual-write.unit.test.ts` 覆盖 SQLite 持久化。

### ~~T2 —— 双轮 session CLI oracle~~ ✅ 已完成

**问题**：现有 CLI e2e 只证明单次 `claude -p` 正常退出且不空转，**没证明同一 session 的后续用户轮还能继续**——而「不中断对话轮次」正是本次改动的**首要目标本身**。目前该目标缺少直接 oracle。

**判据**：真 `claude` CLI，同一 session：第 1 轮命中被抑制的 refusal → 第 2 轮用户消息仍能正常得到回复；断言 `num_turns` 与最终 `result` 非空，且不出现「继续」空转。

**触点**：`tests/e2e-client/anthropic-cli.e2e.test.ts` + `tests/e2e-client/harness/cli-refusal-hook.ts`（后者的注释仍写「thinking-only」，一并改）。

**实测结论**：真 Claude Code CLI 2.1.220 通过显式 UUID `--session-id` 建立第 1 轮、再用 `--resume <同一 UUID>` 发第 2 轮。第 1 轮上游是零 content block、无 `message_stop` 的 contentless refusal，代理抑制后返回非空 recovery text；第 2 轮上游返回正常标记文本。两轮 CLI 均回报同一 `session_id`、`num_turns=1`、`is_error=false`、退出码 0 且 stderr 为空；第 2 轮 `result` 含 `SECOND_TURN_OK_MARKER`，证明 suppression 后同一 session 可继续，未进入“继续”空转。命令 `bun test tests/e2e-client/anthropic-cli.e2e.test.ts`：3 pass / 0 fail（22 assertions）。mutation control 临时禁用 recovery text 合成后，单轮正样本与双轮测试第 1 轮均按预期从 `num_turns=1` 变为 2（2 fail / 1 pass）；恢复生产代码后重新 3/3 通过。另尝试“仅移除合成 `message_stop`”时测试仍绿，因为当前 driver 在识别 contentless refusal 后以其为 terminal boundary，未触发依赖 SDK EOF 的失败；本 oracle 因而直接咬住首要用户行为机制（非空 recovery text），`message_stop` 的字节级正控仍由 refusal terminal invariant 测试负责。

### ~~T3 —— `stop_details` 无损贯通到 History~~ ✅ 已完成

accumulator 已收（#1 完成），剩 spec §5 表的 #2–#11：streaming builder、**非流式 inline builder**（不经 builder）、`ResponseData`、`PartialResponseInfo`、`fail()` 两支 + `abort()` 三个重建点、`legFromUpstreamResponse`、canonical `responseMetadata`（显式枚举，不会自动带新字段）、V3 projection 类型 + 输出白名单、`HistoryUpstreamResponseData` / 公开 `UpstreamResponseData` 锁步双 owner。

**判据**：每种 settle 形态（complete / proxy-introduced fail / 普通 fail / abort / 非流式）都有 projection 测试证明 `stop_details` 落盘后可读回；**不得**用归一化视图替代 raw 存储。

**落地方式**：字段以 raw `unknown` 形态从 `buildAnthropicResponseData` 与 `handler-v4` 非流式 inline builder 进入 `ResponseData.stopDetails`；`PartialResponseInfo`、`fail()` 的 `upstreamSucceeded` / 普通两支及 `abort()` 重建点逐支复制；`legFromUpstreamResponse` 与 canonical `responseMetadata` 显式枚举；V3 `recordToHistoryEntry` 白名单输出；`HistoryUpstreamResponseData` 与公开 `UpstreamResponseData` 锁步增加同名字段。`tests/history/refusal-stop-details-projection.it.test.ts` 通过真实 canonical terminal → V3 SQLite → readback → projection 覆盖 complete / proxy-introduced fail / 普通 fail / abort，`tests/anthropic/response-rewrite-golden.http.test.ts` 覆盖 streaming 与非流式 handler；三个 expected 均手写自一手样本，另在 builder 测试放入未来字段 `recommended_model` 证明未压扁。mutation control 临时删除 V3 输出白名单后 4/4 settle 测试按预期变红，恢复后 4/4 转绿。

### T4 —— 消费面（诊断真正对人可见）——后端部分已完成

否则 D2 的目标不闭环——用户仍要去 raw SSE 挖 category。

- ✅ 后端：TUI 失败完成行从最终 upstream leg 的 `stopReason` + raw `stopDetails` 派生结构化 token（`refusal:cyber` / `refusal:uncategorized`），不恢复被刻意隐藏的普通 stop reason，也不把完整 explanation 塞进单行。
- ✅ 前端并行任务：`resolveRefusalDetail()` 复用 `extractRefusalDetail()` / `isNamedCategory()`，把命名类别、上游显式 `null`（`uncategorized`）与字段缺失（`unknown`）保留为三种 provenance；Meta 段只给 category 快速扫描，Response 段在 upstream leg 前放独立 `Refusal diagnostic (upstream)` 块，逐字展示完整 explanation，并用 `RawJsonView` 保留含未来字段的原始 `stopDetails`。不把诊断继续压进 `failureReason`。
- ✅ 后端：遥测新增 `refusal_category` 维度；非 refusal 返回 `null`，refusal 的命名类别逐字保留，其余归 `uncategorized`；registry 明确标成 **capped**，允许上游未来新增开放字符串。
- ✅ 后端：`refusal-recovered` / `refusal-errored` / `refusal-passthrough` 三个既有 feature 均携带 `{category}` detail，不把 category 拼进 `FeatureKind`。共享 `refusalCategoryForDiagnostics()` 复用 `extractRefusalDetail()` / `isNamedCategory()`，避免各消费面重写判据。
- ✅ 后端：实码查证 Anthropic→CC 非流式和流式都把 `refusal` 映射为 `finish_reason:"content_filter"`；Anthropic→Responses 两条路径都映射为 `status:"incomplete"` + `incomplete_details.reason:"refusal"`。四条翻译路径均新增 out-of-band `translated-refusal-category-dropped` feature marker（detail `{category,target}`），客户端 wire 仍保持目标协议合法形状。查证时另发现三个 reverse `@messages` 非流式 route builder 未把 raw `stop_details` 写入 History；已在 Chat Completions / Responses / Gemini 三处同步补齐，防止翻译 marker 可见而后端原始事实反而丢失。

后端 mutation control 分两层：翻译器内部的 `onDegradation` 触发测试此前已临时摘掉对应逻辑并按预期变红；但该结果不能证明 codec→`RequestContext.recordFeature()` 的接线。合并态复审发现接线层原本零测试后，新增 `tests/codec/refusal-degradation-marker-wiring.unit.test.ts`，逐格覆盖 CC/Responses × 流式/非流式，并临时摘掉 `src/lib/codec/openai-{cc,responses}/codec.ts` 三处回调接线，四条测试均按预期变红，恢复后 4/4 转绿。TUI token、feature detail、`refusal_category` extractor、reverse CC 非流式 History 保真各自的既有 mutation control 结论不变。最终全量验证见本节后续提交记录。

### T4.1 —— 合并态 HIGH：reverse `@messages` 非流式 refusal 裁决统一 ✅ 已完成

合并态复审确认 Chat Completions / Responses / Gemini 三条 reverse `@messages` 非流式 route 只以 `anthropicNonStreamingTruncation(stop_reason)` 决定 fail/complete；`"refusal"` 是有效终止符，导致 contentless refusal 被 `ctx.complete()`，产生 History / stats / telemetry / TUI 与 refusal 诊断互相矛盾的成功口径。

本批复用 `recover-refusal.ts` 的 `isContentlessRefusalResponse()`（其内部唯一复用 `hasClientVisibleContent()`），三条 route 命中时统一用 `refusalSummary()` 作为 failureReason，记录 `refusal-passthrough`，并以 `{upstreamSucceeded:true}` 保持上游 200 腿 `success:true`。`tests/routes/reverse-contentless-refusal.it.test.ts` 对三条真实 HTTP 路径逐条断言请求 `failed`、feature、failureReason、raw `stopDetails` 与上游成功；初始 RED 为 3/3 收到 `completed`，实现后 3/3 GREEN。mutation control 临时摘掉三处 settle gate 后 3/3 重新收到 `completed` 并变红，恢复后重新转绿。架构守卫 `circular-deps-ratchet` 通过；共享谓词留在已有 rewrite 模块，没有向零依赖叶子 `refusal-detail.ts` / `refusal-policy.ts` 引回依赖。

本批没有实现 reverse 非流式的客户端抑制，只闭合裁决口径；完整跨协议 suppression 已同步记入 `docs/refusal-recovery.md` 已知缺口与 `docs/todo/deferred-backlog.md`。

### ~~T5 —— 收尾~~ ✅ 已完成

- 改写 [docs/refusal-recovery.md](../refusal-recovery.md)（现状契约仍写「thinking-only」「默认 error」，已与代码不符）。
- skill `ghc-anthropic-upstream` 症状表那一行同步。
- backlog 记入未采纳的**代理侧 fallback 重试**（spec §3.2，含 CC 源码位置与上游 explanation 的建议）。
- 合并态 subagent 复审（跨 T1–T4 的集成缝）→ 合回 master 前 `git log --oneline master..` 查 peer。

## 纪律备忘（本轮踩过）

- **每条 Bash 都显式 `cd` 到 worktree**：shell cwd 被重置过一次，相对路径险些写进主树（主树有 peer 未提交改动）。
- **绝对断言先跑基线**：判定「这批失败与我无关」必须 stash 后实测，不能凭感觉。
- **一次就绿的不变量测试必须 mutation control**。

---

## 收官（2026-07-28）

**已合并回 master**：`d108366b merge: contentless refusal suppression`。

合并态验证：`typecheck` 干净、`unit it http` **6553 pass / 0 fail**（此前一路当成「既有失败」的 14 条 history-search，在合入 master 的 `skipIf` 改动后变为显式 skip——peer 在 CLAUDE.md 里把这条写成了纪律：**环境性的红太容易被当成既有失败挥手放过**，那次就是本轮）；`typecheck:ui-v4` + 563 vitest + `build:ui-v4` 全绿。

合并冲突两处，均按**行级共存**解：
- `docs/DESIGN.md`：取我方 refusal 行（默认 `end_turn`）+ master 的 `streamCommitAfterSec=180`。
- `docs/todo/deferred-backlog.md`：两边新条目都保留，**用脚本验证合并结果恰好等于两边条目并集**（128 = 126 + 126 − 124 共有，零丢失）。

主树 peer 有未提交的 `docs/memory/MEMORY.md`，按文档化流程处理：备份到 `/tmp` → 带可辨识 message 的选择性 stash（验证栈深 3→4）→ FF → pop（栈深回 3）→ **逐条验证两边改动都在、零冲突标记**。peer 原有的 3 个 stash 未被触碰。

第四轮合并态复审的 2 条 HIGH 与 MED-1/2/3/6/7/8 均已闭合；MED-4/5 与 LOW-1..5 记档在复审报告，未做。
