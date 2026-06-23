# RFC — Anthropic 改写命名/位置 coherence 重组

> 状态：ACCEPTED（2 轮对抗 review + 实测修订；OQ1-4 已裁决，见 §10）
> 范围层级（用户 2026-06-22 拍板）：**命名+位置 coherence（请求侧 + 词汇 + config）**，不重写机制、不碰响应侧定义、不跨全格式统一。
> 前置：v4 P0–P3 已落地；response-pipeline Stage A 出口达成、Stage B（driver-owned-writeout）GO 且 in-flight。
> 修订记录：R1（2026-06-22）据架构+回归两路对抗 review 实测修订——import 盘点补全（含测试，§5）、加 strategies 碰撞（§2 #8）、Phase-1 oracle 改正（§9）、§7 暂缓根因改正、Phase 4 成本据实重估（34 键×4 面，§6）、加 word-boundary/atomic-move/compat 往返防护（§8）。

## 1. 动机

当前 Anthropic 改写散落多处、词汇混用、存在文件名碰撞，定位"某条改写在哪"需跨目录 grep + 读注释排除误导。这是 v4 迁移把 legacy 代码 lift 进 driver 适配器时未收拢归宿留下的疤痕组织。机制本身健康、测试充分——本 RFC **只动命名/位置/配置人体工学，不动算法核、不动 driver 机制**。

价值轴（[[feedback-architecture-map-optimize-agent-context-economy]]）：布局价值 = Agent 上下文经济 + 可信度（无碰撞/无误导/无漂移死条目）。

## 2. 现状盘点（8 项债，均经实测核验）

| # | 问题 | 性质 | 实测证据 |
|---|---|---|---|
| 1 | `request-rewrites.ts` ×2：[codec/anthropic](../../src/lib/codec/anthropic/request-rewrites.ts)（env 适配器）vs [anthropic](../../src/lib/anthropic/request-rewrites.ts)（payload 链）同名异层 | 真实 | **活证据**：`codec.ts` 同文件同时 import 两者（`./request-rewrites` 的 `createAnthropicSanitizeRewrite` + `~/lib/anthropic/request-rewrites` 的 `runAnthropicRequestRewrites`） |
| 2 | `sanitize.ts` + `sanitize/` 目录同 stem；`sanitize.ts` ×2（anthropic + openai） | 真实 | `find src -name sanitize.ts` |
| 3 | 两层类型 `AnthropicRequestRewrite`(payload) vs `RequestRewrite`(env) 概念重影 | 真实**但有理由** | payload 层被 web_search 旁路（`orchestrator.ts:52`、`web-search-direct.ts:65`）独立复用 → **不可 collapse**，只改名澄清 |
| 4 | module-global `REQUEST_REWRITES`/`RESPONSE_REWRITES` 故意为空数组，grep 陷阱 | 真实 | DESIGN 已需注"别去 registry 找改写" |
| 5 | 改写散落 `codec/anthropic/`+`anthropic/`+`anthropic/sanitize/`+`request/strategies/`，无单一归宿 | 真实 | §1 盘点 |
| 6 | 词汇 sanitize/rewrite/preprocess/prepare/transform/strategy 六词混用、不映射到阶段 | 半真实 | rewrite/prepareStep/strategy 是文档化的**不同概念**，问题是词不对阶段 |
| 7 | config `anthropic.*` 扁平混装请求/响应/feature（**34** 键） | 真实但 user-facing | schema.ts `AnthropicConfigSchema` |
| 8 | `strategies.ts` ×3（`codec/{anthropic,openai-cc,openai-responses}/strategies.ts`）+ `request/strategies/` 目录同 stem 异概念（codec 侧 per-format 组装 vs request 侧 retry 实现） | 真实（review 补盘，与 #1 同构） | `find src -name strategies.ts` |

**更正**：`sanitize_tool_names` 顶层标量是**正确的**——跨 Anthropic+CC+Responses 三路（schema.ts 注释 "cross-protocol" + DESIGN 佐证），**不移入 anthropic.***。

## 3. 已确认的非问题（不动，避免 speculative surface）

均实测属实，不该动：
- **prepareWire B1–B12**（[request-preparation.ts](../../src/lib/anthropic/request-preparation.ts)）是 `PrepareStep` 非 RequestRewrite（design.md 明确排除：per-attempt 重入 + `betaProbe.recordOutbound` 副作用）。
- **空 registry + deps 注入**是刻意 per-request 装配模型，只改名让 grep 落到解释，不改机制。
- **两层 payload/env**（#3）不 collapse（旁路复用约束）。
- **响应侧改写定义文件**（`codec/anthropic/response-rewrites.ts`）——见 §7 暂缓（时序，非文件硬冲突）。

## 4. 目标词汇表（钉死，写入 coding-conventions.md）

| 词 | 精确含义 | 阶段 | 载体 |
|---|---|---|---|
| **Rewrite**（Request/Response） | driver registry 装配、env 级、声明式 order | S3 / S5 | `pipeline/rewrite-registry.ts` 接口（既有 v4 术语） |
| **PayloadRewrite** | 格式原生（pre-env）改写模块；**被 S3 包装 _或_ 被 bypass 直接调用** | S3 之下 / bypass | `anthropic/payload-rewrites.ts` |
| **PrepareStep** | per-attempt wire 整形 + 副作用，**非 rewrite** | S4-pre | `request-preparation.ts`（既有 v4 术语） |
| **Strategy**（Retry） | 错误驱动反应式 re-rewrite + 重试 | S4 重试环 | `request/strategies/*`（实现）+ `codec/*/strategies.ts`（组装） |
| **sanitize** | 一条**具体** PayloadRewrite（消息清洗），**不再作伞形动词** | — | `anthropic/sanitize/` |

`PrepareStep`/`Strategy` 是复述既有 v4 术语（自洽）；`PayloadRewrite` 是本 RFC 新引入的伞形词，需同步该层全部导出符号命名（见 §5 M1 修订）。砍掉：`sanitize` 不再泛指改 payload；`preprocess` 收窄到 tool；`transform` 仅指 registry 逐帧函数名（内部）。

## 5. 逐文件 rename/move 映射（Phase 1-2，请求侧）——**含全部 importer（src + tests）**

| 当前 | 目标 | importer（实测全量） | 注意 |
|---|---|---|---|
| `codec/anthropic/request-rewrites.ts` | `codec/anthropic/request-rewrite-adapter.ts` | `codec.ts:96`（1） | 该文件自身 import 下一行的 payload 文件 → 两 rename 撞同一文件，**原子或排序** |
| `anthropic/request-rewrites.ts` | `anthropic/payload-rewrites.ts` | `codec.ts:78`、`web-search-direct.ts:65`、`codec/anthropic/request-rewrites.ts:31` + **测试 2**（`tests/anthropic/request-rewrites.it.test.ts:32`、`tests/pipeline/request-rewrite-registry.it.test.ts:40`）= **5 处**（RFC 原称 2，证伪） | **测试文件名亦镜像源 stem**，须同步改名免漂移 |
| 该文件全部导出符号 | `AnthropicRequestRewrite`→`AnthropicPayloadRewrite`、`ANTHROPIC_REQUEST_REWRITES`→`ANTHROPIC_PAYLOAD_REWRITES`、`assembleAnthropicRequestRewrites`→`assembleAnthropicPayloadRewrites`；**`runAnthropicRequestRewrites` 保留**（3 src+2 test importer，且"run…Rewrites"读得通）或一并改 `runAnthropicPayloadRewrites` | 同上 | **`sed` 须 `\b` 锚定**：`AnthropicRequestRewriteDeps`（codec 侧**不同**类型）含子串，裸 sed 会误伤 |
| `anthropic/sanitize.ts` | `anthropic/sanitize/index.ts` | 外部 13 importer 路径**不变**（`~/lib/anthropic/sanitize` 经 index 解析，`moduleResolution:"Bundler"`）；**但文件内 14 行 `./sanitize/*` 自引用 + barrel re-export 须改写为 `./*`** | **必须单 commit 原子移动**（删旧建新同 commit），否则中间态 `"./sanitize"` 歧义半坏；`sed` 须锚定避免误伤 `./sanitize-xxx` |
| `pipeline/rewrite-registry.ts` `REQUEST_REWRITES`/`RESPONSE_REWRITES` | `BUILTIN_REQUEST_REWRITES`/`BUILTIN_RESPONSE_REWRITES` + "empty by design" doc | **非"全格式 importer"**（证伪）——实测仅 `driver.ts`、`rewrite-registry.ts`、`tests/pipeline/{rewrite-registry.unit,response-rewrite-contract.unit}.test.ts`、`codec/anthropic/request-rewrites.ts` 共 5 文件 | **`\b` 锚定**：`ANTHROPIC_REQUEST_REWRITES`/`ANTHROPIC_RESPONSE_REWRITES`/`RESPONSES_RESPONSE_REWRITES` 共 15 处含子串，裸 sed 全毁 |

**归宿收拢（#5 请求半边）**：上述后请求侧形成清晰两层——`request-rewrite-adapter.ts`（env 适配，driver facing）↑ 包 `payload-rewrites.ts`（payload 链）↑ 编排 `sanitize/*` + `message-tools.ts`。DESIGN「活的架构现状」表加指针行。

**strategies 碰撞（#8）**：本 RFC **不改** strategies 文件（响应侧 retry 与请求侧重组正交，且改动会扩面到其它格式），仅在 §4 词汇表澄清 Strategy 的两载体（实现 vs 组装），并记入 §7 暂缓——待跨格式统一时连同处理。

## 6. config 重组（Phase 4，user-facing）——OQ3 定为**扁平 per-concern 重命名**

`anthropic.*` **34 键**按关注点前缀统一改名，**不嵌套**（键仍 `anthropic.foo`）。`sanitize_tool_names` 留顶层（§2 更正）。前缀方案：`thinking_*`（coerce/block/signature_compat）、`tool_*`（search/dedup/non_deferred/recover_call_text/decode_*/strip_*/rewrite_history_server）、`cache_control`、`context_editing_*`（已分组）、`system_*`（messages_sanitize/rewrite_reminders）。具体 34 键映射表在实现时定（约束：concern-prefix、flat、1:1）。

**扁平选择的成本（~1×，远低于嵌套）**：
1. **schema** 34 键改名（仍 `.strict()` 平铺）
2. **`config.ts:applyConfigToState`** 58 处 `a.<field>` **1:1 改名**（非嵌套那样 `a.x`→`a.group?.x` 的结构改写）
3. **compat.ts** 34 个 `renameLeaf("anthropic.old","anthropic.new")` 1:1
4. **hot-reload 矩阵** `configKey` 字符串 1:1 更新

**silent-strip 防护仍强制**（[[feedback-pass-null-clean-not-self-validating]]）：扁平虽无嵌套放大，但漏一个 `renameLeaf` 仍会让旧键落入 `.strict()` 被静默丢弃。故每个改名键一条 **compat 往返测试**（旧 yaml in → 断言新 state 值 out），34 键全参数化。hot-reload 完整性守卫只证"新键在矩阵"、**不证 compat 映射存在**，故往返测试不可省。Phase 4 **不得**把跨 section 键（shutdown/openai_responses）误并进 anthropic。

## 7. 暂缓项的最终处置（已落定，无遗留）

| 原暂缓项 | 处置 | 理由 |
|---|---|---|
| **响应侧改写重组**（#5 响应半边） | **DONE（Phase 3）**：`codec/anthropic/response-rewrites.ts` → `response-rewrite-adapters.ts`，镜像 `request-rewrite-adapter.ts`。Stage B 全 5 格式 owns-sink 落定后解锁。**实测响应侧无请求侧那种硬债**（无文件碰撞、无两层类型重影、footgun 已 Phase 2 修、算法核已良好命名），故 Phase 3 仅一处 cosmetic 对称 rename。 | 纯命名对称；2 功能消费者；逐字节等价 |
| **跨全格式统一**（曾含 strategies ×3、`openai/sanitize.ts`、`codec/openai-responses/response-rewrites.ts`） | **撤销（非真债）** | **该统一的契约层早已统一**（`RequestRewrite`/`ResponseRewrite` 接口 + driver registry 装配 = format-agnostic 核心），**不该统一的逻辑层格式专属是正确的**（各格式改写操作各自协议帧，合并=假抽象）。同 stem 出现在**不同格式目录**（`codec/anthropic/strategies.ts` vs `codec/openai-cc/strategies.ts`）是**好的平行结构**（同角色不同格式），非碰撞——碰撞特指**同 dir 内**两同名文件（请求侧 `request-rewrites.ts ×2` 那种真陷阱，已 Phase 1 修）。强行跨目录起异名反破坏平行性。按 YAGNI + "纯主观无缺陷风格偏好跳过"撤销。 |

## 8. Phase 拆分 + commit invariants

每个 commit 终态不半坏（[[methodology-commit-invariants]]）；纯 rename/move + import 更新，算法核零改；**所有脚本化 rename 用 `\b` word-boundary**（防子串误伤，见 §5）。

- **Phase 0** — 本 RFC + 对抗 review（已 2 轮）+ 解 OQ。Invariant: 无代码改动。
- **Phase 1** — 请求侧 rename/move（#1 #2 #3 #5请求半边）+ **同步改对应测试文件名/import**。每 commit `bun run typecheck` + Phase-1 oracle（§9）绿；`sanitize.ts→index.ts` **单 commit 原子**。Invariant: ① 等价（请求改写输出不变）② **`bun run test:backend` 收集用例数不减**（防测试静默不被收集，[[methodology-probe-harness-must-match-prod]]）。
- **Phase 2** — registry `BUILTIN_*` 改名 + 词汇钉入 coding-conventions（#4 #6）。可并入 Phase 1 尾。Invariant: 全格式 typecheck 绿。
- **Phase 4** — config 重组（#7）。Invariant: **每键 compat 往返测试绿**（旧扁平 yaml → 新 state 值）+ hot-reload 矩阵完整性守卫绿 + 无跨 section 误并。
- **收尾** — 同步 DESIGN 现状表 + 配置表 + coding-conventions + memory。

（Phase 3 = 响应侧，**DONE**：Stage B 落定后解锁，仅一处 cosmetic 对称 rename，见 §7。）

## 9. 验证策略——Phase-1 oracle 改正

回归 oracle（[[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]]）按 phase 各异：

- **Phase 1（请求侧）正确 oracle** = `tests/anthropic/request-rewrites.it.test.ts`（byte-lock `runAnthropicRequestRewrites` vs 手写组合）+ `tests/pipeline/request-rewrite-registry.it.test.ts`。**注**：原 RFC 误引 `response-rewrite-golden.http.test.ts` 作 Phase-1 oracle 是**类别错误**——那是**响应侧** golden，Phase 1 不碰响应侧。请求 oracle 是 self-consistent（import 同一子函数），只能锁编排顺序、不锁算法——对"算法核零改"的纯 rename **恰好够用**，但不可当 wire oracle 过度声称（[[feedback-self-consistent-needs-independent-oracle]]）。
- **Phase 4（config）oracle** = 每键 compat 往返测试 + hot-reload 完整性守卫。
- 改前先在旧代码上跑通 oracle（[[methodology-golden-fixture-pre-capture]]）。全 Anthropic 套件（messages.http / thinking-signature / tool-name-sanitize / recover-tool-call / dedup / system-messages / server-tool-rewriting）作宽 oracle 兜底。

## 10. Open Questions — 已裁决（用户 2026-06-22）

- **OQ1 ✓ 纳入本 RFC**：registry 空常量 `BUILTIN_*` 改名（5 文件，`\b` 锚定安全），直接解 #4 footgun。
- **OQ2 ✓ 不移**：`payload-rewrites.ts` 留 `anthropic/` 顶层（它还编排 `message-tools.preprocessTools`，非纯 sanitize）。
- **OQ3 ✓ 扁平 per-concern 重命名**：config 键**不嵌套**，仍 `anthropic.foo`，按关注点前缀统一改名（`thinking_*`/`tool_*`/`cache_control`/`context_editing_*`/`system_*`）。`renameLeaf` 1:1、`config.ts` 1:1、成本 ~1×、**无嵌套 silent-strip 放大**（仍每键 compat 往返测试兜底）。具体 34 键映射表在 Phase 4 实现时定（约束：concern-prefix、flat、1:1）。
- **OQ4 ✓ 函数名一并改**：`runAnthropicRequestRewrites`→`runAnthropicPayloadRewrites`，求类型/函数/常量全一致（多 5 importer churn，可接受）。
