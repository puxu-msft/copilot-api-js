# Proxy hook 中间件（ad-hoc hook 机制）— 规格说明

> 状态：**v2 已实施并合并 master（`118a9c33`，2026-07-12）**——实现在 [src/lib/pipeline/hooks/](../../src/lib/pipeline/hooks/)（loader/origin/toolkit/types/index）+ driver 三挂载点 wire + `/api/hooks` 端点 + config，权威见 ADR [2026-07-12-driver-orchestrated-upstream-hooks.md](../decisions/2026-07-12-driver-orchestrated-upstream-hooks.md) + [DESIGN.md](../DESIGN.md) 活的架构现状 + skill `upstream-hook-mocking`。该机制**尚无任何使用方**（内部工具、无向后兼容负担），故可大胆破坏性改造。
> **v3 已实施**（2026-07-14，worktree `feat/hook-symmetric-4point`，7 phase 提交 e4e01b76→a05436a9）：① 挂载点命名从 shipped 的扁平 `onRequest`/`onExchange`/`rewriteUpstreamFrame` 全量迁移到 `export const hooks` 二维分组 `hooks.{client,upstream}.{inbound,outbound}` + `hooks.exchange`；② 定位扩为「也可在真实流量上生产改写请求」；③ 新增 client-native `hooks.client.inbound`（driver S1a→S1b、防御性 body snapshot，§3.5）+ 四格式 async 入站处理下沉 driver 新 S1b `translateInbound` 阶段（gemini 翻译 + 各格式 system-prompt 注入）；④ `hooks.client.outbound`（回客户端响应改写）接线在 S6 renderFrames（覆盖渲染帧，sink 合成/心跳帧的 full egress 统一化记 deferred-backlog）。**v3 迁移面清单见 §12**。
> **loader 机制修正（实施期实测）**：§6.2/§6.3 的 data-URL 加载被证伪——data-URL 模块**不解析** `~/` 别名，故带 toolkit import 的 hook 静默失败。改为**转译后写唯一项目内文件**（`.hooks-cache/`，gitignored）再 import：既绕过 Bun path-keyed ESM 缓存（同 data-URL）、又经 tsconfig `paths` 解析 `~/` 别名（unlike data-URL），so helper-importing hooks 可加载。原 B1 data-URL 决策 superseded。
> 本文档承载 v2 的完整设计理由（供理解为何如此实现）+ v3 的改造规格。行内 `[driver.ts:NNN]` 锚点为 v2 撰写时快照，cell-assembly 重构后已位移——写码前以 §12 刷新后的锚为准，**位置/顺序事实经 2026-07-14 评审对照当前 master 代码仍成立**（评审见 §11）。

## 1. 背景与目标

**源起**：2026-07-12 cache_control 子字段剥离特性的实测中，发现「验证代理行为不得不真发 GHC」——消耗 Copilot 额度、依赖网络、且**无法构造特定上游响应**（如 400、畸形 decode 腔）来测 reactive 学习腿。用户提出需要一个 hook 机制：既跑本 proxy 的**完整处理管线**，又能给出 mock 的上游交互。2026-07-14 又提出：把「按内容剥离客户端注入的消息块」（如 Claude Code 注入的 TodoWrite `role:system` 样板）这类**真实流量上的请求改写**也归到 hook 机制——用编程 hook 替代 config+regex 声明式引擎（后者灵活性不足，见 §11 not-adopted）。

**目标**：在 proxy 处理管线的**关键边界**引入一组可选的 ad-hoc hook 挂载点，让开发者用一个 config 声明的 JS/TS 文件，编程决定改写结果——既能在不真发 GHC 的前提下 mock / 拦截改写 / 录制回放 / 注入故障（**测试用途**），也能在真实流量上按客户端原始形状改写请求（**生产用途**，如去客户端噪声 / 省 token / 改行为），同时前置/后置的 sanitize、cache_control 剥离、格式翻译、retry 腿全部走**真实处理**。

**确认用途**：测试侧四个（2026-07-12 AskUserQuestion 全选）——① Mock 上游响应 ② 拦截/改写请求响应 ③ 录制-回放 ④ 注入故障/延迟；生产侧（2026-07-14）——⑤ 在 client-native 形状上编程改写入站请求（剥离/改写客户端注入块）。

## 2. 范围与已确认决策（勿擅自更改）

以下决策已与需求方逐条确认（2026-07-12 brainstorming）：

| 维度 | 决策 | 理由 |
|---|---|---|
| **注入接缝** | 收口进 `createPipelineDriver` 内部；6 处 handler transport 构造点**一行不改** | driver 是 transport 唯一消费者、也是 stage 编排者，天然收口 |
| **hook 粒度** | driver 编排的**多挂载点**（非单一 transport decorator）；同一 hook 模块按参数自辨 model/endpoint/format；**无声明式匹配** | 用户明确要「分阶段多挂载点 + 同 hook 按参数区分、不用声明式」 |
| **挂载点命名（v3 重构）** | 二维分组 `hooks.{client,upstream}.{inbound,outbound}` + 非方向性边界拦截器 `hooks.exchange`；`client\|upstream` 轴编码 body 形状（客户端原样 / 上游形状），`inbound\|outbound` 轴相对 proxy（流入 / 流出）；`on*` 前缀在 hook 导出层整个丢弃 | 见 §11 v3 裁决：`onInboundRequest` 一旦要存在就证明 `onRequest` 名字不表意；owner 定分组体系，`client\|upstream` 让作者一眼知拿到哪种形状 |
| **挂载点集合** | 首版实现四个：`client.inbound`（client-native 请求改写，新）、`upstream.outbound`（旧 `onRequest`，upstream-bound 请求改写）、`upstream.inbound`（旧 `rewriteUpstreamFrame`，逐帧上游响应改写）、`exchange`（旧 `onExchange`，S4 拦截）；`client.outbound`（回客户端响应改写）**命名预留、实现延后**（§8 + deferred-backlog）；全部可选、未导出=直通 | against-YAGNI 与对称完整之间：四象限里 3 个是 v2 已有的重命名、1 个新槽、1 个预留槽 |
| **observe vs rewrite** | 不设独立 observe-only 导出——改写 hook `return undefined` 即等于 observe（做完副作用后原样直通） | owner 反问「有 rewrite 还需要 observe 版本吗」，成立；v2 的 M3 改名防的是 hook 导出与 driver **内部**采样 sink 撞名，非导出层有 observe 成员 |
| **mock 编写接口** | 高层 helper 工具箱 + **raw 逃生口**（直接返回 `UpstreamStream`） | helper 覆盖 90%，raw 造任意畸形帧 |
| **录制-回放源** | **复用 history.db** 的 `upstreamResponse.sseEvents`（每请求已自动录，零新录制路径） | 无需独立 cassette 文件 |
| **格式 helper** | Anthropic / CC / Gemini 三份 mock 一次都做 | against-YAGNI |
| **加载** | config 声明模块路径 + 显式 `enabled` 开关；启动时 `import()` 一次 | 对齐 config 声明式 + 可选 code 模式 |
| **热重载** | **仅经管理 API** `POST /api/hooks/reload` 触发（**不**做 per-request mtime 检查） | 用户明确「仅 API 支持更好」；更显式、零隐式 per-request 开销、时机可控 |
| **安全** | 默认 `enabled:false` + config 显式启用；hook 抛错 warn-continue 绝不杀进程 | 项目 `internal-tool-security-posture`（内部开发工具） |

**明确不做（本特性范围外）**：独立 cassette 文件格式（复用 history 已足够）；声明式 match 路由（用户否决）；per-request 自动重载（用户否决）；env var / 请求头级 opt-in（config 已足够）；上游 WS（Responses ws:）的 hook——见 §8 边界；config+regex 声明式消息块过滤引擎（2026-07-14 not-adopted，灵活性不足，被编程 hook 取代——见 §11）。

**正交独立微改动**（用户顺带提，与 hook 无关、单独 commit）：根路径 `/` 从纯文本 `"Server running"` 改为 302 重定向到 `/openapi.json`（见 §7）。

## 3. 架构：driver 编排的多挂载点

### 3.1 上游边界与收口点

所有上游交互经过唯一窄接口 `Transport.send(wire: PreparedRequest, env: RequestEnvelope): Promise<UpstreamStream>`（[src/lib/pipeline/types.ts:108](../../src/lib/pipeline/types.ts#L108)）。driver 在 retry 循环里每 attempt 调一次 [src/lib/pipeline/driver.ts:310](../../src/lib/pipeline/driver.ts#L310) `await deps.transport.send(wire, current)`。

`UpstreamStream = { frames: AsyncIterable<UpstreamFrame>, nonStream?: unknown, headers: Headers }`（[types.ts:63](../../src/lib/pipeline/types.ts#L63)），`UpstreamFrame = SseFrame = { event?, data?, id?, retry? }`（[stream.ts:189](../../src/lib/stream.ts#L189)）。

**收口点**：`createPipelineDriver`（[driver.ts:134](../../src/lib/pipeline/driver.ts#L134)）内部读一个 module-global hook 单例（`getUpstreamHook()`），在它已编排的 phase 边界回调对应挂载点。6 处 handler 构造点（messages / chat-completions / gemini 用 `createUpstreamHttpTransport`，responses / ws 用 `createUpstreamResponsesTransport`）**一行不改**。

### 3.2 挂载点：二维分组 `hooks.{client,upstream}.{inbound,outbound}` + `hooks.exchange`

**命名体系（v3 重构，§11）**：hook 导出是一个分组对象，两条轴各自自证「我在哪、拿到什么形状」：
- **`client | upstream` 轴 = body 形状**：`client.*` 拿 **client-native** 形状（客户端原始请求 / 回客户端的响应）；`upstream.*` 拿**上游/目标**形状（朝上游的请求 / 上游原始响应帧）。
- **`inbound | outbound` 轴 = 相对 proxy 的方向**：`inbound` = 流入 proxy（请求进来 / 上游响应回来）；`outbound` = 流出 proxy（朝上游发出 / 回客户端发出）。
- **`hooks.exchange`** 是非方向性的**边界拦截器**（带 `next`，跨在 `upstream.outbound → upstream.inbound` 之间），不属任何象限，单列。

任一叶子省略 = 该边界直通（零行为改变、字节等价）；改写 hook `return undefined` = observe（做完副作用后直通）。**四象限对称表**：

| | **inbound**（流入 proxy） | **outbound**（流出 proxy） |
|---|---|---|
| **client**（client-native 形状） | `client.inbound` — 客户端原始请求改写（**新，生产用途主战场**） | `client.outbound` — 回客户端响应改写（**命名预留、实现延后**，§8） |
| **upstream**（上游/目标形状） | `upstream.inbound` — 上游原始响应逐帧改写（旧 `rewriteUpstreamFrame`） | `upstream.outbound` — 朝上游的请求改写（旧 `onRequest`） |

**首版实现的四个挂载点**（签名 + 位置）：

| 挂载点 | phase / 位置 | 签名 | 覆盖用途 |
|---|---|---|---|
| `client.inbound` | **一次性**、S1 `codec.parse` 之后、S2 `translate` 之前（[driver.ts:227](../../src/lib/pipeline/driver.ts#L227) `resolveRouteDecision` 之前） | `(env: RequestEnvelope) => RequestEnvelope \| undefined` | client-native 请求改写：剥客户端注入块（TodoWrite）/ 省 token / 按客户端形状改写；不返回/undefined 直通 |
| `upstream.outbound` | **一次性**、S3 `runRewriteIn` 后、S4 `runExchange` 前（[driver.ts:243](../../src/lib/pipeline/driver.ts#L243)） | `(env: RequestEnvelope) => RequestEnvelope \| undefined` | 贴近上游的最终请求改写（sanitize/translate 之后） |
| `exchange` | S4 上游交换（**核心**），包裹 `deps.transport.send`（[driver.ts:310](../../src/lib/pipeline/driver.ts#L310)） | `(wire: PreparedRequest, env: RequestEnvelope, next: () => Promise<UpstreamStream>) => Promise<UpstreamStream>` | 拦截整个上游调用：mock / replay / fault（见 §3.3） |
| `upstream.inbound` | 响应逐帧，**在 driver 上游-original 采样之后、rewrite 链之前**（[driver.ts:446-449](../../src/lib/pipeline/driver.ts#L446) 之间） | `(frame: UpstreamFrame, env: RequestEnvelope) => UpstreamFrame \| undefined` | 逐帧改写；返回 `undefined` 丢弃该帧 |

**命名与 driver 内部采样 sink 的区分（原 M3，v3 加固）**：逐帧挂载点是 hook 导出侧的 `upstream.inbound`，与 driver 既有的 `RunResponseOpts.onUpstreamFrame`（[types.ts:243](../../src/lib/pipeline/types.ts#L243)，handler 内部的**观察-only** 采样 sink）分属两层——前者是 hook 分组对象的叶子、后者是 driver 内部字段，命名空间不同、不再有撞名风险（v3 丢弃 hook 导出层的 `on*` 前缀，正把「`on*` = 观察」这条隐含约定让给 driver 内部字段独占）。

**client.inbound vs upstream.outbound 的分工（v3 核心）**：两者都是一次性请求改写钩子、签名相同，但拿到的 body 形状与位置不同——`client.inbound` 在**翻译/sanitize 之前**拿**客户端原样** body（剥客户端注入噪声必须在此，否则 sanitize 可能已把 `role:system` 转走、或翻译已改变结构，匹配不到）；`upstream.outbound` 在**翻译+sanitize 之后**拿**朝上游**的 body（贴近上游的最终微调）。两者并存、职责不重叠。

**位置语义（评审 H1 + H2 + v3，均已核实）**：
- `client.inbound` 与 `upstream.outbound` 均为**一次性**改写，故落在 retry 循环**之外**。`upstream.outbound`（[driver.ts:243](../../src/lib/pipeline/driver.ts#L243)）**绝不**放进 S4 loop 内：那里 `current` env 会被 reactive 策略（beta-strip / tool-field-strip）逐轮修正，循环内重放会清掉策略的 env 修正、破坏学习腿（与本特性核心动机直接冲突）。这与同位置的 `preSend`（[driver.ts:296](../../src/lib/pipeline/driver.ts#L296)）专用 `preflightDone` 守卫成一次性同理。
- `client.inbound` 落在 S2 `translate` **之前**：唯一能拿到 client-native body 的位置（S2 之后 body 已被 `translateOut` 改成目标形状）。**承重：它对 `clientRequest` 客户端原样轨的可辨识性约束见 §3.5**。
- `upstream.inbound` 落在 [driver.ts:446](../../src/lib/pipeline/driver.ts#L446) 的 `onUpstreamFrame` 采样**之后**、rewrite 链之前——保证 driver 的**上游-original track 永远记 hook 改写前的真实上游帧**（见 §3.4 承重不变量），改写只影响 forwarded 投递侧。

**重要语义**：`exchange` 在 driver 的 **retry 循环内**调用。实际触发次数 = **L1 attempts × L2 buffered-retry re-exchanges**（`runExchange` 有两个调用点：[driver.ts:196](../../src/lib/pipeline/driver.ts#L196) runRequest + [driver.ts:751](../../src/lib/pipeline/driver.ts#L751) buffered-retry sink，评审 M1 核实）。对返回固定响应的 mock 无害，但 record-replay / 有状态 fault 注入的 hook 作者须知「同一 hook 在一个客户端请求内可能被调 (L1×L2) 次」——spec 与 helper 文档必须显式说明。

### 3.3 `exchange` 如何覆盖四个测试用途

| 用途 | hook 行为 |
|---|---|
| Mock 上游响应 | 不调 `next`，返回合成 `UpstreamStream`（离线、零额度） |
| 拦截/改写 | 调 `next` 前改 `wire`，或调 `next` 后改返回 stream |
| 录制-回放 | 回放：`replayFromHistory(reqId)` 返回存档 stream 不调 `next`（录制复用 history，无需 hook 侧录） |
| 注入故障/延迟 | 返回 error（`mockUpstreamError(400)`）/ 延迟（`delay`）/ 断流（`truncateAfter`）的 `UpstreamStream` |

**红利**：`exchange` 只在这些窄边界介入，前面的 sanitize / cache_control 剥离 / 格式翻译 / retry 腿全是真实处理——复用代理完整管线，只 mock 指定的那一段。

### 3.4 承重不变量：hook 产物在 history 上游轨必须可辨识（v2 已实施，评审 BLOCK-1 / H2）

这是本机制最承重的**响应侧**数据模型决策（history 是 SSOT，误记不可逆）。请求侧的对称不变量见 §3.5。**此不变量 v2 已落地并合并 master，v3 不改动它**——下文保留设计理由 + 标注 shipped 现状。

**问题**：`exchange` 不调 `next` 返回的合成帧、`upstream.inbound` 改写的帧，会被 driver 当**上游原始响应**记进 history `attempts[].upstreamResponse.sseEvents`。但项目 Accepted ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md) §3 明文：**上游-original track 绝不含合成物，合成物只进 forwarded 轨且打显式标记**。把 hook 伪造的假 400 / 假 deltas 记进上游轨、伪装成「GHC 真的这么回」，会让事后诊断、reactive-learning 分析、`replayFromHistory` 把 mock 流量当真实流量——正是 ADR 与项目记忆 [synthetic-data-must-be-distinguishable-from-real](../memory/feedback-synthetic-data-must-be-distinguishable-from-real.md) 要防的类别。

**已实施现状（2026-07-14 对照 master 核实）**：
1. **`SseEventRecord.synthetic` 已扩**含 `"hook-mock"` / `"hook-rewrite"` / `"hook-replay"`（[history/types.ts:191-197](../../src/lib/history/types.ts#L191)，非「待扩」）。
2. **上游-original track 永远记 hook 改写前的真实帧**：`upstream.inbound`（旧 `rewriteUpstreamFrame`）在 driver 上游-original 采样**之后**介入（当前 driver.ts:543 采样 / :549 hook，§12 锚），故上游轨天然是 pre-hook 真实帧；改写只进 forwarded 投递侧。
3. **`exchange` 全 mock 的流**进上游轨时打 `synthetic:"hook-mock"`：由 `origin.ts` 的 `tagStream`/`readOrigin`（[hooks/origin.ts:13-24](../../src/lib/pipeline/hooks/origin.ts#L13)）+ driver 在 `upstreamSse.push` 处 `...(origin && { synthetic: origin })`（当前 driver.ts:531）落地。`replayFromHistory` 回放帧同理打 `hook-replay`。
4. **`hook-rewrite` forwarded 轨标记**：由 `origin.ts` 的 `tagFrameRewritten`/`wasFrameRewritten`（Symbol-keyed 帧属性，[hooks/origin.ts:71-78](../../src/lib/pipeline/hooks/origin.ts#L71)）落地，覆盖缺口（Responses 直连 + 全 translate 腿）已记 [deferred-backlog.md](../todo/deferred-backlog.md)。
5. attempt 级 provenance（`UpstreamResponseData.source`）仍未做，记 §10 待评估。

**v3 对本节的唯一影响**：命名迁移——上文的 `exchange`/`upstream.inbound` 即 shipped 的 `onExchange`/`rewriteUpstreamFrame`；§12 迁移面含 driver wire 点 + `origin.ts` 注释里的旧名。**不变量本身不变**。

### 3.5 承重不变量：`client.inbound` 改写不得污染客户端原样轨（v3 新增，driver 强制防御性 snapshot）

`client.inbound` 是 v3 新增的**请求侧**挂载点，对称于 §3.4。它在 S2 `translate` 前改写请求 body，若处理不当会污染 history 的**客户端原样轨** `clientRequest`——让「客户端实际发了什么」这一 ground truth 变成「hook 改写后的样子」，与 §3.4 同类、同样违反 richest-data-flow。

**已核实（2026-07-14 双评审对照代码）**：
- `clientRequest.body = orig.payload`（[context/request.ts:854](../../src/lib/context/request.ts#L854) 终态 + [observability/sinks/history.ts:207](../../src/lib/observability/sinks/history.ts#L207) eager insert）；`orig` 在 **context 创建时（S1 parse 处）即冻结**、eager insert 早于 exchange——客户端原样轨的 body 在 `client.inbound` 触发**之前**已捕获快照。
- **`orig.payload` 已与 `env.body` 独立引用**：四种 codec 的 `parse` 均以 `structuredClone` 建立 `orig.payload`（[codec/anthropic/codec.ts](../../src/lib/codec/anthropic/codec.ts)、[openai-cc/codec.ts](../../src/lib/codec/openai-cc/codec.ts)、[openai-responses/codec.ts](../../src/lib/codec/openai-responses/codec.ts)、[gemini/codec.ts](../../src/lib/codec/gemini/codec.ts) 各自 parse），故**即便 `client.inbound` 原地 mutate `env.body`，`clientRequest.body` 当前也不受污染**——不变量在现有代码下已结构性成立。

**决策（v3，硬化 = defense-in-depth，不改变已成立的现状）**：
1. **clientRequest 客户端原样轨在现有代码下已结构性安全**（上述 structuredClone），不依赖 hook 行为。故 driver 的防御性 snapshot **不是**为了修一个当前存在的污染 bug——它是 **defense-in-depth**：（a）防未来新增 codec 忘记 structuredClone、让 `env.body` 与 `orig.payload` 共享引用而使 hook 原地改穿透；（b）配合「不返回=fallback 到原 env」把「原地 mutate + 返回 undefined」的改写安全丢弃，落实不可变返回语义。
2. **driver 在 `client.inbound` 调用点对传入 hook 的 env 做防御性 body snapshot**：把 `parsed.with({ body: snapshotBody(parsed.body) })`（复用 driver 现成的容错 `snapshotBody`，非裸 `structuredClone`——不可克隆 body 回退原值）产出的 clone-env 交给 hook；hook 返回新 env 则用之、返回 undefined 则 driver 继续用**未改的原 `parsed`**。
3. **`client.inbound` 宣告不可变返回契约**（与 `upstream.outbound` 同）——契约是意图表达，snapshot 是架构兜底，两者叠加。
4. **测试须直接断言 snapshot 机制本身，不能拿真 codec 的 `clientRequest.body` 当 oracle（评审 HIGH-2，已核实）**：真 codec 已 clone，`clientRequest.body` 对 snapshot 是**盲的**——「删 driver snapshot 该测变红」用真 codec 逻辑上不可能（两种情况都 PASS）。正确 oracle 二选一：（a）断言 **hook 收到的 `env.body` 与 driver 继续使用的 `parsed.body` 是独立对象**（引用不等 + 深拷贝），删 snapshot 使该引用-独立断言变红；（b）注入一个**不 clone 的 codec double**（其 `_originalRequest.payload` 与 `env.body` 共享引用），此时删 snapshot → hook 原地 splice → `clientRequest.body` 被污染 → 测变红。首版用 (a)（更小、直测机制）。
5. **改写的发散可观测**：hook 改写只流向下游（translate→sanitize→upstream-bound）；「客户端发了 A、上游收到 A'」经 history 两轨对照可见（`clientRequest.body` = A vs wire 侧 = A'）——用一个「不可变返回删块」的 hook 断言朝上游 wire 确实少了该块、而 `clientRequest.body` 仍是 A（两轨发散）。是否额外加请求侧改写诊断标记记 §10 待评估。

**gemini 形状警示（评审 HIGH-1，§4.1 详）**：`client.inbound` 处 `env.body` 对 anthropic/openai-cc/openai-responses 是 client-native，但对 **gemini 已是 route 层翻译后的 CC 形状**——§3.2「S2 translate 之前是唯一 client-native 位置」的前提对 gemini 不成立（gemini 翻译早于 driver）。剥块 helper 对 gemini 在 CC messages[] 上操作（§4.1）。

## 4. hook 模块契约 + helper 工具箱

### 4.1 模块形状

一个 ad-hoc TS 文件，`export const hooks` 分组对象，`hooks` 下按需给出关心的挂载点（示意）：

```ts
// exp/my-hook.ts —— 同一模块按 wire/env/frame 参数自辨，无声明式匹配
import { mockUpstreamError, replayFromHistory } from "~/lib/pipeline/hooks"

export const hooks = {
  client: {
    // client-native 形状：剥客户端注入的 TodoWrite role:system 样板（首个生产示例）
    inbound: (env) => stripTodoWriteSystemBlock(env),  // 返回新 env / undefined 直通
  },
  upstream: {
    outbound: (env) => env,                             // 朝上游的最终请求微调
    inbound: (frame, env) => frame,                     // 逐帧改/丢帧（undefined 丢弃）
  },
  exchange: async (wire, env, next) => {
    if (env.model?.id === "claude-opus-4-8") return mockUpstreamError.toolFieldRejection()
    return next()                                       // 其余真发 GHC
  },
}
```

**首个生产示例 `client.inbound`（剥 TodoWrite，替代作废的 config+regex 引擎）**：hook 按 `env.clientFormat` 拿到入站请求 body，命中 TodoWrite 样板则**返回删除了该块的新 env**（不可变，§3.5 契约 + driver 防御性 snapshot 兜底），并恢复该形状不变量。**关键（评审 HIGH-1，已核实）：client.inbound 处的 `env.body` 真相域只有三种形状，不是四种**——因为 **gemini 在 route 层（[gemini/handler-v4.ts:151](../../src/routes/gemini/handler-v4.ts#L151) `convertGeminiRequestToOpenAI` → `body: ccPayload`）先翻成 CC 再进 driver**，故 client.inbound（driver S1 parse 后）拿到的 gemini `env.body` 已是 **CC messages[]**、原生 `contents[].parts[]`/`systemInstruction` 只存在于不可改的 `orig.payload`（history 快照）。三种真相域 + 各自匹配对象/不变量恢复：
- **anthropic**（`env.clientFormat==="anthropic"`）：`messages[]` 里 `role:"system"` 块 → 删块 + 复用 [system-messages.ts](../../src/lib/anthropic/sanitize/system-messages.ts) 的 starts-with-user / tool_use↔tool_result 配对 / 相邻同角色合并不变量。
- **CC messages[]**（`env.clientFormat` ∈ {`"openai-cc"`, **`"gemini"`**}——**两者共用同一 accessor**）：`messages[]` 里 `role:"system"` 块 → 删块 + 空-messages 保护、首消息合法性。gemini 客户端的系统噪声经 route 层 Gemini→CC 翻译后落在 CC `role:"system"` 消息里，故在此形状上剥离即覆盖 gemini 客户端。
- **openai-responses**（`env.clientFormat==="openai-responses"`）：**形状异构**——无 top-level `messages`，是 `input` items 数组 + 独立 `instructions` 字段（[codec/openai-responses/codec.ts](../../src/lib/codec/openai-responses/codec.ts)）。剥离目标是某个 `input` item 或 `instructions` 文本 → accessor 与前两者**根本不同**。

**四客户端格式功能全覆盖 ≠ 四 accessor**：`client.inbound` 覆盖全部四种客户端入站格式（含 gemini），但实现只需**三个 accessor**（gemini 走 CC accessor）——这是「四格式全覆盖」的正确落地，非缩减。**若确需在 gemini 原生 `contents` 形状上改写**（而非 CC 翻译后），当前架构做不到（翻译早于 driver），须另设 route 层挂载点——记 [deferred-backlog.md](../todo/deferred-backlog.md)「gemini 原生 contents 改写需 route 层挂载点」节。

不变量恢复复用现有 primitive；helper `stripMessageBlock`/`mapClientMessages`（§4.2）按 `env.clientFormat` 分派到三个 accessor（gemini→CC）。此逻辑作为 helper 或用户自写皆可。

### 4.2 helper 工具箱

从稳定路径 `~/lib/pipeline/hooks` 导入（hook 文件在同进程加载，别名可解析——见 §6 工程约束）：

| helper | 产出 | 覆盖用途 |
|---|---|---|
| `sse(event, dataObj)` / `streamOf(frames, headers?)` | 单帧 / 打包成 UpstreamStream | 通用积木 |
| `mockAnthropicMessage(text)` | 格式合法完整 Anthropic SSE 序列（message_start→content_block_start→deltas→stop→message_delta→message_stop） | mock 上游响应 |
| `mockCcChunks(text)` | 格式合法完整 CC/OpenAI chunk 序列 | mock 上游响应 |
| `mockGeminiResponse(text)` | 格式合法 Gemini generateContent 响应 | mock 上游响应 |
| `mockUpstreamError(status, body?)` | 抛出真正的 `HTTPError`，其 `.responseText` 携带 `body`（见下契约） | 注入故障 + **驱动 reactive retry 腿**（核心动机） |
| `replayFromHistory(reqId \| filter)` | 从 history `upstreamResponse.sseEvents` 重建 UpstreamStream | 录制-回放（见 §5） |
| `delay(ms)` / `truncateAfter(n, stream)` | 延迟 / 断流包装器 | 注入延迟/断流 |
| `stripMessageBlock(env, predicate)` / `mapClientMessages(env, fn)`（v3，client-native 请求改写） | 按 `env.clientFormat` 分派到四格式 accessor，**不可变**删/改命中的消息块并恢复该格式不变量（§3.5 契约 + §4.1 不变量收口），返回新 env | `client.inbound` 生产改写（剥 TodoWrite 等） |

**`mockUpstreamError` 契约（评审 H3，已核实）**：核心动机是「驱动 reactive retry 腿」，但 reactive 策略的 `canHandle` 匹配依据是 `error.message` 正则 **与** `error.raw.responseText`（[tool-field-rejection-retry.ts:89](../../src/lib/request/strategies/tool-field-rejection-retry.ts#L89) 等），而 `classifyError` 只对 `instanceof HTTPError` 保留 `responseText`（[classify.ts:50](../../src/lib/error/classify.ts#L50)）。故 helper **必须**构造真正的 `HTTPError(message, status, responseText, …)`，`body` 序列化进 `responseText`。若只塞 `{type:"invalid_request_error"}`（如 §4.1 示例的简化），`canHandle` 不命中 → 核心用途**静默失败**。因此 helper 附带**命中各 reactive 策略的判别性 body 预设**：`mockUpstreamError.toolFieldRejection()` / `.serverToolRejection()` / `.unsupportedBeta()` / `.cacheControlSubfield()` 等（每个产出该策略正则能命中的 responseText 腔），并用**独立 oracle**（真跑一遍 driver 确认策略被触发）校验、而非自证。

**raw 逃生口**：`exchange` 可直接返回手构的 `UpstreamStream`（`frames` 为 `AsyncIterable<SseFrame>`），造**任意畸形帧序列**（原始动机）。helper 是便利层，非唯一途径。

**逃生口守卫语义（评审 L2）**：`exchange` 不调 `next` 返回的 mock 流**绕过** `guardSseIterable`（idle/shutdown/client-abort 守卫）与 adaptive rate-limiter（均在 `transport.send` 内、[driver.ts:310](../../src/lib/pipeline/driver.ts#L310) 之下）。这是设计使然（mock 无需真实守卫），但 helper 文档须提醒：手构 mock 流不具备 idle-guard 语义，若要测超时/断流须自行在 raw 逃生口构造。

**独立 oracle 校验**（TDD 纪律，非自证）：格式 helper 产出的帧序列必须用**独立的现有 accumulator**（`create*StreamAccumulator`）重放校验其合法性，而非拿 helper 自己的输出比对自己。

## 5. 录制-回放：复用 history.db

history 每请求已自动录上游原始帧到 `upstreamResponse.sseEvents: Array<SseEventRecord>`，`SseEventRecord = { offsetMs, type, raw, synthetic? }`（[src/lib/history/types.ts:142](../../src/lib/history/types.ts#L142)）。

**关键：`raw` 只是 `data:` 负载，不含 event 行（评审 H4，已核实）**。[driver.ts:440](../../src/lib/pipeline/driver.ts#L440)：`raw: frame.data ?? ""`，event 名单独进 `type`，且对无 event 行的帧被**伪造**成 `"message"`/`"keepalive"`（[types.ts:145](../../src/lib/history/types.ts#L145) 注释亦证）。这决定回放的保真度按格式分层：
- **Anthropic**：`frame.event` 恒有（`message_start` 等）→ `type` == 真 event 名 → **可无损 round-trip**（核心场景够用）。
- **CC/OpenAI、Gemini**：chunk **无 event 行** → `type` 被伪造成 `"message"` → 回放必须从 `type` 区分「真 event 名 vs 伪造标签」，对伪造标签 **不写 event 行**（否则注入上游从未发过的 `event:message`）。

`replayFromHistory(reqId | filter)`：
1. 按 `reqId`（或过滤器如 `{ model, endpoint, latest: true }`）查 history entry。
2. 取 `attempts.at(-1).upstreamResponse.sseEvents`（最终 attempt 的上游原始帧）。
3. 按上述格式分层把每条 `{type, raw}` 重建为 `SseFrame`：Anthropic 直接 `{event:type, data:raw}`；CC/Gemini 对伪造标签只 `{data:raw}`。产出 `AsyncIterable<SseFrame>`，包装成 `UpstreamStream`（headers 从记录的 `upstreamResponse` 头重建，缺失则空 Headers）。
4. **回放的帧进上游轨时打 `synthetic:"hook-replay"`**（§3.4——回放的是「历史真实帧的复制」，非本次真实上游通信，须可辨识）。

**M2 澄清（评审）**：上游-original track（`upstreamResponse.sseEvents`）的记录**从不含** proxy 合成的 keepalive/anchor 帧（那些只在 forwarded track `clientResponse.sseEvents` 有 `synthetic` 标记，[types.ts:148](../../src/lib/history/types.ts#L148)）。故回放读上游轨时**无需过滤 synthetic**（上游轨本就没有）——初稿的「过滤 synthetic 帧」是把两条 track 搞混的死逻辑，已删除。若确需回放含 keepalive 的 forwarded 视图，另提，读 `clientResponse.sseEvents`。

**零新录制路径**：录制天然已发生（每请求），回放只读。这是选「复用 history」而非独立 cassette 的核心收益。

## 6. config 声明 + 加载 + 仅 API 热重载

### 6.1 config section

新 `hooks` section（Zod `.strict()`，对齐 [src/lib/config/schema.ts](../../src/lib/config/schema.ts) 现有模式）：

```yaml
hooks:
  upstream_module: "./exp/my-hook.ts"   # 未设 = 特性完全关闭、零开销
  enabled: false                         # 默认 false；true 才加载
```

映射进 `state`（`hooksUpstreamModule` / `hooksEnabled`），登记 config 完整性矩阵。**完整触点清单（评审 L1 计数更正 + HIGH-1 补漏，均已核实）**：

1. `schema.ts` — 新 `HooksConfigSchema = z.object({...}).strict()` + `export type HooksConfig = z.infer<...>`（对齐 [schema.ts:883](../../src/lib/config/schema.ts) 导出惯例）。
2. `config.ts` — apply 映射（config → state）。
3. `state.ts` — `MutableState` 接口声明 **+** `mutableState` 初值字面量（[state.ts:1615](../../src/lib/state.ts#L1615) 引 `CONFIG_MANAGED_DEFAULTS`）——**两处编辑点**。
4. `CONFIG_MANAGED_DEFAULTS` — 登记默认值（见 HIGH-2 语义澄清）。
5. `resetConfigManagedState` — 重置逻辑（见 HIGH-2）。
6. setter。
7. **`route.ts:257 mergeConfigIntoDocument()`**（评审 HIGH-1 补漏）——PUT `/api/config/yaml`（config UI 写路径）为每个 nested section 显式写一行（[route.ts:257-304](../../src/routes/config/route.ts#L257)：history/openai_responses/shutdown/…）。**漏了它 config UI 就无法持久化 `hooks` section**（PUT 静默丢弃）。须补 `hooks` 分支。
8. bundled `config.yaml` 注释 + `/api/config` 完整性守卫测试（[tests/config/config-effective-route.http.test.ts:46](../../tests/config/config-effective-route.http.test.ts#L46) 强制任何进 `CONFIG_MANAGED_DEFAULTS` 的键出现在 `/api/config`）。

**HIGH-2 语义澄清（config 声明态 vs 实际生效态分离，已核实矛盾）**：`hooksEnabled`/`hooksUpstreamModule` 进 `CONFIG_MANAGED_DEFAULTS` 后会随 config 热重载/PUT 被 `applyConfigToState`（每请求，[config.ts:488](../../src/lib/config/config.ts#L488)）+ `resetConfigManagedState`（每次 PUT，[route.ts:131](../../src/routes/config/route.ts#L131)）改写，但**实际加载的 hook 模块单例**（`getUpstreamHook()`）只有 `POST /api/hooks/reload` 才重载。若不调和，`GET /api/config` 会显示声明态、实际跑的可能是旧模块——config 声明与生效态发散且不可观测。**决策**：
- `hooksUpstreamModule`/`hooksEnabled` 是 config **声明**（意图），进 state 正常（供 `/api/config` 显示意图）；但 `applyConfigToState` **不触发模块加载/重载**（模块加载只在启动期一次 + `POST /api/hooks/reload`）——即它们是「声明字段」而非「热重载生效字段」，spec 明确二者脱钩。
- 「实际生效态」（当前加载的模块 + 版本 + 上次重载结果）经独立的 `GET /api/hooks` 暴露（见 §6.5），与 `/api/config` 的声明态并存、可对账。

### 6.5 生效态可查面 `GET /api/hooks`（评审 MEDIUM-1）

§6.3 的 POST 回执是 ephemeral 的（只发起者可见）。新增 `GET /api/hooks` 返回常驻生效态：`{ enabled, declaredModule, loadedModule, loadedAt, version, exports: [...], lastReloadError? }`。`version`/`loadedAt` 用重载时的时间戳（§6.3 的 data-URL 唯一性时间戳）。回答「现在跑的是哪个模块/哪个版本、上次重载是否失败」——满足诊断诉求，对齐 richest-data-flow 常驻暴露富状态。

### 6.2 加载器（新 leaf `src/lib/pipeline/hooks/loader.ts`）

- **启动时**：`enabled && upstream_module` 已设 → 用 §6.3 的 data-URL 机制加载一次 → 校验导出形状（`export const hooks` 为对象，且其叶子 `client.inbound`/`client.outbound`/`upstream.inbound`/`upstream.outbound`/`exchange` 中至少一个存在且为函数）→ 存入 module-global。失败 → warn-continue，**绝不阻塞启动**、module-global 保持 `undefined`（直通）。
- **module-global 单例** + `getUpstreamHook()` getter（对齐项目 state/models 单例模式）；driver 经 getter 读取，未配置时为 `undefined` → 所有挂载点惰性直通、**生产零开销**。

### 6.3 仅 API 热重载

新端点 `POST /api/hooks/reload`（归属 `/api/hooks`，对齐 [src/routes/index.ts:88-94](../../src/routes/index.ts#L88-L94) 的 `/api/*` 管理路由）：

1. **加载机制（评审 B1，Bun 1.3.14 实测修正）**：读磁盘源 → `new Bun.Transpiler({ loader: "ts" }).transformSync(src)` → `import("data:text/javascript," + encodeURIComponent(js))`。每次 data-URL specifier 唯一 → 绕过 ESM 缓存重新加载。
   > **不用 `?v=` cache-busting query**（not-adopted）：初稿假设 `import(url + "?v=" + Date.now())` 是 Bun/Node 通用手法，但**实测为假**——Bun 按解析后的文件路径缓存、忽略 query string，`.ts`/`.mjs` 均静默返回旧模块。`?v=` 是 Node 专有手法。data-URL 方案实测重载成功，且**仍解析 `~/` 别名 import**（保住 §4.2 helper 契约——data-URL 模块与 exp/ 真实文件的别名解析均已实测通过）。详见项目记忆 [[reference-bun-esm-cache-busting-query-fails-data-url-works]]。
2. **校验形状**：成功 → **原子替换** module-global + 记 `loadedAt`/`version`；失败 → **保留旧 hook** + 返回错误 JSON + 记 `lastReloadError` + warn-continue，**绝不杀进程**（严格对齐项目 [config 哲学：警告并继续](../memory/feedback-config-philosophy-separate-compat-and-warn-continue.md)——运行时热重载绝不因配置/代码问题杀进程）。
3. **富数据回执**（`richest-data-flow`）：`{ ok, module, exports: ["client.inbound","exchange","upstream.inbound"], version, error? }`——`exports` 列出实际导出的叶子路径（点号扁平化），让调用者确认加载了哪些挂载点。常驻生效态另经 `GET /api/hooks` 查（§6.5）。

**不做 per-request mtime 检查**（用户否决）：改完 hook 文件 → 手动 `curl -X POST .../api/hooks/reload` → 即刻生效。

### 6.4 工程约束

ad-hoc hook 文件用 `import()` 在**同进程**加载（Bun 直接跑 .ts）。要用 `~/...` 别名 import helper，文件须处于别名可解析的位置——**测试用途建议放 `exp/` 或 `tests/`**（别名已配、符合项目 `keep-poc-in-project`）。**生产用途（v3）**：`client.inbound` 一类在真实流量上常驻的改写 hook 不必限于 `exp/`——放任意别名可解析位置皆可（如项目内 `hooks/` 目录）；不需 `~/` 别名的纯逻辑 hook 用相对路径 / 包导出亦可。对内部开发工具这是可接受约束，README/config 注释须说明「加载位置须别名可解析」这一条。

## 7. 正交微改动：根路径重定向

[server.ts:88](../../src/server.ts#L88) `server.get("/", (c) => c.text("Server running"))` → `c.redirect("/openapi.json")`。UI 仍在 `/ui`、`/ui-v4`，不受影响。**单独 commit**，与 hook 特性解耦。

## 8. 边界与暂缓

- **上游 WS（Responses ws:/responses）**：`exchange` 收口在 `Transport.send`，覆盖 http-transport（messages/cc/gemini）+ responses-transport 的 HTTP 腿。Responses 的**上游 WebSocket** 腿（[src/routes/responses/ws.ts](../../src/routes/responses/ws.ts)）是 transport-internal 的独立通道——本特性首版覆盖 `Transport.send` 边界即可（四用途在 http 腿全满足）；WS 腿的 hook 若需要，记 `docs/todo/deferred-backlog.md` 后续。
- **`client.outbound`（回客户端响应改写）命名预留、实现延后（v3）**：二维分组把它作为 `client.inbound` 的对称槽**暴露并命名**（在翻译回客户端之后、投递前改客户端形状的响应帧），但现有 spec 的响应侧只有 `upstream.inbound`（翻译回客户端**之前**的上游帧）。补 `client.outbound` 才让请求/响应两条路径对称完整，但需额外一个响应侧挂载点的实现 + provenance 不变量（回客户端合成帧须打 forwarded 轨标记，类比 §3.4）+ 与既有 translate/render 腿的交互——首版**不实现**、不建未用挂载点，作为声明式预留槽记 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)「`client.outbound` 响应改写挂载点」节（含语义、若做需改什么：新响应侧回调位置、forwarded 轨 provenance、四格式 render 腿交互）。
- **非流式响应**：`exchange` 返回的 `UpstreamStream` 可带 `nonStream`；helper 覆盖流式为主，非流式 mock 用 raw 逃生口构造 `{ nonStream, headers }`。
- **`upstream.inbound` 与 driver 现有 `RunResponseOpts.onUpstreamFrame`**（[types.ts:243](../../src/lib/pipeline/types.ts#L243)）：后者是 handler 内部的 upstream-original 采样 hook（观察用）。本特性的逐帧挂载点是 hook 分组对象叶子 `upstream.inbound`（v3 命名，与 driver 内部字段分属两层、无撞名）并**定位在 [driver.ts:446](../../src/lib/pipeline/driver.ts#L446) 采样之后**（§3.2），故上游-original track 天然记 pre-hook 真实帧、改写只进 forwarded 侧——初稿「留到实现时确认」的先后关系已在 §3.2/§3.4 钉死（评审 H2）。

## 9. 测试策略（TDD）

- **单元**：
  - 加载器：形状校验、**data-URL 重载**（改文件→重载拿到新版本，回归 B1）、warn-continue 不抛、失败保留旧 hook + 记 `lastReloadError`。
  - helper 工具箱：各 mock 产出合法帧序列——用独立 accumulator oracle 校验（§4.2），非自证。`mockUpstreamError` 的判别性 body 预设 → 真跑 driver 确认对应 reactive 策略 `canHandle` 命中（评审 H3，独立 oracle 非自证）。
  - driver 各挂载点触发：未导出=直通的**字节等价**；`exchange` 的 **L1×L2 调用多重性**（评审 M1，挂计数 hook 观测真实调用次数）；`client.inbound` / `upstream.outbound` 一次性（retry 多轮只调一次，评审 H1）。
  - **`client.inbound` provenance（v3 承重，§3.5）**：挂一个原地 splice `env.body.messages` 的 hook，断言 `clientRequest.body` 仍是原始客户端字节（正样本 oracle 证伪——失败即证需 driver 防御性 body snapshot）；挂一个不可变返回删块的 hook，断言 `clientRequest.body` = 客户端原样、朝上游 wire = 删块后（两轨发散可观测）。四格式各测一遍（client-native 形状按 `env.clientFormat` 分派）。
- **可观测性（评审 BLOCK-1/H2/MEDIUM-3，承重）**：
  - **`hook-mock`/`hook-replay`** 落**上游轨**（`attempts[].upstreamResponse.sseEvents`）：`exchange` 不调 `next` 的整个 mock 流带 `synthetic:"hook-mock"`、`replayFromHistory` 回放帧带 `synthetic:"hook-replay"`；真实上游帧**不带**标记（§3.4 决策 3、§5 步骤 4）。
  - **`hook-rewrite`** 落**forwarded 轨**（`clientResponse.sseEvents`，非上游轨——`upstream.inbound` 在 driver 上游-original 采样**之后**介入，改写只影响转发投递侧，§3.2/§3.4 决策 2）：`upstream.inbound` 改写/注入的单帧打此标记，**但仅 Anthropic `/v1/messages` 直连 + CC `/chat/completions` 直连腿可靠保留**（两者 `renderResponse` 逐字返回帧、`onRenderedFrame` 对象展开保留 Symbol 键）——**Responses 直连腿因 `restoreAndAccumulate`/`restoreAccumulateCount` 重建全新帧字面量而丢标**、**全部 translate 腿**（CC→Anthropic/Responses/Gemini 的有状态 N:1/1:N 累加器）因"改写单帧 vs 累加多帧"语义冲突而**标记归属 ill-defined**。这是一个已知、接受的可观测性覆盖缺口（非本特性阻断项），详见覆盖矩阵与理由 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)「`hook-rewrite` forwarded 标记覆盖缺口」节。
  - **上游-original track 记 pre-hook 真实帧**：挂一个改写 hook，断言上游轨是原始帧、forwarded 轨才是改写后帧。
  - `GET /api/hooks` 生效态 + 重载回执 `exports` 与**实际触发**的挂载点一致（挂带副作用 hook 观测真被调，非只信自报，对齐 `pass-null 不自证`）。
- **集成**（非 4141 端口起隔离实例，protect-user-main-server）：
  - 挂 `mockUpstreamError.toolFieldRejection()` hook → 实测 reactive retry 腿真被触发（原始动机）。
  - 挂 `replayFromHistory` → 实测离线回放某历史 entry、无 GHC 调用；Anthropic 无损、CC/Gemini 不注入伪造 event 行（评审 H4）。
  - `POST /api/hooks/reload` → 改 hook 文件后 data-URL 重载生效、坏 hook 保留旧 + warn + `lastReloadError` 可查。
  - **与 L2 buffered-retry 交互**（评审 L1）：`exchange` 与 `responsesBufferedRetry`/`protect_streaming_generation` 并存时的调用次序/次数定向测试。
- **golden 字节等价（评审 MEDIUM-2，机制指定）**：按 `large-refactor` skill 纪律——改动**前**用 master driver 代码对代表性输入预捕获输出作 golden fixture，branch 上同输入重放比对，证「hook 未配置时 driver 输出逐字节等价」（真实回归风险是新增的 `getUpstreamHook()` 读取 + phase 边界回调即便未配置也扰动热路径，非「早返回」那么浅）。

## 10. 活文档归属（收尾必更）

- [docs/DESIGN.md](../DESIGN.md)「活的架构现状」：新增 hook 挂载点行（driver 编排、四挂载点 `hooks.{client,upstream}.{inbound,outbound}` + `exchange`、config-gated）。
- 新 config section：[docs/DESIGN.md](../DESIGN.md) 配置节 + bundled `config.yaml` 注释。
- [docs/API.md](../API.md)：新增 `POST /api/hooks/reload` + `GET /api/hooks` 管理端点。
- ADR：hook 机制是新架构层，评审若认为够格则补 `docs/decisions/`（记「为何 driver 编排多挂载点而非 transport decorator」+「为何编程 hook 取代 config+regex 声明式引擎」）。
- 待评估 / 暂缓项：`docs/todo/deferred-backlog.md`——上游 WS 腿、`client.outbound` 预留槽、`hook-rewrite` forwarded 标记覆盖缺口、attempt 级 source / 请求侧改写诊断标记。

## 11. 评审裁决记录（record-not-adopted / 已核实）

### 11.1 v3 重构裁决记录（2026-07-14，命名体系 + 请求侧生产改写）

起点：用户要「剥离 messages 中的特定块（TodoWrite `role:system` 样板）」，从准确性 + 扩展性入手。经多轮收敛：

| 决策点 | 裁决 | 理由 / not-adopted |
|---|---|---|
| 机制载体 | **编程 hook** 取代 config+regex 声明式引擎 | config+regex（RewriteRule + role/target/position 扩展）灵活性不足——正则只能跑在「文本投影」上、删整条/整块 vs 子串替换的 match/action 分裂笨重；用户明确否决，改由外部 hook 编程决定改写结果。**not-adopted：config+regex 消息块过滤引擎**（连同 `RewriteRule.target` 扩展、四格式 accessor 引擎） |
| 归属 | 接入既有（未实现的）hook 中间件 spec，而非另起炉灶 | 该 spec 的 `onRequest`（旧名）字面上就是「hook 编程改写请求」；剥 TodoWrite = 一个 user-authored 请求 hook |
| 挂载位置 | 新增 **client-native、pre-translate/pre-sanitize** 挂载点 | 客户端注入的噪声只有在「客户端原样」时匹配才准；旧 `onRequest` 落在 translate+sanitize 之后、拿不到 client-native 形状、四格式退化为一种。not-adopted：复用旧 onRequest（准确性不足）/ 同时提供两个（YAGNI，client.inbound 已够） |
| 命名体系 | `on*` 一旦要区分 `onInboundRequest`/`onRequest` 就证明旧名不表意 → **整体重构** `hooks.{client,upstream}.{inbound,outbound}` + `hooks.exchange` | `client\|upstream` 轴直接编码 body 形状（作者最需一眼看懂的），优于「inbound/outbound request」（需先固定参照系）。not-adopted：对称 `on<Phase>`（on* 不再区分 observe/mutate 且与内部采样 sink 概念相邻）、`hooks` 嵌套对象但导出从扁平变嵌套 |
| observe 版本 | **不设**独立 observe-only 导出 | 用户反问成立：改写 hook `return undefined` = observe。旧 M3 防的是 hook 导出与 driver 内部采样 sink 撞名，非导出层需 observe 成员 |
| `client.outbound` | 二维分组**暴露**该对称槽，但首版**命名预留、实现延后** | 补它才让请求/响应对称完整（richest-data-flow 对称思维），但需额外响应侧挂载点 + provenance；against-YAGNI 不建未用挂载点，记 deferred-backlog（§8） |
| 请求侧 provenance | 新增 §3.5 承重不变量（对称于 §3.4） | `client.inbound` 改写不得污染 `clientRequest` 客户端原样轨；已核实 `orig.payload` 冻结先于 hook，靠不可变返回契约 + 实现期核实共享引用（防御性 snapshot）保证 |

### 11.2 v2 评审裁决记录（2026-07-12）

2 轮 subagent 对抗评审（general-purpose 可行性 + general-purpose config/可观测/可测）+ 主会话亲手实测核实。异模型第二意见（gpt-5.5）因 Anthropic `/v1/messages` 拒非-Anthropic vendor 而失败——**恰是本类特性要解决的问题**，已用第二个 Claude 角色补位。

| 发现 | 严重度 | 核实方式 | 裁决 |
|---|---|---|---|
| B1 `?v=` cache-busting 在 Bun 失效 | BLOCK | **亲手 Bun 1.3.14 探针复现**（`?v=` 返回旧模块、data-URL 重载成功且保 `~/` 别名） | **采纳**，§6.3 改 data-URL |
| BLOCK-1 = H2 mock/改写帧毒化 history 上游轨无标记 | BLOCK | 双评审交叉印证 + 读 [driver.ts:440](../../src/lib/pipeline/driver.ts#L440)（push 从不设 synthetic、在 446 前） | **采纳**，新增 §3.4 承重不变量 |
| H1 onRequest 落 retry 循环内 | HIGH | 读 [driver.ts:187-196](../../src/lib/pipeline/driver.ts#L187)（一次性点）+ 291 循环 | **采纳**，移到循环外一次性点 |
| H3 mockUpstreamError 须真 HTTPError+responseText | HIGH | 读 tool-field-rejection-retry.ts:89 + classify.ts:50 | **采纳**，§4.2 契约 + 判别性预设 |
| H4 raw 只存 data、CC/Gemini 回放有损 | HIGH | 读 [driver.ts:440](../../src/lib/pipeline/driver.ts#L440) `raw: frame.data ?? ""` | **采纳**，§5 格式分层保真 |
| HIGH-2 CONFIG_MANAGED_DEFAULTS 与仅-API 重载矛盾 | HIGH | 读 config.ts:488 + route.ts:131 | **采纳**，声明态/生效态脱钩 + GET /api/hooks |
| HIGH-1 = L1 config 触点漏 mergeConfigIntoDocument / 计数 | HIGH/LOW | 读 [route.ts:257-304](../../src/routes/config/route.ts#L257) | **采纳**，§6.1 完整触点清单 |
| M1 onExchange L1×L2 放大 | MEDIUM | 读 [driver.ts:751](../../src/lib/pipeline/driver.ts#L751) 第二调用点 | **采纳**，§3.2 调用多重性 |
| M2 §5 步骤4 过滤 synthetic 是空操作 | MEDIUM | 读 [types.ts:148](../../src/lib/history/types.ts#L148)（synthetic 仅 forwarded 轨） | **采纳**，删该步 + 澄清两轨 |
| M3 新挂载点与既有 onUpstreamFrame 同名 | MEDIUM | 读 [types.ts:243](../../src/lib/pipeline/types.ts#L243) | **采纳**，改名 `rewriteUpstreamFrame` |
| MEDIUM-1 无常驻生效态可查面 | MEDIUM | — | **采纳**，§6.5 `GET /api/hooks` |
| MEDIUM-2 golden oracle 机制未指定 | MEDIUM | — | **采纳**，§9 引 large-refactor 预捕获机制 |
| L2 mock 流绕过 guardSseIterable/rate-limiter | LOW | 读 driver.ts:310 之下 | **采纳**，§4.2 helper 文档提醒 |

**核实为「无问题」（记录以免复议）**：§3.1「6 处 handler 一行不改」成立（唯一 `deps.transport.send`）；§6.4 `~/` 别名对 exp/ 内 hook + data-URL 模块均实测解析；启动期 `import()` .ts hook Bun 可跑（失效的只是 `?v=` **重载**）；§7 根路径微改动平凡。

## 12. v3 迁移面清单（rename-migration，非 greenfield）

v3 是对 **shipped v2 机制**的破坏性重命名 + 新增。旧名 `onRequest`/`onExchange`/`rewriteUpstreamFrame`（扁平导出）→ 新 `export const hooks = { client:{inbound}, upstream:{inbound,outbound}, exchange }`（嵌套）。**迁移映射**：`onRequest`→`upstream.outbound`、`onExchange`→`exchange`、`rewriteUpstreamFrame`→`upstream.inbound`、新增 `client.inbound`。以下触点经 2026-07-14 全仓 grep + 逐个甄别（**已排除无关命中**：ui-v4 `LiveDock`/`ShadcnLiveDock` 的 `onRequestsList` 路由变量、`tui-retry-n-lines*.md` 的 `onRequestRetry` TUI 钩子——**均与本机制无关、绝不改**）。

**真功能触点（改逻辑/接口）**：
- [src/lib/pipeline/hooks/types.ts](../../src/lib/pipeline/hooks/types.ts) — `UpstreamHook` 接口从 3 个扁平可选字段 → 嵌套 `client?/upstream?/exchange?` 分组；`UpstreamHookState.exports` 语义（改为叶子路径如 `"client.inbound"`）。
- [src/lib/pipeline/hooks/loader.ts](../../src/lib/pipeline/hooks/loader.ts) — `HOOK_POINTS` 常量 + 形状校验从「pick 扁平具名 export」→「读 `mod.hooks` 对象、遍历嵌套叶子」；`setUpstreamHookForTests` 的 `Object.keys` 改为叶子路径枚举。
- [src/lib/pipeline/driver.ts](../../src/lib/pipeline/driver.ts) — 3 处 wire（当前约 :257 onRequest→`hook.upstream?.outbound`、:397 onExchange→`hook.exchange`、:549 rewriteUpstreamFrame→`hook.upstream?.inbound`）**+ 新增 `client.inbound` wire**（S1 parse 后、S2 `resolveRouteDecision`/translate 前，约当前 :232 之前）**+ 防御性 body snapshot**（§3.5）。
- [src/lib/pipeline/hooks/origin.ts](../../src/lib/pipeline/hooks/origin.ts) — 注释里的旧名（`rewriteUpstreamFrame`/`onExchange`）；功能码走通用 `frame-origin` 原语、无需改逻辑。
- [src/lib/pipeline/hooks/index.ts](../../src/lib/pipeline/hooks/index.ts)、[toolkit.ts](../../src/lib/pipeline/hooks/toolkit.ts)、[README.md](../../src/lib/pipeline/hooks/README.md) — barrel 注释 + toolkit 里旧名引用 + hook-author README 的两条承重警告改新名 + 补 `client.inbound` 用法 + `stripMessageBlock`/`mapClientMessages` 新 helper（四格式 accessor）。
- [src/routes/hooks/route.ts](../../src/routes/hooks/route.ts) — `/api/hooks` + reload 回执的 `exports` 列表语义（叶子路径）；openapi `version` 描述不变。
- **注释-only 触点**（改注释、不改逻辑）：[src/lib/pipeline/frame-origin.ts](../../src/lib/pipeline/frame-origin.ts)、[client-sink.ts](../../src/lib/pipeline/client-sink.ts)、[history/types.ts](../../src/lib/history/types.ts) 的旧名注释。

**测试触点**：`tests/pipeline/hooks/{driver-hookpoints.unit,driver-passthrough-golden.it,driver-provenance.unit,loader.unit,reactive-retry-leg.it,reload-and-l2.it,replay.it}.test.ts`、`tests/pipeline/hooks/fixtures/valid-hook.ts`、`tests/routes/hooks.http.test.ts`、`tests/e2e-client/harness/cli-refusal-hook.ts`（+ 引用它的 `tests/e2e-client/anthropic-cli.e2e.test.ts`）——全部 hook 文件/fixture 改新导出形状；**新增** `client.inbound` 四格式 provenance + 剥块单测（§3.5 决策 3、§9）。

**文档触点**：本 spec；ADR [2026-07-12-driver-orchestrated-upstream-hooks.md](../decisions/2026-07-12-driver-orchestrated-upstream-hooks.md)（补 v3 命名重构 + 「为何编程 hook 取代 config+regex」+ `client.inbound` 决策）；[DESIGN.md](../DESIGN.md) 活的架构现状 hook 行；[deferred-backlog.md](../todo/deferred-backlog.md)（旧名 → 新名 + 补 `client.outbound` 预留节）；skill `upstream-hook-mocking`（用法示例改新形状 + 补 `client.inbound` 生产用途）；memory [project-upstream-hook-middleware](../memory/project-upstream-hook-middleware.md) stub。**已完成的 6 文件 plan 文件夹** `docs/plan/2026-07-12-upstream-hook-middleware/` 是历史实施记录——**保留、不重写**，仅在其 README 头部加一行「命名已于 v3（2026-07-14）迁移，最新形状见 spec §3.2/§12」指针。

**commit invariants（large-refactor 纪律）**：① 每 commit 终态 typecheck 绿、无半迁移态（改了 `UpstreamHook` 接口就同 commit 改所有 wire 点 + loader + 测试 fixture）；② 迁移完成后全仓 `grep -E 'onRequest\b|onExchange\b|rewriteUpstreamFrame\b'` 对本机制应零残留（排除上述无关命中 + 历史 plan 文件夹）；③ 改动**前**按 §9 用 master 代码预捕获 passthrough golden，证「hook 未配置时 driver 输出逐字节等价」跨迁移不变；④ 迁移面广，收尾由 verifier 做 exhaustive 旧名审计（评审建议）。
