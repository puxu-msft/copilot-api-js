# Responses ↔ Anthropic Semantic Bridge Implementation Plan

> **状态**：草稿，待独立评审
>
> **核验基线**：`2c9b5d6688c4c2d267d951647e0187224654a55c`（2026-08-07）
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 OpenAI Responses ↔ Anthropic Messages 的请求、非流式响应和流式响应双向语义桥，使已知结构实际处理、展示降级与续接状态分离、未知结构显式失败，并让 whole／stream 共用一份语义决策。

**Architecture:** 在现有 CellAssembly 与 `hub-translate.ts` 的 per-pair 接缝内引入静态 typed semantic bridge。纯 semantic handlers 产出 request decision 或 presentation／continuation 双平面 decision；protocol adapters 与 target renderers 分别拥有 source lifecycle 和目标 wire grammar；driver 只拥有 candidate、retry、commit、错误阶段与 History 投影，不重新解释领域语义。

**Tech Stack:** TypeScript 5.9、Bun、Hono SSE、OpenAI SDK 6.45 `ResponseAccumulator`、Anthropic SDK 0.106 `.finalMessage()`、现有 History V3／candidate runtime。

**权威规格：** [`docs/spec/2026-08-06-responses-anthropic-semantic-bridge.md`](../../spec/2026-08-06-responses-anthropic-semantic-bridge.md)

## Global Constraints

- Identity 路径不进入 semantic bridge；未知结构原样透传。只有 non-identity translation profile 使用 fail-loud。
- 支持集合以四张方向表为单一事实源：Anthropic→Responses request／response、Responses→Anthropic request／response。
- Presentation 与 continuation 是正交平面；`presentation:degraded` 不授权丢 continuation。
- Request bridge 发生在 S2、candidate 创建前；request diagnostics request-level 冻结一次。Response bridge state 与 diagnostics candidate-local；顶层只投影 winner。
- Strategy 判断语义并返回 typed result；driver 管调度、预算、retry、commit、candidate 和观测，不在 driver 复制 semantic matcher。
- Responses 流跨事件以 `output_index`／协议 `call_id` 关联；不得以会逐事件变化的 opaque `item.id` 关联。
- Anthropic 流保留 content block `index`；不得强行改造成 Responses envelope。
- `BridgeCompatibilityError.retryable === false`，必须在 transport／semantic／continuation retry 之前分流。
- Target Responses emitter 必须通过官方 OpenAI SDK accumulator；Anthropic wire 必须通过官方 Anthropic SDK `.finalMessage()`。项目自有 accumulator 不是唯一 oracle。
- 真 GHC 仅用于 mock 无法证明的物理接受性；所有测试服务器使用非 4141 端口、独立 History，并按精确 PID 清理。
- 不新增依赖；优先使用现有 OpenAI／Anthropic SDK、`safe-stable-stringify` 和项目既有 primitives。
- 每个实现 task 遵循 TDD：先红、核对失败机制、最小实现、绿、目标 mutation、精确 pathspec commit。
- 默认验证：目标 unit／it／http → `bun run typecheck` → 精确 eslint；每阶段收口跑 `bun run test:backend`。客户端行为另跑对应 `tests/e2e-client/*.it.test.ts`。
- 不主动 push，不触碰 4141 主服务器，不用 `git add -A`／`git add .`／`git commit -am`。

## 实施前恢复协议

每个 phase 的 implementer 在首个产品改动前创建独立进度文件：

```text
docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-<slug>.md
```

`<slug>` 使用 kebab-ASCII，例如 `p1-core`、`p4-web-search`。Frontmatter 必含：任务起始 SHA、分支、worktree 绝对路径、对应 plan 文件、agent/session id。每个实现 commit 必须同时更新并提交该进度文件，只记录 git 无法表达的三类信息：剩余项及验收、在途意图、已作废路径。相位完成后把持久结论折回对应 plan，并把 progress 标为已归档／已被正式计划取代。

## 文件职责图

### 新建核心目录

| 文件 | 单一职责 |
|---|---|
| `src/lib/semantic-bridge/types.ts` | 双平面 decision、emission、request outcome、affinity、typed error-facing contracts |
| `src/lib/semantic-bridge/request.ts` | source group／ordinal、branded ordering、top-level capability patches、payload assembly |
| `src/lib/semantic-bridge/lifecycle.ts` | protocol-neutral lifecycle algebra、typed handler factories、router、exactly-once／flush invariant |
| `src/lib/semantic-bridge/continuation.ts` | versioned carrier envelope、collector、affinity comparison；不拥有协议展示 |
| `src/lib/semantic-bridge/diagnostics.ts` | request freeze collector、candidate response collector、canonical hash 与 disposition types |
| `src/lib/semantic-bridge/index.ts` | 只 re-export 公共 contract，不包含业务逻辑 |
| `src/lib/error/bridge-compatibility-error.ts` | `BridgeCompatibilityError` class、type guard、结构化字段 |

### 新建 pair profile 目录

| 文件 | 单一职责 |
|---|---|
| `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts` | P4 起创建；Anthropic source unions、已迁 family registries、最终 profile composition |
| `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts` | P4 起创建；Responses source unions、已迁 family registries、最终 profile composition |
| `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts` | P3 以空集合惰性接入，P4–P7 按 kind 在 semantic 与 legacy 二选一；P7 全量切换后删除 |
| `src/lib/openai/translate/semantic-bridge/responses-adapter.ts` | Responses source lifecycle → algebra；按 `output_index` 关联 |
| `src/lib/openai/translate/semantic-bridge/anthropic-adapter.ts` | Anthropic source lifecycle → algebra；按 block `index` 关联 |
| `src/lib/openai/translate/semantic-bridge/responses-renderer.ts` | 目标 Responses whole／SSE grammar，不作 semantic disposition |
| `src/lib/openai/translate/semantic-bridge/anthropic-renderer.ts` | 目标 Anthropic whole／SSE framing，不作 semantic disposition |
| `src/lib/openai/translate/semantic-bridge/families/*.ts` | 每个 semantic family 的业务映射；不得调 transport、driver 或 History |

### 现有集成点

- `src/lib/pipeline/hub-translate.ts`：选择并驱动 profile；不放业务 matcher。
- `src/lib/pipeline/request-state.ts` 与 `generation/candidate-state.ts`：携带 frozen request diagnostics 引用及 candidate-local response supplies。
- `src/lib/pipeline/generation/candidate-response-session.ts`：拥有 candidate response collector 的创建、freeze 与 snapshot。
- `src/lib/context/{types,request}.ts`、`src/lib/history/types.ts`：append-only disposition SSOT、winner-only 顶层投影与持久化。
- `src/lib/pipeline/driver.ts`：S2 request collector `try/finally`、compatibility fail-fast、winner 投影时点；不判断 semantic kind。
- `src/routes/{messages,responses}/handler-v4.ts`：headers-uncommitted HTTP error 与 headers-committed typed terminal wire。
- 旧 `src/lib/openai/translate/*anthropic*responses*.ts`：按 family 原子迁移后删除对应分支；不长期双轨。

## 阶段 DAG

```text
P0 实证门 ───────────────┐
P1 semantic core ────────┼─→ P2 request engine ─→ P3 pipeline/history/error
                         │                         │
                         └─────────────────────────┴─→ P4 Web Search
                                                     └─→ P5 reasoning
                                                          └─→ P6 function/custom tool
                                                               └─→ P7 remaining known + unknown fail-loud
                                                                    └─→ P8 merged-state + docs + rollout
```

- P0 与 P1 可并行；P2 依赖 P1；P3 依赖 P1/P2。
- P4 是第一个生产 family，依赖 P0–P3；P5–P7 共改 registries／renderers，严格串行，不并行写同一 profile。
- 每个 family 的 handler、whole、stream、reverse echo、diagnostics 和旧分支删除必须同一 commit 落地。
- P8 只有在 P4–P7 全部完成后运行，负责合并态复核，不自动启动额外 scope。

## 阶段导航

| 阶段 | 文件 | 可独立交付物 |
|---|---|---|
| P0 | [`plan-0-empirical-gates.md`](plan-0-empirical-gates.md) | continuation／carrier／capability 的实测裁决与实验资产 |
| P1 | [`plan-1-semantic-core.md`](plan-1-semantic-core.md) | 行为未接生产的纯 semantic core、类型／mutation／架构守卫 |
| P2 | [`plan-2-request-engine.md`](plan-2-request-engine.md) | ordered request + capability registry + 四张 request 方向表 |
| P3 | [`plan-3-pipeline-history-error.md`](plan-3-pipeline-history-error.md) | request/candidate diagnostics、typed error、retry／commit 路由 |
| P4 | [`plan-4-web-search.md`](plan-4-web-search.md) | Web Search request／whole／stream／continuation／Claude Code E2E |
| P5 | [`plan-5-reasoning.md`](plan-5-reasoning.md) | 多 reasoning、encrypted-only、双向 carrier 与 affinity |
| P6 | [`plan-6-function-tools.md`](plan-6-function-tools.md) | function arguments 三源裁决、custom declaration／choice／output |
| P7 | [`plan-7-remaining-and-unknown.md`](plan-7-remaining-and-unknown.md) | message/citation/refusal/server-tool results/terminals 与 unknown fail-loud |
| P8 | [`plan-8-closeout.md`](plan-8-closeout.md) | 全 population audit、History API、文档同步、merged-state review |
| 启动 | [`kickoff.md`](kickoff.md) | 新会话可复制入口 |

## Commit invariants

1. **行为中性地基**：P1–P3 不接生产 semantic family；现有 wire goldens逐字不变。
2. **无半迁移 family**：从 P4 起，每个已注册 family 同一 commit 具备 request／whole／stream／reverse echo／diagnostics，并删除该 family 的旧分支。
3. **过渡 owner 单轴**：P3 以空 `migratedKinds` 惰性接入 `migration-dispatch.ts`；P4–P7 对每个 source kind 精确选择 semantic 或 legacy，禁止同 kind 双跑、先 semantic 再 fallback、或两个结果合并；未迁 kind 只走 legacy。P7 全量迁移后同 commit 删除 dispatcher，并把 legacy shell 收敛为 thin wrappers。
4. **未知策略单轴**：production unknown fail-loud 只在 P7、全部首批 family 已迁移后启用；此前 core 与fixture-local profiles只在测试中运行，production仅通过过渡dispatcher接管已迁family。
4. **观测不丢**：request dispositions 在 candidate 前冻结一次；所有 candidate response records 保留；顶层只投影 winner。每个 commit 后 History V3 terminal store/API readback 都可解释当前状态。
5. **错误不重放**：一旦 `BridgeCompatibilityError` 被观测，之后 dispatch 增量为 0，当前 candidate 不进 recovery／continuation；合法前置 retry／hedge 不被抹除。
6. **客户端 wire 合法**：任何修改 Responses／Anthropic SSE emitter 的 commit 都必须同时通过 byte-golden 与真实 SDK oracle。

## 测试真相域

- **unit/property**：handler decisions、ordering、capability patches、carrier codec、lifecycle router、target grammar。
- **`.it`**：hub／CellAssembly／candidate response session／RequestState fork／History V3 接线。
- **`.http` golden**：客户端实收 bytes、HTTP status、typed terminal、dispatch call count。
- **client-e2e**：OpenAI SDK accumulator、Anthropic SDK `.finalMessage()`、Claude Code WebSearch 外层 agent-loop。
- **真 GHC**：只验证 opaque continuation／capability 的真实接受性；不能替代 mock 覆盖。

## 总验收映射

| 规格 AC | owner 阶段 |
|---|---|
| AC1–AC3 | P1–P3，P8 population audit |
| AC4、AC8–AC10、AC14 | P1、P4、P5 |
| AC5–AC7、AC11 | P0、P4 |
| AC12、AC17 | P3、P7 |
| AC13、AC16 | P3、P8 |
| AC15 | P1、P4–P7 type-level fixtures |
| AC18 | 每阶段 mutation；P8 汇总 |
| AC19 | P4–P7 family cutover |
| AC20 | 每阶段 `test:backend`；P8 client E2E |
| AC21 | P1 target grammar、P5/P6 emitters |
| AC22 | P2 request ordering |
| AC23 | P6 function lifecycle |
| AC24 | P0 capability裁决、P2 registry |

## 不采用方案

- **把 semantic bridge 放进 S3／S5 rewrite registry**：阶段错误；它处理 target wire，不拥有 source→target semantic。
- **把业务 handler 做成可关闭外部 hook**：协议正确性不能依赖配置／热重载。
- **继续扩张现有六个 translator 文件**：whole／stream／request 将继续复制 disposition；本计划按 shared family handler 收敛。
- **全局万能 IR**：重复现有 Envelope／codec 职责；只建桥接所需窄 emission。
- **一次性全量切换**：unknown fail-loud 会先误拒尚未迁移的合法结构；采用 family 原子迁移。
