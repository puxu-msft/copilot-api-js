# Spec：per-model 流超时（stream idle + response header timeout override）

> **实施状态（2026-07-12）**：已落地 master。P1 d7883b05 / P2 b21b10ea / P3 c72e6f31 / P4a e8112c82 / P4b(ADR+守卫)。handler setStreamTimeouts 调用点随并发 commit 00f2a38a 落地（shared-worktree git-add sweep）。

- 状态：草案 v2（并入一轮对抗审查 + coordinator 亲手核验：改正 undici backstop 假前提 BLOCKER、内置默认机制 H1、config schema 集成缺口 H3、读点行号漂移；用户定 D1/D2/D4）
- 日期：2026-07-12
- 归属：`docs/spec/`；配套 plan 落 `docs/plan/`。§7「为何不需要 transport backstop 耦合」升为拟 ADR（若采纳落 `docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md`）
- 相关：
  - 实测根因：`exp/ws-upstream-keepalive/REPORT.md`「2026-07-12 — GHC 服务端 WS idle 计时器」小节
  - 现有承重结论：`docs/spec/2026-07-09-codex-responses-tier1-hardening.md` R5.3、`docs/plan/2026-07-09-codex-responses-tier1-hardening/plan-4-upstream-keepalive.md` Task 4.2
  - per-model config 范式：`src/lib/anthropic/per-model-config.ts`（`findMostSpecific`）、`src/lib/models/resolver.ts`（`normalizeModelKeyedRecord`）、`src/lib/config/schema.ts`（`RECORD_MERGE_STRATEGIES`）、`model_overrides` 的 bundled+user per-key merge 先例
  - 传输路由事实（BLOCKER 核验源）：`src/lib/transport/upstream-fetch.ts:66-69`（https→h2、http→undici）、`src/lib/transport/http2-client.ts:149`（`sock.setTimeout(0)`）、`src/lib/fetch-utils.ts:24`（`createResponseHeaderTimeoutSignal`）
  - config 哲学：`docs/memory/feedback-config-philosophy-separate-compat-and-warn-continue.md`
  - richest-data-flow ADR：`docs/decisions/2026-07-05-richest-data-flow.md`

---

## 1. 背景与动机（Why）

### 1.1 实测根因（已亲手核验，非推断）

`exp/ws-upstream-keepalive/REPORT.md`「2026-07-12 归因更正」对真实 GHC 上游做 5 次 gpt-5.5（`reasoning.effort=high`）WS 探针，确证其响应真实形态：

- `response.created` 恒在 **0.4s** 到达（进入 post-first-event regime）；
- 随后**单个 266–462s 连续零帧静默**（无中间帧刷新 deadline）；
- 末尾一次性 burst 5000+ 帧 + `response.completed`，正常关闭；
- 5/5 稳定：GHC 在 ≤462s 内**从不**主动 idle-close。

我方 `state.streamIdleTimeout` 默认 **300s**（post-first-event guard，全部流式传输共用）。故 `response.created` 后到 burst 之间 >300s 的**合法**静默被我方 guard 在 300s 主动掐死（`StreamIdleTimeoutError`），**即使 GHC 不掐我方也掐**——潜伏/已发生的独立 bug（问题 B）。

> **推翻旧断言**：`2026-07-09-...` R5.3 曾断言「reasoning 模型通常有中间帧…300s 极少触及」。实测反驳——gpt-5.5 正常形态就是 400s+ 单个零帧静默，462s 是**地板不是天花板**。

### 1.2 用户已定方向

**调大 timeout + per-model override**（gpt-5.5 类给 600s+，其余保 300s），而非全局一刀切——共用同一 knob，全局调大会拖慢所有模型的死连接检测。per-model 把「延迟死连接检测」代价只加在真需长静默的模型上。

### 1.3 根因边界（别退化成「只对 WS 调」）

post-first-event guard 在**所有流式传输**都掐（SSE `guardSseIterable`、WS `raceIteratorNext`、Anthropic `processAnthropicStream`），全部从**同一** `state.streamIdleTimeout` 派生。故 per-model override 必须对全部 app-level 流式读点生效，不能只补 WS（否则同模型走 SSE fallback 仍被 300s 掐）。

### 1.4 与问题 A 的边界（不在本 spec 范围）

实测揭示正交的问题 A：GHC 在某条件下（大 input / 排队 / edge，迟迟不发 `response.created`）自己发 `close(1000,"idle timeout")`（pre-first-event）。问题 A 由 per-model 熔断 + buffered 重试治理，属 tier1-hardening spec。本 spec 只治问题 B（post-first-event guard 太短），另附带把 `response_header`（首字节前 idle）也 per-model 化（§6）——但**不实现熔断**。

---

## 2. 目标与非目标

### 2.1 目标

1. 引入 **per-model `stream_idle` 与 `response_header` 两个超时 override**（用户 D1 定：两 knob 一并做、架构对称），复用既有 `Record<模型名子串, 值>` + `"*"` 通配范式，hot-reloadable、bundled+user **per-key merge**（§3.3 H3）。
2. 提供两个**单一 effective 值解析器** `resolveStreamIdleTimeoutMs(model)` / `resolveResponseHeaderTimeoutMs(model)`，覆盖全部对应 app-level 读点，把 model threading 进当前缺 model 的深层函数。
3. **两个 knob 都是 app-guard-only**——GHC 流量走 node:http2、无 transport body-idle timeout（§7 拟 ADR 核验），故**无需**任何 undici/transport backstop 联动。
4. 内置一条 gpt-5.5 类 default override，**经 bundled `config.yaml`**（`timeouts.stream_idle_overrides:{gpt-5.5:600}`，H1 定，非 CONFIG_MANAGED_DEFAULTS），开箱即用不掐 gpt-5.5。
5. **可观测性**：effective per-model 超时进启动日志 + history `pipelineInfo`（用户 D2 定）。

### 2.2 非目标

- 不实现 per-model 熔断 / half-open（问题 A，属 tier1-hardening）。
- 不改 buffered 重试机制本身（问题 B 的**恢复层**，与本 spec 的**预防层**互补——§9）。
- 不改 WS/h2/TCP keepalive PING（实测已定 ping 不重置帧-idle guard，对 B 无用）。
- **无 compat 兼容层负担**：`stream_idle_overrides` / `response_header_overrides` 是**全新键、无旧键**，无需 `renameLeaf`。（标量 `stream_idle`/`response_header` 沿用既有 `timeouts.*` compat，不受影响。）

---

## 3. Config shape（问题 1）

### 3.1 决策：复用 model-keyed record，两个 knob 各一张独立 map

`stream_idle` 与 `response_header` 语义正交、default 不同（300 vs 600），**不合并嵌套**。放进既有 `timeouts:` section，与标量并列：

```yaml
timeouts:
  response_header: 600        # 全局标量默认（回退兜底）——不变
  stream_idle: 300            # 全局标量默认——不变

  # NEW：per-model stream-idle override（键 = 模型名子串，"*" = 所有模型；值 = 秒）
  # 命中优先级 = 最长子串（most-specific）胜；无命中回退 "*"；再无回退标量 stream_idle。
  # bundled+user per-key merge（§3.3）；命中后 0 = 禁用该模型的 idle guard。
  stream_idle_overrides:
    gpt-5.5: 600              # bundled 内置（H1）：静默地板 462s，给 600s 余量

  # NEW（用户 D1 定，与 stream_idle 完全对称）：per-model response-header override
  # 首字节前 idle；无命中回退标量 response_header（600）。bundled 不内置任何值。
  response_header_overrides: {}
```

### 3.2 为什么是 `findMostSpecific`（whitelist 语义）

超时是**标量选择语义**（一个模型一个 effective 值），非累加。复用 `per-model-config.ts` 的 `findMostSpecific`（最长子串胜、无命中回退 `"*"`），与 `effortsOverrides` 一致，避免 base-family 键泄漏到 stricter variant。

> **tie-break（plan 边界测试注明）**：`findMostSpecific`（per-model-config.ts:39-41）用严格 `>` 比较键长，**等长键插入序首胜**。plan 须测等长子串键的确定性（同长两键命中同模型，取先声明者）。

> **候选被否**：单张嵌套 map `timeouts.per_model:{"gpt-5.5":{stream_idle:600,...}}`。否因——① 破坏全项目扁平 `Record<子串,值>` 范式与 `normalizeModelKeyedRecord` 直接复用；② 两 knob default 不同，嵌套后「只覆盖一个」要写半个对象。倾向扁平双 map。

### 3.3 config schema 集成（H3，必做——否则用户配置无法生效 / 抹掉内置默认）

`TimeoutsConfigSchema`（schema.ts:670-683）是 `.strict()`——**未声明的键会被拒**，故两个 override map 必须显式加进 schema。且 `RECORD_MERGE_STRATEGIES`（schema.ts:869+）**缺省 `"replace"`**——若不注册，bundled `{gpt-5.5:600}` 会被 user 的整张 map 替换（用户写 `stream_idle_overrides:{}` 会抹掉内置 600、违反 INV-1）。做法：

1. **schema 声明**：把两个 map 定义为**命名 const** 的 `ZodRecord`（WeakMap 注册需稳定引用），值为非负整数秒：
   ```ts
   export const StreamIdleOverridesSchema = z.record(z.string(), z.number().int().nonnegative())
   export const ResponseHeaderOverridesSchema = z.record(z.string(), z.number().int().nonnegative())
   ```
   在 `TimeoutsConfigSchema` 内引用（`stream_idle_overrides: StreamIdleOverridesSchema.optional()` 等），保持 `.strict()`。
2. **注册 per-key merge**（跟随 `RECORD_MERGE_STRATEGIES.set(ModelOverridesSchema,"per-key")` 先例）：
   ```ts
   RECORD_MERGE_STRATEGIES.set(StreamIdleOverridesSchema, "per-key")
   RECORD_MERGE_STRATEGIES.set(ResponseHeaderOverridesSchema, "per-key")
   ```
   语义：bundled `{gpt-5.5:600}` 与 user map **逐键合并**——user 未提 `gpt-5.5` 则内置 600 保留；user 显式 `{gpt-5.5:900}` 则该键覆盖为 900；user `{gpt-5.5:0}` 则显式禁用。这正是 `model_overrides` 的 bundled+user per-key 先例（config.yaml 缺失退化 scalar）。
3. **config.ts 装配**：`if (t.stream_idle_overrides !== undefined) setTimeoutOverridesConfig({ streamIdleTimeoutOverrides: normalizeModelKeyedRecord(t.stream_idle_overrides, "timeouts.stream_idle_overrides") })`，`response_header` 同理。经 `normalizeModelKeyedRecord` 折叠大小写/分隔符（与其他 model-keyed 记录一致）。

> **承重不变量 INV-1（H3 收敛）**：合并语义是 **bundled+user per-key merge**（`RECORD_MERGE_STRATEGIES` 注册 per-key），非 replace、非值级 union。plan 测试须覆盖**两层**：① config 层——bundled `{gpt-5.5:600}` + user `{}` 经 `mergeBySchema` → `{gpt-5.5:600}`（内置不被抹）；user `{gpt-5.5:900}` → `{gpt-5.5:900}`；② state 层——map 经 `normalizeModelKeyedRecord` 落 `state.streamIdleTimeoutOverrides` 后，`resolveStreamIdleTimeoutMs("gpt-5.5")===600000`、未命中模型 === scalar。

---

## 4. 默认值（问题 2 / H1）

### 4.1 决策

| knob | 全局标量默认 | 内置 override |
|---|---|---|
| `stream_idle` | **300**（不变） | bundled `config.yaml`: `{ "gpt-5.5": 600 }` |
| `response_header` | 600（不变） | 无（bundled 不内置值） |

- **全局 300 不动**：多数非-reasoning 模型 300s 连续零帧属死连接，保留快速检测。
- **gpt-5.5 内置 600s**：462s 实测地板；给 138s 余量。用户 D4 定内置（已实测的产品级事实，开箱即用）。用户可 override / 删除。

### 4.2 内置默认的落地机制（H1 改正——引对先例）

> **v1 引错先例已改正**：`rejectBodyFields` 的 `CONFIG_MANAGED_DEFAULTS` 值实为 `{}`（state.ts:1485），真正的 `inference_geo` 内置是**代码常量** `BUILTIN_REJECTED_FIELDS`（request-preparation.ts:163）且是 **union 语义**——恰是本 spec 明说 stream_idle **不能**用的语义。故**不**照它。

正确机制（跟随 `model_overrides` 先例）：
- 内置 `{gpt-5.5:600}` 写进 **bundled `config.yaml`** 的 `timeouts.stream_idle_overrides`，**不进** `CONFIG_MANAGED_DEFAULTS`（后者保持不含此项，即 `streamIdleTimeoutOverrides: {}`）。
- bundled config.yaml 与 user config.yaml 经 `mergeBySchema` **per-key merge**（§3.3），bundled 提供推荐值、user 只需覆盖想改的键。
- config.yaml 完全缺失（无 bundled 场景，如某些测试）→ 退化 scalar 300（`resolveStreamIdleTimeoutMs` 无命中回退 `state.streamIdleTimeout`）。这与 `model_overrides` 缺失退化行为一致。

> **INV-1'（override 非 union）**：即便走 bundled，合并也是**键级**（per-key merge / 覆盖）而非**值级 union**——gpt-5.5 键只有一个 effective 秒值，永不出现「内置 600 与 user 900 union 成两个值」。

---

## 5. Effective 值解析 + model threading（问题 3 / D1）

### 5.1 state 上新增

```ts
// state.ts —— 与 rejectBodyFields 等并列
/** Per-model stream-idle timeout override (seconds). most-specific key wins;
 *  falls back to "*", then to scalar `streamIdleTimeout`. Sourced from bundled+
 *  user config.yaml (per-key merge). Hot-reloadable: entirely replaced on reload. */
readonly streamIdleTimeoutOverrides: Record<string, number>
/** Per-model response-header (first-byte idle) timeout override (seconds). Same
 *  shape/semantics; falls back to scalar `responseHeaderTimeout`. */
readonly responseHeaderTimeoutOverrides: Record<string, number>
```

CONFIG_MANAGED_DEFAULTS 两者初值 `{}`；setter 新增 `setTimeoutOverridesConfig`（replace 语义写入 state，config reload 整体替换）。

### 5.2 解析器（单一事实源）

建议 `src/lib/models/timeout-resolver.ts`：

```ts
export function resolveStreamIdleTimeoutSec(model: string | undefined): number {
  if (model !== undefined) {
    const hit = findMostSpecific(model, state.streamIdleTimeoutOverrides)
    if (hit !== undefined) return hit
  }
  return state.streamIdleTimeout
}
export function resolveStreamIdleTimeoutMs(model: string | undefined): number {
  const sec = resolveStreamIdleTimeoutSec(model)
  return sec > 0 ? sec * 1000 : 0     // 统一显式判 0（0 = disabled）
}
// response_header 对称：resolveResponseHeaderTimeoutSec/Ms，回退 state.responseHeaderTimeout
```

> **0 语义收敛**：既有读点两种写法混用（`*1000` 不判 0 vs `>0?*1000:0`）。resolver 统一为显式判 0，对既有两种写法都等价（`0*1000===0`），是安全收敛。`response_header` 侧同理（`createResponseHeaderTimeoutSignal` 现已 `>0?...:undefined`，resolver 保持该 undefined=disabled 语义）。

### 5.3 stream_idle 读点 model threading 清单（行号已重锚——评审实测漂移，plan 前须重跑 grep 确认 model 在场）

| # | 读点 | 文件:行（v2 重锚）| model 变量 | threading |
|---|---|---|---|---|
| 1 | messages SSE transport | `routes/messages/handler-v4.ts:350` ✓ | `resolvedName` | `resolveStreamIdleTimeoutMs(resolvedName)` |
| 2 | chat-completions transport | `routes/chat-completions/handler-v4.ts:145`（v1 误写 :120） | `resolvedName` | 同上 |
| 3 | responses SSE transport | `routes/responses/handler-v4.ts:135`（v1 :111） | `resolvedName` | 同上 |
| 4 | gemini transport | `routes/gemini/handler-v4.ts:110`（v1 :85） | `resolvedName` | 同上 |
| 5 | responses WS transport | `routes/responses/ws.ts:229` ✓ | `resolvedModel` | `resolveStreamIdleTimeoutMs(resolvedModel)` |
| 6 | 上游 WS 帧-idle guard | `lib/openai/upstream-ws-attempt.ts:211`（`streamWsEvents`）| 签名无 model；caller :170 有 `wire.model` | 加 option `StreamWsEventsOptions.idleTimeoutMs`，caller 算 `resolveStreamIdleTimeoutMs(wire.model)` 传入 |
| 7 | Anthropic SSE 处理器 | `lib/anthropic/stream.ts:64`（`processAnthropicStream`）| 签名无 model；caller `web-search-direct.ts:433` 有 `anthropicPayload.model` | 加可选参 `idleTimeoutMs?`（默认 `resolveStreamIdleTimeoutMs(undefined)` 保 back-compat），caller 传 model 解析值 |

> **INV-2（threading 边界）**：读点 6/7 深层函数**不透传 model 字符串、只透传算好的 `idleTimeoutMs`**（对齐既有 transport `idleTimeoutMs` seam）。解析集中在 handler 边界（model 天然在场处），每请求解析一次。transport（`http-transport.ts:45`/`responses-transport.ts:56`）已吃 `idleTimeoutMs`，内部零改动。

### 5.4 response_header 读点 model threading 清单（D1 新做——本轮核实 model 在场）

做法：`createResponseHeaderTimeoutSignal()` 增可选参 `model?: string`，内部改用 `resolveResponseHeaderTimeoutMs(model)`（`undefined` → 回退 scalar，行为对既有无参调用等价）。调用点按 model 是否在场分两类：

| 调用点 | 文件:行 | GHC-bound 首字节？| model 变量 | threading |
|---|---|---|---|---|
| HTTP send 核心（messages/chat/responses/gemini 全经此）| `transport/send.ts:113` | 是（主路径）| `modelId`（params 解构）| `createResponseHeaderTimeoutSignal(modelId)` |
| Anthropic direct 路径 | `anthropic/client.ts:120` | 是 | `payload.model` | 传 `payload.model` |
| 上游 WS 初始 fetch | `openai/upstream-ws-attempt.ts:138` | 是 | `wire.model`（`prepared.wire`）| 传 `wire.model` |
| count-tokens | `routes/messages/count-tokens.ts:68` | 是（非流式）| `model` | 传 `model`（低价值但对称，可选）|
| embeddings | `openai/embeddings.ts:28` | 是（非流式）| `payload.model` | 传 `payload.model`（可选）|
| **模型目录 fetch** | `models/client.ts:49` | 是但**无 per-model 概念** | 无 | **保持无参 → scalar**（catalog 非模型特定）|
| **SearXNG web-search** | `anthropic/web-search/backends.ts:316` | **否（本地 http、走 undici）** | — | **保持无参 → scalar** |

> 关键 threading 点是 `send.ts:113`（`modelId` 已在 `SendUpstreamHttpParams` 解构中在场）——四条 HTTP 端点全经 send 核心，一处 threading 覆盖全部 HTTP 首字节。WS 与 Anthropic-direct 各一处。catalog/SearXNG 显式保 scalar。

---

## 6. 两个 knob 都是 app-guard-only（问题 5 / BLOCKER 改正）

> **v1 的「undici headersTimeout 联动」已删——假前提。** GHC 首字节走 node:http2（`upstream-fetch.ts:66-69`），由 **app 侧** `createResponseHeaderTimeoutSignal`（fetch-utils.ts:24，`AbortSignal.timeout`）治，**非 undici** `headersTimeout`。undici `headersTimeout` 只服务本地 SearXNG（明文 http）。

结论：`stream_idle` 与 `response_header` **两个 knob 都是纯 app-guard**——per-model 化只需在各自的 app 侧读点（§5.3 / §5.4）threading resolver，**无任何 transport-level 联动**。这也回答了原 §6.2：两 knob 对称、都不碰 undici。

`response_header` per-model 化对**问题 A** 价值有限（GHC 若自己先 close，我方 timeout moot），但用户 D1 定：against-yagni、架构对称、增量成本极低（与 stream_idle 同构），一并做。bundled 不内置值（快模型 600s 已够，无实测需要 override 的模型）。

---

## 7. 拟 ADR（D5）：per-model idle 是 app-guard-only，**无需** transport/undici backstop 耦合

> 升为拟 ADR，若采纳落 `docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md`。目的=**固化传输路由结论、防后人重复提议 undici↔per-model 耦合**（v1 曾误提，根因是把 proxy.ts 配 undici 处的注释错误泛化到 GHC 路径）。

### 7.1 背景：v1 的假前提

v1 §7 曾担心「全局 undici Agent `bodyTimeout = scaleTimeout(scalar 300)=450s` 会抢先掐死 600s 模型」，并设计 backstop 取 max 联动（INV-3/INV-4/D3）。**该前提为假，全部删除。**

### 7.2 核验的传输路由事实

1. **GHC（https）不经 undici**：`upstream-fetch.ts:66-69` `productionUpstreamFetch` = `u.protocol === "https:" ? http2Fetch(u,init) : undiciUpstreamFetch(u,init)`。所有 `https://` 上游（GHC / anthropic / github）走 **node:http2**；undici **只服务唯一的明文 `http://` 上游——本地 SearXNG**（非流式、非 reasoning）。
2. **h2 传输层无 body-idle timeout**：h2 握手后 `sock.setTimeout(0)`（`http2-client.ts:149`，注释「clear the connect deadline — an established h2 conn may idle legitimately」）。即 GHC 流量的传输层**根本没有** body-idle 掐流，gpt-5.5 的 400s+ 静默在 transport 层永不被掐。
3. **首字节 timeout 亦 app 侧**：GHC 首字节前 idle 由 `createResponseHeaderTimeoutSignal`（`AbortSignal.timeout`，fetch-utils.ts:24）治，非 undici `headersTimeout`。

### 7.3 决策

- **per-model stream_idle / response_header 是纯 app-guard**——唯一掐 GHC 流的就是我方 app-level guard（`raceIteratorNext` / `guardSseIterable` / `processAnthropicStream` / `AbortSignal.timeout`）。per-model 化只 threading 这些 app 读点即可。
- **undici `bodyTimeout`/`headersTimeout` 保持 `scaleTimeout(scalar)` 不动**——它们只服务 SearXNG（本地、快、非流式），标量 300/600×1.5 对它绰绰有余，与 per-model override 无关、**不联动**。
- **不建**任何 per-model dispatcher / transport backstop——GHC 不经 dispatcher，h2 无 body-idle，联动是无的放矢。

### 7.4 反证守卫（防复发）

plan 应留一条 grep/断言 oracle：`state.streamIdleTimeoutOverrides` / `responseHeaderTimeoutOverrides` 的读点**不应**出现在 `proxy.ts` / `http2-client.ts`（transport 层）——只在 app 侧 handler / stream guard。若未来有人在 transport 层读 per-model override，即是重蹈 v1 假前提。

---

## 8. 可观测性（问题 6 / D2 定：做）

1. **进程级配置视图**（低成本）：启动日志 + config reload 日志打印 effective override map（`consola.debug`），如 `Stream-idle overrides: {gpt-5.5:600} (scalar fallback 300)`，对齐 proxy.ts:223 的既有 `Undici timeouts:` debug 行风格。**不再**提 undici backstop（§7 已删）。
2. **per-request history 诊断**（D2 定做，独立 task）：把该请求 effective 的 `streamIdleTimeoutMs`（及可选 `responseHeaderTimeoutMs`）记进 history `pipelineInfo`（`history/types.ts:472`，经 `context_updated` 落盘的既有承重通道——记忆 `methodology-plan-verify-interface-location-and-wiring-channel`：持久化 prepare 诊断走 pipelineInfo，别用只到 live TUI 的 recordFeature）。每条 entry 能回答「为什么 462s 才完成 / 为什么被 300s 掐」。新增顶层诊断字段须走 pipelineInfo schema 扩展 + 投影，作独立 task。

**不做**：/api/status 专门 timeout 端点——启动日志 + pipelineInfo 已覆盖，新端点过度设计（record not-adopted：未来若有前端 config 面板再评估）。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 调大 guard → 真 wedged 连接拖到 timeout 才失败（延迟客户端 fallback）| per-model 把代价只加在真需长静默的模型；配合 buffered 重试 + per-model 熔断（问题 A，另 spec）|
| buffered 重试单独不够治 B（每次尝试都 >300s 撞同一墙）| 明确调大 guard 是**预防层**、buffered 重试是**恢复层**，互补非替代——本 spec 做预防层 |
| 内置 gpt-5.5 子串误伤意外模型名 | `findMostSpecific` 最长子串胜 + `normalizeForMatching`；plan 测变体边界（`gpt-5.5-codex` 应命中）|
| 462s 是地板非天花板，600s 未来或仍短 | override 是 config 可调；用户可设更大值或 0 禁用 guard（极端长思考）|
| bundled config.yaml 缺失（测试环境）→ 内置 600 不生效 | 退化 scalar 300（与 `model_overrides` 缺失行为一致）；测试如需 600 显式注入 override |

---

## 10. 不做 / 推迟（问题 7）

| 项 | 判断 | 理由 |
|---|---|---|
| per-model 熔断 / half-open（问题 A）| 推迟（tier1-hardening）| 与 B 正交；已有 `consecutiveFallbacks` 承接 |
| buffered 重试机制改动 | 不做 | 恢复层已在 block-buffered/tier1 spec；本 spec 是预防层 |
| WS/h2/TCP keepalive PING per-model 化 | 不做 | 实测 ping 不重置帧-idle guard，对 B 无用 |
| undici/transport backstop 联动 | **不做（BLOCKER 改正）**| GHC 不经 undici、h2 无 body-idle（§7）|
| `response_header_overrides` 内置默认值 | 不内置（schema 铺、值空）| 快模型 600s 已够，无实测需 override 的模型；用户可自配 |
| /api/status timeout 端点 | 不做 | 启动日志 + pipelineInfo 已覆盖 |
| per-model `stale_request_max_age` override | 推迟 | 不同层（请求总寿命非帧-idle）；记 backlog |
| **`upstream-ws-connection.ts:88` 池-idle-close 硬编码 300s 是否跟随 scalar** | 记 backlog（独立小改）| 见 §附录 INV-5 说明；正交于问题 B，本 spec 不动 |

---

## 11. 待主会话/用户拍板汇总（v2 更新）

- **D1 = 已定**：stream_idle + response_header 两个 knob 都 per-model 化（架构对称）。
- **D2 = 已定**：做 history `pipelineInfo.streamIdleTimeoutMs`（独立 task）。
- **D4 = 已定**：内置 gpt-5.5:600 经 bundled config.yaml（非 CONFIG_MANAGED_DEFAULTS）。
- **D3 = 撤销**（BLOCKER）：undici backstop 联动前提为假，无此决策。
- **D5 = 已定**：§7 升拟 ADR「per-model idle 是 app-guard-only，无需 transport 耦合」，采纳后落 `docs/decisions/`。
- **剩余待确认**：无硬分叉。plan 阶段须重跑 §5.3 行号 grep（评审已证漂移）+ §5.4 response_header 调用点 model 在场复核。

---

## 附录 A：承重不变量清单（plan 须逐条测试锁定）

- **INV-1（H3）**：两个 override map 都在 `TimeoutsConfigSchema`（`.strict()`）声明 + `RECORD_MERGE_STRATEGIES` 注册 **per-key**。合并语义 = bundled+user per-key merge（非 replace、非值级 union）。测试覆盖两层：config 层 `mergeBySchema`（user `{}` 不抹内置 600）+ state 层 resolver 应用。
- **INV-2**：per-model 解析只在 handler 边界发生一次；深层流处理器（`streamWsEvents`/`processAnthropicStream`）吃算好的 `idleTimeoutMs`，不认识 model。
- **INV-5（exhaustive，含第 8 读点）**：全部 **app-level** 流式/首字节读点都经 resolver。oracle：grep `state.streamIdleTimeout` 在 src/ 只剩 `state.ts` 定义 + resolver（stream_idle 侧）；grep `createResponseHeaderTimeoutSignal(` 调用点除 catalog/SearXNG 外都带 model（response_header 侧）。
  - **第 8 读点显式排除**：`upstream-ws-connection.ts:88` `scheduleIdleClose` 用硬编码 `DEFAULT_IDLE_TIMEOUT_MS = 5*60_000`（=300s）。这是**池-复用 idle-close**（仅 `!busy` arm 生效、`sendRequest` 时 `clearIdleTimer`，响应进行中不误掐——connection.ts:125 的 `busy` 守卫），**正交于问题 B**（B 是 in-flight 帧-idle，这是 idle 池连接的回收），**故意不 per-model 化**。它读 `opts.idleTimeoutMs ?? DEFAULT`、**不读** `state.streamIdleTimeout`，故 grep oracle 不命中它是正确的。**backlog**：这个硬编码 300s 是否该跟随 scalar `streamIdleTimeout`（独立小改，非本 spec 范围）。

> **v1 的 INV-3/INV-4（undici backstop 联动）已删**——假前提（§7 BLOCKER 改正）。
