# Refusal 抑制：剩余任务追踪

> 状态：**执行中**（2026-07-28 起）。分支 `feat/refusal-diagnostics`（worktree `.worktrees/refusal-diagnostics`）。
> 设计源：[docs/spec/2026-07-27-refusal-diagnostics-and-typing.md](../spec/2026-07-27-refusal-diagnostics-and-typing.md)（§5 穷尽接线表、§6 测试策略、§8 blocker）。
> 评审记录：同目录 `-review-architect.md` / `-review-adversarial.md`。取证：[exp/refusal-samples/FINDINGS.md](../../exp/refusal-samples/FINDINGS.md)。

## 已完成

| 提交 | 内容 |
|---|---|
| `f66fe5a5` | spec 定稿 + 三份评审 + 取证报告 |
| `5b421ad7` | 纯逻辑层：provenance 解析 / 诚实 thinking tokens / `isContentlessRefusal` 改名 / 新占位符 / 去谎报默认文案 |
| （本批） | **默认翻成 `end_turn` 抑制** + B-1 合成 `message_stop` + B-2 请求级不可变策略快照 + B-3 driver 终态门 + accumulator 收 `stop_details` + `RefusalPolicy` 叶子（解 SCC）|

验证基线：`typecheck` 干净；`unit+it+http` 6490 pass / 14 fail，**14 个全是 history-search sidecar**（stash 掉本改动后基线同样失败——缺 Rust 二进制，本机 rustup 未配 toolchain，属既有环境问题）。两条新不变量均通过 mutation control。

## 待办（按执行顺序）

### ~~T1 —— 修聚合口径：`failed` + `upstreamSucceeded` 的双计~~ ✅ 已完成

**问题**（对抗评审第三轮发现）：抑制模式下请求终态是 `failed`，但上游腿诚实地记 `success:true`。遥测 sink 按 upstream success 判定，会把一个 `request.failed` 记成成功；History stats 会让**同一请求同时递增 success 与 failure**。

**为什么排第一**：它现在就在污染真实运维数据，且与已落地的 verdict 解耦直接相关。

**判据**：一个抑制掉的 refusal 请求，在 `/api/stats` 与 History stats 中**只**计入失败侧一次；上游腿仍诚实显示 `success:true`（两个概念不得互相覆盖）。不得静默改变既有 `successCount` 的上游腿语义——若要区分，新增独立 measure。

**触点**：`src/lib/observability/sinks/telemetry.ts`、`src/lib/history/stats.ts`。

**落地方式**：`stats.ts` 抽出纯函数 `requestBucket()`——互斥性变成**结构性保证**（单一返回值）而非四个并列 `if` 恰好维持的性质；遥测 sink 的 `success` 改读**请求裁决**（`event.kind === "request.completed"`）而非上游腿。上游腿健康度仍在 History entry 上可观测，两个概念不再互相覆盖。守卫 `tests/history/stats-verdict-buckets.unit.test.ts`（6 pass），已过 mutation control：把 `failed` 分支改回旧的 OR 语义 → 2 条变红。

### T2 —— 双轮 session CLI oracle

**问题**：现有 CLI e2e 只证明单次 `claude -p` 正常退出且不空转，**没证明同一 session 的后续用户轮还能继续**——而「不中断对话轮次」正是本次改动的**首要目标本身**。目前该目标缺少直接 oracle。

**判据**：真 `claude` CLI，同一 session：第 1 轮命中被抑制的 refusal → 第 2 轮用户消息仍能正常得到回复；断言 `num_turns` 与最终 `result` 非空，且不出现「继续」空转。

**触点**：`tests/e2e-client/anthropic-cli.e2e.test.ts` + `tests/e2e-client/harness/cli-refusal-hook.ts`（后者的注释仍写「thinking-only」，一并改）。

### T3 —— `stop_details` 无损贯通到 History

accumulator 已收（#1 完成），剩 spec §5 表的 #2–#11：streaming builder、**非流式 inline builder**（不经 builder）、`ResponseData`、`PartialResponseInfo`、`fail()` 两支 + `abort()` 三个重建点、`legFromUpstreamResponse`、canonical `responseMetadata`（显式枚举，不会自动带新字段）、V3 projection 类型 + 输出白名单、`HistoryUpstreamResponseData` / 公开 `UpstreamResponseData` 锁步双 owner。

**判据**：每种 settle 形态（complete / proxy-introduced fail / 普通 fail / abort / 非流式）都有 projection 测试证明 `stop_details` 落盘后可读回；**不得**用归一化视图替代 raw 存储。

### T4 —— 消费面（诊断真正对人可见）

否则 D2 的目标不闭环——用户仍要去 raw SSE 挖 category。

- TUI 完成行结构化 token（`refusal:cyber` / `refusal:uncategorized`）——注意失败行当前**刻意**不显示 stop reason，需专门加。
- History 详情（`entry-view` 派生 + `ui-v4` Meta/Response 段）展示 category + explanation，保留 raw JSON 视图。
- 遥测 `refusal_category` 维度（**capped** 非 bounded——上游是开放字符串，已观测 `cyber`/`bio`/`null`）。
- `recordFeature` detail `{category}`（**不**把 category 拼进 `FeatureKind` 枚举，否则每个新类别都要发版）。
- 跨协议翻译降级留痕：Anthropic→CC 映射成 `content_filter`、→Responses 映射成 `incomplete_details.reason`，两者都丢 category；History/遥测须保真并打可辨识降级标记。

### T5 —— 收尾

- 改写 [docs/refusal-recovery.md](../refusal-recovery.md)（现状契约仍写「thinking-only」「默认 error」，已与代码不符）。
- skill `ghc-anthropic-upstream` 症状表那一行同步。
- backlog 记入未采纳的**代理侧 fallback 重试**（spec §3.2，含 CC 源码位置与上游 explanation 的建议）。
- 合并态 subagent 复审（跨 T1–T4 的集成缝）→ 合回 master 前 `git log --oneline master..` 查 peer。

## 纪律备忘（本轮踩过）

- **每条 Bash 都显式 `cd` 到 worktree**：shell cwd 被重置过一次，相对路径险些写进主树（主树有 peer 未提交改动）。
- **绝对断言先跑基线**：判定「这批失败与我无关」必须 stash 后实测，不能凭感觉。
- **一次就绿的不变量测试必须 mutation control**。
