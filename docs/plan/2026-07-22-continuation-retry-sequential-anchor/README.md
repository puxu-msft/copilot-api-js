# 续写重试 + 顺序 anchor — 实施计划总览（README）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec:** [`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md`](../../spec/2026-07-22-continuation-retry-and-sequential-anchor.md)（已获批）+ [ADR](../../decisions/2026-07-22-continuation-retry-sequential-anchor.md)。前身/底座 spec：[`2026-07-11-block-level-buffered-retry`](../../spec/2026-07-11-block-level-buffered-retry.md)（已 landed，本计划完成其 Anthropic 未竟部分并反转 partial-degrade 终局）。冲突以本 spec 为准。

**Goal:** 首块 commit 后被 mid-stream `NGHTTP2_CANCEL` 掐断的流式生成（如 incident req_162 的 tool_use 截断）→ 用合成 continuation 轮续写救回；同时用 CLI-safe 的**顺序 anchor** 让 Anthropic 块级默认 on（完成前 spec 未竟部分）、CC/Responses-WS 升块级、彻底退役整响应缓冲。

**Architecture:** 两块承重重写 + 三新单元 + 五 PoC 门。① **顺序 anchor**（`keepalive-anchor.ts` 的 `ANCHOR_INDEX=0`+固定 `remap(,1)` 模型 → 运行时递增 index 分配，anchor 穿插 0/2/4…、任一时刻单块 open）取代 CLI-unsafe 的 coexist。② **续写 driver 分支**（`driver.ts:1283` `!committedAny` 硬门旁加平行分支：committedAny 且 continuation 可行且预算未耗 → append 语义的新 exchange 接同一 sink，非 buffer-replay）。三新单元：`committed-blocks-ledger`（已 commit 块快照数据源）、per-format `continuation-request-builder`（合成 assistant+user 轮）、CC `cc-commit-boundaries` 升块级（index 跳变/text→tool 边界重建）。

**Tech Stack:** TypeScript / Bun（`bun test`）+ node:http2 上游 / Hono SSE + WS / consola。测试 = `bun run test:fast`（单元+http 快速档）/ `test:backend`（交付前全后端，见 CLAUDE.md 测试分档）；后端单例隔离见 skill `test-isolation`；PoC 探针放 `exp/`（poc-first）；客户端 wire oracle 用真实 `@anthropic-ai/sdk`/`openai` SDK（skill `client-proxy-e2e-testing`）；mock 上游用四点 hook（skill `upstream-hook-mocking`，契约 `export const hooks = { exchange }`——旧 `onExchange` 已废）。

---

## Global Constraints（每任务隐含包含，逐字来自 spec/CLAUDE.md）

- **无向后兼容负担**：删 `protect_streaming_generation` 的 whole-response 语义；Anthropic 块级不可用回退 **live**（非 whole）。旧键一次性迁移、允许短期报错、不留双轨。
- **命名铁律**（YAML 标量/map 不冲突）：`buffered_retry` 恒为 map；续写子块 `buffered_retry.continuation.{enabled,message}`，per-vendor 覆盖 `<vendor>.buffered_retry.continuation.*`；解析优先级 per-vendor > 共享 > 内置默认。
- **不改算法核**：`response-rewrite-adapters.ts:8`「Algorithm cores are NOT rewritten」——recover-tool-call/decode 的缓冲释放逻辑不得改。
- **合成物必打 `synthetic:"continuation"` 标记**（richest-data-flow ADR）：合成 assistant/user 轮进 `attempts[].upstreamRequest`（忠实字节）但打标记；**绝不污染上游原始轨** `upstreamResponse.sseEvents`。
- **persistence-async-invariants**：ledger 快照在 committed settle 点冻结；`onAttemptReset` 不清 ledger（跨 attempt 累积的已承诺前缀）；失败尾帧 settle-前-record。
- **protect-user-main-server**：绝不碰 4141;测试服务器起在非 4141 端口、按 PID 精确清理。不跑 `bun run start/dev`;可跑 `typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -- <精确路径>`），conventional commits，无模型署名。
- **执行环境**：隔离 worktree `.worktrees/continuation-retry`（分支 `feat/continuation-retry`，从 master），durable ledger `.superpowers/sdd/progress.md` = 权威进度。

## 相位 DAG（gate-first：门先跑，架构重写门后展开）

```
G  PoC 门簇（先跑，定可行性 + 决定实现分支）
   ├ G1 顺序 anchor 代理产出侧（wire 抓包 oracle：代理能否产出 0/2/4… 穿插 anchor）
   ├ G2 顺序 anchor 300s 死线重置（>300s 长-idle 真 CLI）
   ├ G3 Anthropic 已-commit-完整-tool_use-块作前缀（上游是否接受）
   ├ G4 CC index 串行性（真实并行 tool_call 流；先验风险偏高）
   ├ G5 CC tool_calls 尾随约束 + Responses prior-output 续写形状
   ▼
P0 机制地基（新单元接口 + 配置 continuation 子块 + outcome 分类 + telemetry 双计数；纯新增、默认行为不变）
   ▼
P1 顺序 anchor index 分配重写（承重①）── 取代 ANCHOR_INDEX=0 固定 +1；G1/G2 门产出决定分支
   │  完成前 spec 未竟：Anthropic 块级 CLI-safe、默认 on
   ▼
P2 续写 driver 状态机分支（承重②）── committed-blocks-ledger + committedAny 旁路 append 分支 + 共享预算保底
   ▼
P3 Anthropic 续写（continuation-request-builder[anthropic] + 缝合流 SDK oracle）── 治 incident
   ├────────────┬────────────┐
   ▼            ▼            ▼
P4 Responses   P5 CC 升块级   P6 Responses-WS
  HTTP 续写      (边界重建     升块级 + 续写
 (builder 复用)  + 续写)       (WS 传输门)
   ▼
P7 退役 whole + 默认翻转 + doc-sync + ADR 定稿
```

- **门先于承重**：G1（代理产出）/G2（300s）FAIL → P1 顺序 anchor 需换形状或 Anthropic 回退 live（incident 目标须重议）；G3 FAIL → Anthropic 续写限 text-only 前缀场景；G4 FAIL → CC 块级边界判据须换（非 index 跳变）；G5 各自决定 CC/Responses 续写可行性。
- **P0 必先落**（定义 P1-P6 共用接口 + 配置 + outcome/telemetry）。
- **P1、P2 是两块承重、串行**（P2 续写依赖 P1 的 index 分配产出续写块 index）。
- **P3 独立于 P4-P6**；P4/P6 共用 Responses continuation-builder；P5 独立（CC 边界重建）。
- **P7 收口**：默认翻转必在对应门 PASS 之后的 commit（绝不先翻默认再验证）。

## 冻结契约（单一事实源，跨任务引用）

| 符号 | 类型/签名 | 归属任务 |
|---|---|---|
| `CommittedBlocksLedger` | `{ snapshot(): CanonicalBlock[]; recordCommitted(block): void; reset 不清 }` | P0 |
| `ContinuationRequestBuilder` | `(original: RequestEnvelope, committed: CanonicalBlock[], message: string) => UpstreamRequest` per-format | P0 接口 / P3-P6 实现 |
| `allocAnchorIndex` / 递增 offset | `AnchorIndexAllocator`:`nextAnchorIndex()`/`nextRealIndex()`/`realBlockOffset(upstreamIndex)`/`onAnchorOpen()`/`onRealBlockOpen()`（取代 `ANCHOR_INDEX=0` + 固定 `remap(,1)`） | P1 |
| 续写 outcome | `continuation-exhausted` + `partial-degrade`(兜底) | P0 |
| 配置 | `buffered_retry.continuation.{enabled:true, message:"network issue. please continue"}` | P0 |
| 预算 | 共享 `max_retries=3`，续写保底 1 次 | P0/P2 |

## 参考

- 承重架构点：`src/lib/anthropic/keepalive-anchor.ts:16`（ANCHOR_INDEX）、`src/lib/pipeline/driver.ts:1095/1142/1283`（remap/committedAny 门）、`src/lib/anthropic/live-reconcile.ts:132`、`src/lib/openai/cc-commit-boundaries.ts`、`src/lib/openai/stream-accumulator.ts:114-131`（toolCallMap）。
- PoC 先例：`exp/block-level-anchor-sequential/`（G1/G2 骨架起点）、`exp/block-level-anchor-coexist/`（对照）、`exp/cc-idle-280s`（300s 死线基线）。
- 测试骨架：`tests/e2e-client/harness/{spawn-proxy,drive-claude-cli}.ts`、`tests/e2e-client/anthropic-buffered.it.test.ts`（SDK oracle 先例）。
