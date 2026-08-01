# Spec：上游传输 Provider 化 + curl 外部实现

状态：**v2.2 草案 —— 已过两轮 subagent 评审并逐条修订；§11 七条断言的取证轮尚未执行，未达「可进入计划阶段」** · 日期：2026-08-01 · 决策人：用户 · 撰写：主会话

关联：ADR `docs/decisions/2026-07-14-transport-config-three-axis-organization.md` · RFC `docs/spec/upstream-http2-transport.md`（**本 spec 勘误其中一条断言，见 §3.1**） · 实验 `exp/curl-transport-exe/` `exp/curl-transport-libcurl/` `exp/curl-transport-rst-arbitration/`

> **v2 修订说明**：v1 被两个独立 subagent 评审判为「需修订后再评」（0 Critical / 10 High / 3 Medium）。两处**事实错误**（§7.1 崩溃机制、§1 耦合面）已由主会话独立复核确认成立并改正。v1 把六项本应在 spec 冻结的契约推给了实现期，v2 逐一冻结。完整处置见 §12。

---

## 1. 问题

本项目所有 `https://` 上游走内建 `node:http2`，明文 `http://` 走 undici。根因是 **Bun × undici 的组合下 h1 与 h2 都永久 hang**（body 永不 finalize，`exp/upstream-models-hang/`）。三个缺口：

1. **`upstream_transport.http2.favor: false` 这个热回退口在 Bun 下是假的**——它回退到必挂的 undici，等于「关掉 h2 就没法工作」。
2. **明文 `http://` 上游仍骑在会 hang 的 undici 上**，只是响应小、暂未触发。
3. **没有任何 h1 能力**。TLS 终止型 MITM 代理给不了 h2 时 `awaitH2Handshake` 直接 reject，无 h1 回退。

### 1.1 真实的耦合面（v1 的「四个耦合点」不成立）

v1 声称 h2 与外界的耦合只有四处。两个独立评审各自搜索后均判**不成立**，主会话复核确认。真实迁移面：

| # | 耦合类别 | 位置 | v1 是否列出 |
|---|---|---|---|
| 1 | 请求选路与调用 | `transport/upstream-fetch.ts:41,72-87`（`http2Fetch` + `getUpstreamH2Favor`） | ✅ |
| 2 | 状态快照（**五个符号**，不止两个） | `transport/status-snapshot.ts:23-35,103-115`：`H2SessionStatusRow` / `getH2SessionStatusSnapshot` / `getH2ReconcileStatus` / `getSessionConnectTimeoutMs` / `getUpstreamH2PingIntervalMs` | 部分 |
| 3 | 关机 | `shutdown.ts:606,696` `closeHttp2Sessions()` | ✅ |
| 4 | **shutdown provenance** | `shutdown.ts:256-268` 把 `pool-closed` 当作 shutdown 成因 | ❌ |
| 5 | **错误分类法** | `packages/foundation/src/error/transport-reason.ts:32-37` 的 `pool-closed` 是 h2 专属概念，已进 foundation | ❌ |
| 6 | **UI 直接消费 h2 专属形状** | `ui-v4/src/components/overview/OverviewShadcn.tsx:67-70,151-215`（逐字段读 `lifecycle`/`origin`/`generation`/`activeStreamCount`/`effectivePingIntervalMs`/`effectiveKeepAliveMs`）、`OverviewLegacy.tsx:45-49`、`ui-v4/src/types/status.ts:23-26,41` re-export | ❌ |
| 7 | **HTTP 测试断言旧 shape** | `tests/infra/management-routes.http.test.ts:480-488` | ❌ |
| 8 | **h2-only 回调挂在通用 init 上** | `transport/upstream-fetch.ts:44-57` 的 `onTrailers`/`onStreamClosed` → `send.ts:218-219,263-269` → `http-transport.ts:92-95` | 正文提及，未入表 |
| 9 | 直接耦合 h2 实现导出的测试（8 个文件） | `tests/transport/http2-*.{it,unit}.test.ts`、`tests/shutdown/shutdown-h2-pool-drain.it.test.ts`、`tests/architecture/generation-engine-boundaries.unit.test.ts` 等 | ❌ |

**反向修正**：`reconcileH2SessionsForConfigChange` **不是**对外耦合点——它在 `transport/http2-client.ts:686-692` 由模块自己订阅 `onUpstreamTransportChange`，生产代码无外部调用者。v1 把模块内部细节列成了外部契约。

⇒ 结构问题的准确表述不是「四个动词没被命名」，而是：**「发一个请求」是可替换的，「一个传输提供者的选路、生命周期、可观测性与错误身份」不是**，且其中三项（4/5/6）已经泄漏出 transport 目录，进了 foundation 与前端。

## 2. 目标

- **G1** 把传输实现的选路、生命周期、可观测性、错误身份抽成协议无关的三层契约（§4）。
- **G2** 引入 curl provider，**能服务任意 h1/h2 路径**——协议不绑定 provider 身份。
- **G3** 让「某 provider 做不到某件事」成为一等公民：能力声明 + 诊断可见 + 告警，绝不沉默退化（§4.2、§5）。
- **G4** 明文 `http://` 上游脱离 undici。**注意**：复评取证显示这条的既有理由是假的——注释里那个「本地 SearXNG」明文上游**不存在**（已退役特性的陈旧引用，详见 §4.3）。G4 的真实内容因此变为：**undici 在 HTTP 路径上已无活的消费者，应整体退役**（仅 upstream WebSocket 仍裸用 undici，不受影响），而不是「把 SearXNG 从 undici 挪到 curl」。

### 非目标

- **不**让 curl 成为默认 h2 传输（默认仍 `node:http2`，理由 §5）。
- **不**引入进程内 libcurl（理由 §6，**暂缓非否决**）。
- **不**为 curl provider 复刻池治理——每请求独立进程使这些机制失去对象。

## 3. 实证基础

三份 PoC，可复跑脚本与原始输出在 `exp/` 下。

### 3.1 对既有 RFC 断言的**部分**勘误

RFC `docs/spec/upstream-http2-transport.md:7-10` 记有「Bun 的 `node:http2` 对任何中途连接终止都交付 synthetic clean `end`——**clean server RST 与完整连接 drop 皆然**」。

**RST 那半不成立；连接 drop 那半成立。** 二者的原始探针用了不同 API：

| 原始探针 | 制造方式 | 忠实性 | 该半断言 |
|---|---|---|---|
| `exp/upstream-models-hang/probe-rst-events.mjs:3` | `stream.close(NGHTTP2_INTERNAL_ERROR)` | ❌ **不发 RST 帧** | **作废** |
| `exp/upstream-models-hang/probe-drop-events.mjs:4` | `session.destroy()` | ✅ 忠实 | **成立** |

改用 `stream.destroy(new Error())` 造出忠实 RST 后，在**无 Content-Length 的 SSE 流**上四个客户端**全部**检测到 `rst=2`：curl exe (92)、进程内 libcurl (92)、Node 上的 `node:http2`、**Bun 上的 `node:http2`**（`exp/curl-transport-rst-arbitration/`，oracle 为 `oracle-faithful-rst.mjs` 变体 B）。

⇒ **「curl 比现役更诚实地报截断」这个动机只在「整连接 drop」一格成立**，而该场景对 SSE 已有应用层 `message_stop` / `[DONE]` 兜底。curl 的价值应按 **h1 能力**评估，不按「更诚实的 h2」评估。

> 教训：Node h2 服务端的 `stream.close(code)` 在「已写过 DATA、未 END_STREAM」形态下不在 wire 上放出 RST 帧。项目 skill 原只记载 Bun 服务端不忠实——**Node 服务端在此形态下同样不忠实**。本轮两个 PoC 加主会话三方全被它骗过。须写进 skill `debugging-ghc-api-upstream-transport`（该 caveat 现有归属，见 §8 注）。

### 3.2 curl 的能力与代价

| 能力 | 实测 |
|---|---|
| h1 / h2、流式增量 | ✅ `-N` 增量交付 |
| 代理（http / https / socks5 / `--proxy-http2`） | ✅ 四条全通，隧道内仍协商 h2 |
| TCP keepalive | ✅ `--keepalive-time` 落内核（`ss` 见秒级锯齿，非 OS 默认 7200s） |
| 大 body 全双工 | ✅ 32MiB `--data-binary @-`，10 次复跑无死锁 |
| h1 截断检测 | ✅ Content-Length 短读 / chunked 缺结束块均 exit 18 |
| trailers | ✅ 能透出，但**只能进程退出后从 dump 文件读** |
| abort | ✅ SIGTERM median 0.874ms，60 次无僵尸 / fd 泄漏 |
| **周期 h2 PING** | ❌ 见下 |
| **跨请求连接复用** | ❌ 每请求一进程 |

**h2 PING 的否定性取证**（五条独立证据 + 正样本对照：同一 oracle 上 `session.ping()` 让计数 0→1，证明 oracle 不恒零）。**断言范围按评审意见收窄**：*当前受支持的 curl CLI 公共接口没有可配置的周期 h2 PING*（curl 8.5.0 `--help all` 无相应选项；libcurl `CURLOPT_UPKEEP_INTERVAL_MS` 下 66 次 `curl_easy_upkeep()` 全返回 0 而 oracle 观察到 0 个 PING 帧——upkeep 够不到在途 transfer）。**不**外推为「任何 curl 版本 / 私有 patch / 直调 nghttp2 都不可能」。故 `probe()` 须按**实际 binary** 校验能力，不按版本号推断。

**连接复用代价**（`api.github.com/meta` 连续 20 次，**单机单 host 20 样本的量级观察，非正式 benchmark**）：curl 每次冷连接 TTFB median 42.8ms / p95 114.0ms，pooled `node:http2` 5.4ms / 10.6ms；另有每请求约 7-8ms 进程开销。

## 4. 契约（三层）

v1 把 provider、选路策略、registry 混成一个对象，导致 `auto` 无法自洽表达（它同时使用两个实现，而接口却说「选中的 provider」）。v2 拆三层。

### 4.1 层一：`UpstreamTransportProvider`——单个实现

```ts
interface UpstreamTransportProvider {
  readonly id: ProviderId                 // "http2" | "curl" | "undici"
  readonly protocols: ReadonlyArray<"h1" | "h2">
  /** 校验**实际 binary / 运行时**的能力，不按版本号推断。不可用即抛。 */
  probe(): Promise<void>
  fetch(url: URL, init: UpstreamFetchInit): Promise<Response>
  readonly capabilities: ProviderCapabilities
  statusSnapshot(): ProviderStatusDetails
  /** 幂等。force 模式须 await 全部在途资源释放（curl: 全部 child reap）。 */
  close(options: { mode: "force"; reason: unknown }): Promise<void>
}
```

`auto` **不是** provider id，是 selection mode。

### 4.2 层二：`UpstreamTransportSelectionPolicy`——选路

```ts
type SelectionMode = "auto" | ProviderId
interface SelectionOutcome {
  provider: ProviderId
  /** 供 curl 决定 --http1.1 / --http2 / --http2-prior-knowledge（§7.2） */
  protocol: "h1" | "h2"
}
/** 纯函数，可单测，不持有实例 */
function selectProvider(url: URL, mode: SelectionMode, cfg: CurlConfig): SelectionOutcome | SelectionError
```

### 4.3 层三：`UpstreamTransportRegistry`——实例化、probe、聚合、关机

持有**所有已实例化 provider**（不只是「下一请求会选中的那个」），负责：启动期 probe 当前选路模式**可达**的每个 provider；聚合 `/api/status`；shutdown 时 force-close **全部** provider 并 await 其在途资源。

#### 可达性的权威定义（v2 的版本被复评推翻，此处重写）

**先纠正一个贯穿全仓的事实错误**：注释里反复出现的「唯一的明文 `http://` 上游（本地 SearXNG）」——`packages/foundation/src/state.ts:751,1500`、`config/schema.ts:1099`、`proxy.ts:7,12`、`transport/upstream-fetch.ts:62,83`、`models/timeout-resolver.ts:13`——**是陈旧引用，指向已退役的 web_search 双跳特性**。全仓无 SearXNG URL 配置、无请求实现。**undici 当前服务的明文路径没有活的消费者。**

当前唯一可能产生明文上游的途径是用户把 `ghc_api_base_url` 配成 `http://`，而它是**启动期字段**、不热重载（`packages/cli/src/start.ts:341-343` 经 `setCliState` 写入；`config/config.ts` 的 `applyConfigToState()` 不触及它；`routes/config/route.ts:212-219` 明列为 startup-phase field）。

⇒ 可达性判定改为**权威的 upstream-origin inventory**，而非模糊扫描配置：由启动期已解析的上游 origin 集合（当前生产调用点见 `token-runtime.ts:58`、`openai/embeddings.ts:67`、`transport/send.ts:263`、`models/client.ts:49`、`copilot-api.ts:128`、`anthropic/client.ts:89`）计算得出。`auto` 下 `https` 恒可达 `http2`；`curl` 仅当 inventory 中存在明文 origin 时可达。显式 `provider: curl` 则恒可达。

#### 配置变更：candidate-config preflight（v2 的「拒绝该次重载」不可实施）

v2 写「拒绝该次重载并保留旧配置」。复评指出**现役 apply 是非事务性的**：`config/config.ts:683-1064` 在到达 transport 段（`:1066-1096`）之前已修改大量 global state，之后继续改到 `:1219-1222`；HTTP PUT 路径更是**先写盘再 reset+apply**（`routes/config/route.ts:151-159`）。故在 transport 阶段抛错时，部分新配置已生效、磁盘已是新配置、旧配置并未保留，`resetConfigManagedState()` 还可能把未重新应用的字段打回默认。

**冻结为 preflight，而非事后 rollback**：

```text
load + validate candidate config
  → 计算 candidate 的 upstream-origin inventory
  → 计算 selection 与可达 provider 集
  → probe 新可达 provider
  → 全部成功后才 apply 到 state
```

失败则**不写 state**；HTTP PUT 须在 probe 成功后才替换磁盘配置（或写临时文件后原子 rename）。相比跨大量 setter 做 rollback，这是长期正确的形状。

#### 请求期 lazy probe invariant（复评新增）

provider 入口接受任意 `URL`。未来的 hook、新上游模块或 per-origin 配置可能在**没有 config reload** 的情况下首次提交 `http://` URL，而 curl 因启动期「不可达」未实例化。故补一条请求期不变量：

- selection 选中尚未 `ready` 的 provider 时，registry 以 **single-flight** 方式执行 lazy `probe()`。
- 成功则 dispatch；失败则该请求**明确失败**，**不得静默 fallback**。
- 启动期 / preflight probe 仍是**已知可达** provider 的前置门禁；lazy probe 只覆盖事先无法枚举的动态 URL。

### 4.4 `ProviderCapabilities`——按对外保证建模，不按 curl 缺口反向拟合

v1 的五个 boolean 是照着 curl 缺什么设的，且混淆了「底层原语限制」与「provider 对 consumer 的保证」。v2 用带级别的联合类型 + 按真实运维维度拆分：

```ts
type CapabilitySupport =
  | { level: "supported" }
  | { level: "unsupported"; reason: string }
  | { level: "not-applicable" }              // 例：curl 走 h1 时的 h2Ping
  | { level: "conditional"; condition: string }
  | { level: "unknown"; evidenceGap: string }

interface ProviderCapabilities {
  keepalive: { tcpProbeDelay: CapabilitySupport; h2Ping: CapabilitySupport }
  connectionReuse: { acrossRequests: CapabilitySupport }
  /** provider 的准入能力——与「有没有连接池」无关：curl 每请求一进程，同样可用 semaphore/FIFO 提供 */
  admission: { maxConcurrency: CapabilitySupport; queueing: CapabilitySupport }
  /** 连接生命周期。`protocolDrain` 而非 `goawayDrain`——GOAWAY 是 h2 专有帧名，不该写进通用契约 */
  connectionLifecycle: { idleReap: CapabilitySupport; protocolDrain: CapabilitySupport }
  trailers: { capture: CapabilitySupport; deliveryBeforeBodyEnd: CapabilitySupport }
  truncation: { h1Framing: CapabilitySupport; h2Rst: CapabilitySupport; connectionDrop: CapabilitySupport }
  /** 原语级限制与实证出处，**不**冒充对外契约 */
  readonly limitations: ReadonlyArray<{ note: string; evidence: string }>
}
```

关键区分：`trailers.deliveryBeforeBodyEnd` 对 curl 是 **`supported`**——因为 §7.1 冻结的延迟终止让 provider 对 consumer 仍满足该保证（现役 SSE decoder `transport/send.ts:134-157` 与 `guardSseIterable`（`packages/foundation/src/stream.ts:419-448`）都只在 inner iterator 返回 `done` 时才视为自然完成，故 `onTrailers` 必先于 body terminal 被观察到）。curl 原始产物只能事后读，那是 `limitations` 里的事实，不是对外契约。

**语义须收紧**：`deliveryBeforeBodyEnd: supported` 表示「**凡 provider 成功捕获并交付的** trailers，交付必先于 body terminal」，**不**表示所有上游 trailers 都必然被正确捕获——后者由 `trailers.capture` 表达。否则两个字段会被误读为重复。

**性能数字不进 capability 语义，进 `limitations`。**

#### 被删除的两个字段（复评抓出的过度设计）

v2 曾有 `connectionReuse.withinDispatch` 与 `truncation.semanticTerminal`，均已删除：

- `withinDispatch` 是 curl `--next` PoC 的残影。provider 的 `fetch()` 一次只发一个物理请求，现役 `UpstreamDispatchLifecycle` 也明确拥有「一项 physical upstream dispatch」（`pipeline/types.ts:61-75`），正式实现不会在一次 dispatch 内发多个 URL。该字段不参与选路、告警、状态或生命周期——**无消费者**。`--next` 的实验证据留在 PoC 与 `limitations`。
- `semanticTerminal`（`message_stop` / `[DONE]` 是否构成完整终止符）属于 **codec / stream accumulator**，不属于 HTTP provider。所有 HTTP provider 对它都只能答同一个 `not-applicable`，驱动不了任何 provider 选择或诊断。它是从本轮「curl 截断是否有应用层兜底」的讨论反向生成的字段。

## 5. curl 服务 h2 时用户实际会看到什么

v1 只说「能力回退」，没定义可观察行为。缺 h2 PING 不是状态页上一个 `false`，它按故障形态与 endpoint 表现不同：

| 故障形态 | 检测机制 | Buffered endpoint（CC / Responses 默认开） | Live 或已 commit 的 endpoint（Anthropic 默认**未**开） |
|---|---|---|---|
| 中间设备 / edge 主动断连接 | curl 非零 exit → stream error | 未 commit 时可透明重试 | 终止并向客户端报错，保留 partial |
| 中间设备静默 blackhole | 应用层 `stream_idle` 超时 | 超时后按 buffered 策略 | 超时终止 |
| 长 thinking 但连接仍活 | 无上游帧 | 下游合成 heartbeat 只保 client↔proxy 腿 | 同左 |
| **缺 h2 PING 导致中间设备 idle reap** | **无预防手段** | 只能故障后恢复 | **可能直接断流** |

依据：`transport/http2-client.ts:228-260`（现役 PING）、`:126-175`（经 proxy 先建隧道再叠 TLS+h2，故 `setKeepAlive` 只覆盖我方↔proxy 腿）、`packages/foundation/src/stream.ts:340-458`（idle guard）、`state-defaults.ts:120-125`（Anthropic 默认不保护）/`:138-140`/`:277-283`（CC、Responses 默认开）、`pipeline/driver.ts:1390-1431`（仅未 commit 可重试）。

**「唯一」的准确表述**：h2 PING 是*现役实现中*长静默期间唯一会在完整 h2 路径上周期产生帧的机制——不是理论上不存在别的可设计机制。

**启动告警文案须具体**，不能只说「无此能力」：应说明该选择可能使经代理的长 thinking 在 `stream_idle` 触发前就被中间设备断开，且 **Anthropic 端点默认没有透明 buffered retry**。

用户已知悉此代价并要求保留该能力路径（2026-08-01 裁决）。本 spec 不禁止，只如实声明。

## 6. 为什么本轮不用进程内 libcurl

| 路径 | 结论 |
|---|---|
| `node-libcurl` | **Bun 下 panic**：`unsupported uv function: uv_timer_init` |
| Rust + napi-rs | **未验证**——本机无 Rust toolchain，spike 停在构建门口 |
| `bun:ffi` + 系统 libcurl | Bun 侧能力面基本跑通，但 **Node 不支持 `bun:ffi`** → 运行时分裂 |

**理由更正**（v1 说「唯一实质优势是连接复用」，与本节自身叙述矛盾）。进程内路径相对 CLI 的**已知优势**是：跨请求连接复用、**实时 trailers header callback**（恰好能免掉 §7.1 那整套延迟终止的复杂度）、免每请求 spawn 开销、比 exit code + stderr 更直接的错误信息、更低延迟的 abort。

**不采用的真实理由**是这五条，与优势多少无关：① 无同时支持 Bun + Node 的成熟绑定；② Bun FFI 造成运行时分裂；③ Rust 路径未构建验证；④ multi driver、`ReadableStream` backpressure、teardown barrier 全未实现；⑤ 部署条件不满足——本机 `libcurl.so.4` 存在但 `pkg-config libcurl` 与 curl headers **均不存在**，「运行库存在」不等于「可本机编译绑定」。

> **暂缓非否决**。若未来出现 Bun/Node 双可用绑定、或 h2 PING 在 libcurl 侧成立，应重新评估。入 `docs/todo/deferred-backlog.md`。

## 7. curl provider 的冻结契约

### 7.1 终止时序（v1 把它推给了实现期——v2 冻结）

**先纠正 v1 的事实错误**：`setOutboundResponseTrailers`（`src/lib/context/request.ts:1297-1301`）是一句直接赋值，**没有** `assertWritable`、不检查 `settled`、不经 recorder；实测 settle 后调用不抛错。v1 引用的 `assertWritable` 位于 `context/model-operation-record.ts:680-682`，属另一个 recorder，与这条腿无接线。

**真实风险是数据不一致**：该 setter 的注释写明前提「The transport fires this **before** stream end, so it lands before `complete()/fail()` snapshots the entry」，而 attempt-settle 快照在 `request.ts:753` 读取 `_httpHeaders.outboundResponseTrailers`。curl 若在 settle 后才交付 trailers，不会崩溃，但 trailers **静默不进已封存的 History / operation record**。

**冻结顺序 A：producer-driven terminal**（进程自然退出或自行失败，**且 consumer cancellation 尚未获胜**）：

1. stdout 数据**实时**交付 body consumer。
2. **stdout EOF 只表示「没有更多 body 字节」，不表示 Response 成功结束。**
3. 在 `proc.exited` 的 settlement callback 中**同步**抢 `process-exit` latch（§7.5）。
4. 读取并解析 dump fd。child 退出后它已是本地完整文件，**不得再等任何外部事件**——latch 与 body terminal 之间引入异步 yield，会让晚到的 shutdown 在 outer guard 层改写更早发生的 transport failure，绕过 latch 的目的。
5. 若成功且存在 trailers，**先**调用 `onTrailers`。
6. **最后**按 exit / abort 状态执行 `controller.close()` 或 `controller.error()`。

**不选「静默丢 trailers」**：既违反 richest-data-flow，也会掩盖退出分类。步骤 2 是承重的——curl 的 exit 18/92 只有进程退出才确定，若 EOF 即 `close()`，consumer 已见成功完成，再无法改判 `mid-body-close`。

#### 顺序 B：consumer-driven cancellation（v2 错把它塞进顺序 A——此处拆开）

现役 disposal 会沿 iterator 链取消 raw `Response.body`（`dispatch-lifecycle.ts:50-78` → `stream.ts:394-417,450-453` → `send.ts:158-163`；未开始消费时直接 `response.body.cancel()`，`send.ts:46-81`）。故 curl provider 的 `ReadableStream.cancel()` 须执行：

```text
记录 consumer cancellation（置不可逆的 consumerCancelled）
  → 尝试赢得 local-abort terminal-cause latch
  → SIGTERM → await proc.exited
  → 清理 fd / listener
  → resolve cancel()
```

**`consumerCancelled` 一旦为 true 即不可逆，且是 callback gate**：此后**不得**执行顺序 A 的第 5、6 步——不再调 `onTrailers`、不再 `controller.close()/error()`。否则会在上层已按 timeout / shutdown / client abort settle **之后**产生 late callback，重新制造本节要消灭的 History 数据分叉；对已取消的 controller 再 close/error 也可能抛无意义状态错误。

**为什么单靠 §7.5 的 latch 不够**：存在这样的竞态——① process exit 先赢得 `terminalCause`；② dump 尚未解析、controller 尚未 terminal；③ client abort / shutdown / idle timeout 触发，outer `guardSseIterable` 立即走 abort 分支（它**独立** race 原始 abort signal，`stream.ts:423-445`）；④ provider 随后才解析到 trailers。此时即使 provider 内部 latch 已判给 process-exit，上层也已按 abort settle，provider **不能**再交付 trailers。故需要两个独立状态：`terminalCause` 决定**失败身份**，`consumerCancelled` 决定**此后是否还允许回调**。

#### 等待窗口的有界性

stdout EOF 之后等待 child exit 的窗口**仍受现役 stream idle timeout 约束**。`guardSseIterable` 对每次 `inner.next()` 分别起 idle timer（`stream.ts:419-428` → `:251-293`），计时基点是**最后一个已交付 SSE event 之后发起的那次 `next()`**，不是 stdout EOF。故：

- 正常情况 stdout EOF 与 child exit 几乎相邻，额外窗口很短。
- curl 关了 stdout 却迟迟不退出时，idle timeout 先获胜并取消 child——这是**合理**的：此时 provider teardown 已卡住，idle timeout 提供了现成的有界退出，且它不会把完整响应误判成功。
- **若 timeout 先发生，它是 consumer-driven cancellation（顺序 B），不得继续走 producer-driven success terminal。**

#### 延迟 settle 是资源真实性，不是 lifecycle 卡死

自然路径形成全序：`stdout EOF → proc.exited → 解析 dump → onTrailers → controller.close/error → SSE decoder done → guardSseIterable done → dispatch quiesced → dispatch settlement → operation finalization`。现役代码支持它：`dispatch-lifecycle.ts:128-139`（只有 inner 返回 `done` 才 `complete()`）、`:43-48`（`complete()` 才 resolve `quiesced`）、`generation/dispatch-scheduler.ts:324-331`（settle 前等 `quiesced`）、`context/request.ts:847-861`（finalizer 等 operation scope quiesce）、`context/manager.ts:378-397`。

⇒ `whenModelOperationFinalized()` 会等到 child exit，这**是正确行为**：child / fd / 晚到 callback 未结束就宣称 operation finalized 是假完成。有界性靠 idle timeout、Phase 3 abort、Phase 4 force-close 三道，**不靠提前 resolve lifecycle**。

### 7.2 协议参数映射（冻结）

| `http_version` | scheme | curl 参数 |
|---|---|---|
| `h1` | 任意 | `--http1.1` |
| `h2` | `https` | `--http2`（ALPN 协商） |
| `h2` | `http` | `--http2-prior-knowledge`（**普通 `--http2` 在明文上只是 Upgrade 语义，不等价**） |
| `auto` | `https` | `--http2`（ALPN，可降 h1） |
| `auto` | `http` | `--http1.1`（明文默认 h1；「curl 能服务 h2c」须显式 `h2`） |

### 7.3 wire parity（v1 完全遗漏）

curl 会**自动添加** caller 未提供的 header（`User-Agent`、`Accept: */*`、`Content-Type: application/x-www-form-urlencoded`、大 body 的 `Expect: 100-continue`），并**自行读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量**。现役 h2 adapter 则强制 `accept-encoding: identity` 并过滤 h2 非法 header（`http2-client.ts:73-85,1001-1011`）。直接套用会**静默改变上游看到的 wire**。

冻结：

- `method` / headers / body 以 `UpstreamFetchInit` 为**唯一**输入；显式抑制 curl 自动生成而 caller 未提供的 header。
- 保持 `accept-encoding: identity`。
- transport-owned / h2 非法 header 的处理抽**共享 primitive**，不由各 provider 各写一份。
- **禁止 curl 自读代理环境变量**：先由 `getProxyUrlForOrigin()`（`proxy.ts:228-244`，唯一入口，含 NO_PROXY 语义）决策，再显式传「用此代理」或「明确不用代理」。
- 保留 `socks5` 与 `socks5h` 的 DNS 解析位置差异，不都映射成 `--socks5`。
- 空值 header 写 `X-Empty;`（`X-Empty:` 会被 curl 解释为**移除**内部 header）。

### 7.4 流式响应头获取（v1 遗漏）

`fetch()` 必须在**最终响应头**到达后 resolve `Response`，body 随后持续流式消费。但 metadata 在普通文件 fd 里，PoC 只证明「进程退出后可靠读取」。冻结：

- 父进程**增量**读该匿名文件 fd（有界轮询 / `pread`），而非等进程退出。
- 须识别 interim（1xx）、proxy CONNECT、认证重试等多个 header block，选定**最终** response header block；退出后把**最后**一块识别为 trailers。
- final headers 可用前，stdout 预读缓冲有**显式上限**并施加 backpressure。
- headers 到手立即 resolve `Response`；body 终止仍按 §7.1 步骤 2 等 child exit。

### 7.5 错误分类（v2 的静态优先级有因果竞态——v2.1 改为 latch + 子优先级）

**exit code 空间不是封闭联合**，不能用 `Record` + `never` 声称穷尽。

#### 第一步：first-terminal-cause latch（决定大类）

v2 用一个静态五级优先级，复评指出它有**因果竞态**：若上游已发忠实 RST、curl 已 exit 92，而 JS 尚未处理 `proc.exited` continuation 时恰好触发 request deadline 或 shutdown，静态优先级会把**真实的上游失败改判成本方 abort**。反向场景（signal 先到、我方发 SIGTERM、child 随后退出）则确实应由 abort 获胜。二者的区别不是「谁优先」，是**谁先发生**。

故大类由**不可逆 latch** 裁定，谁先在 producer boundary 赢得它谁定性：

```ts
type TerminalCause =
  | { kind: "local-abort"; reason: unknown }
  | { kind: "process-exit"; exitCode: number | null; signalCode: string | null; headersReceived: boolean; stderr: string }
```

这与现役 `AbortSignal.any` 的「第一个 aborted source 的 reason 胜出」同构（`transport/send.ts:285-288`），也与本项目「中止成因在产生点打标签、别在边界猜」的既有纪律一致。

#### 第二步：`process-exit` 胜出时的子优先级

1. **经忠实 oracle 验证的 `REFUSED_STREAM`** → `refused-stream`（可重试）。见下方证据契约。
2. headers 到达**前**、且属**白名单内语义已验证**的 exit → `pre-response-close`（可重试）。
3. headers 到达**后**的截断（exit 18/92/28/56）→ `mid-body-close`（不可重试）。
4. 其余一律 → `unknown-transport`（**不可重试**）：spawn 失败、exit 23、未知 exit code、非我方发出的 signal。**即使发生在 headers 之前也走这一档**，不得因「在 headers 前」而落入第 2 档的可重试语义。

#### REFUSED 的证据契约（v2 自相矛盾，此处更正）

v2 说「stderr 字符串仅作 defense-in-depth，主判据是 exit code」——**错**。curl 的 exit 92 只表示 h2 framing/stream error，区分不了 `REFUSED_STREAM(7)` 与 `INTERNAL_ERROR(2)`：本项目自己的裁决数据里，忠实 `INTERNAL_ERROR` 同样是 exit 92（`exp/curl-transport-rst-arbitration/FINDINGS.md`）。故：

- 若忠实 oracle 证明存在稳定、locale-independent 的 machine-readable 输出能区分 code 7 → 以它为主判据。
- 若实际只能解析 stderr → **承认 stderr parser 就是主判据**，并在解析失败时安全降级为 `unknown-transport`，**绝不凭 exit 92 猜 REFUSED**。
- **oracle 闭合前，第 1 档保持 disabled。**

#### `unknown-transport` 必须是结构化的（否则本条不可执行）

复评指出并经主会话复核：现役 `TransportErrorReason`（`packages/foundation/src/error/transport-reason.ts:38`）只有 `pre-response-close | refused-stream | mid-body-close | pool-closed`，**没有 unknown**；而 `classify.ts:151` 对未识别 Error 做宽泛 `isNetworkError` message 匹配 → `network_error`，`request/strategies/network-retry.ts:27-41` 会重试它。

⇒ 若 curl 的 unknown 只是抛一个含 “curl/connection/timeout” 字样的普通 Error，第 4 档会在**下一层被重新判为可重试**，spec 的要求形同虚设。

**冻结**：在 `TransportErrorReason` 增加 `unknown-transport`，并在 `classifyError` 的结构化 `switch` 中显式映射为**非 retryable**，且该分支须在宽泛 `isNetworkError` **之前**处理。这是一处对 foundation 的**破坏性扩充**，需同步其穷尽性守卫。

> **未闭合项**：忠实 `REFUSED_STREAM(0x7)` 夹具尚未验证（`exp/curl-transport-rst-arbitration/FINDINGS.md` 明列）。子优先级第 1 档在实测前**不得**上线为可重试契约——须先补 oracle（§10）。

### 7.6 进程生命周期与 shutdown（v1 遗漏）

每请求一子进程 ⇒ provider 必须追踪所有在途 child。冻结：

- shutdown **Phase 1 不关闭 provider**（`shutdown.ts:484-503` 明确 Phase 1 不撕毁在途请求）。
- **Phase 3** 由每请求 AbortSignal 负责 SIGTERM + `await proc.exited`。该等待成为 Phase 3 drain 的等待项**是正确的**——guard 在 abort/timeout 时已 fire-and-forget 启动 inner cleanup 并立即向 handler 抛出用户可见错误（`stream.ts:394-431`），而 `dispatch-lifecycle` 不在 cleanup 完成前 resolve `quiesced`（`dispatch-lifecycle.ts:54-78`）。现役刻意区分「用户可见错误已产生」与「资源已 quiesced」。Phase 3 自身有 120s 边界（`shutdown.ts:460,561-580`、`config.yaml:223-225`）。
- **Phase 4 必须有 SIGKILL escalation**（v2 遗漏——只写了 force-close + await reap，若 curl 忽略或卡住 SIGTERM，Phase 4 自己会永久阻塞）：

  ```text
  Phase 3：SIGTERM + await exit，受 Phase 3 总 deadline 约束
  Phase 4：对仍存活 child 发 SIGKILL → await proc.exited
           → 若连 SIGKILL 后 exit promise 都不 settle，记录 lifecycle failure，
             **不得**宣称 quiesced
  ```

  只允许 registry 对**自己拥有且仍存活**的 curl child 按 **PID 精确** escalation（与项目 `protect-user-main-server` 纪律一致，绝不 `pkill`/`killall`）。
- `close()` **幂等**，finalize 再次调用无害。
- `fetch()` 与 close 竞态须返回带 **shutdown provenance** 的 cancellation，不是 generic `pre-response-close`。

### 7.7 平台边界

`-D /dev/fd/3` + 「open 后 unlink 的普通文件」依赖 Unix fd 继承与 `/dev/fd`，仅在 Linux/WSL2 实证。**curl provider 首版正式支持范围限定 Linux/Unix**，`probe()` 须校验 `/dev/fd` 与 fd 继承可用。Windows 支持需另定 metadata sink 方案并入测试矩阵——列入 backlog，不在本轮范围。

> `-D` 写 pipe 必失败（exit 23，**Bun 与 Node 皆然**，非 Bun 特有）。不用 `-i`：body 可能含类 header 字节，且 trailers 紧贴 body 之后。

## 8. 配置（冻结优先级）

```yaml
upstream_transport:
  provider: auto        # auto | http2 | curl | undici
  curl:
    binary: curl
    http_version: auto  # auto | h1 | h2
```

- `auto` = **https → http2，明文 http → curl**。**不改变任何现有 https 上游的传输**（评审复核：当前 HTTPS + 默认 `favor:true` 已走 `http2`）。
- 显式 `curl` = 全部上游走 curl，含 https h2。
- **全局单选**，不做 per-origin 覆盖（用户 2026-08-01 裁决）。
- **新旧键优先级（冻结）**：显式 `provider` **始终胜出**；`http2.favor` 仅在 `provider` 缺失时作为兼容输入；两者同时出现**继续启动 + 打印一次冲突警告**。此语义直接沿用 `config/compat.ts:16-18` 已确立的惯例——「user-set new key always wins over the migrated legacy value」。
- `favor: false` → `provider: curl`；`favor: true` → `provider: auto`（须在迁移消息中说明其 HTTP 行为变化）。
- **`provider: http2` 遇 `http://` URL** → 选路阶段返回明确的配置错误，**绝不静默 fallback**。
- **`provider: undici` 在 Bun 下** → 按项目配置兼容政策**警告继续**（`config.ts:1073-1083` 已有先例），**不**冒充 binary unavailable 而启动失败。
- **选中的 provider 不可用则启动即失败**（用户裁决）。可达性判定见 §4.3——默认安装不会仅因 `auto` 就强制要求 curl。
- 选中 curl 且配了 `http2.ping_interval > 0` → 启动告警，文案按 §5。

## 9. `/api/status` 的新形状（冻结）

既然已允许破坏旧 shape，就一次定义长期正确的形状，不让实现者临场发明：

```ts
interface UpstreamTransportStatus {
  selection: { mode: SelectionMode; routes: { http: ProviderId | null; https: ProviderId | null } }
  providers: Array<{
    id: ProviderId
    availability: { level: "ready" | "unavailable" | "not-instantiated"; detail?: string }
    capabilities: ProviderCapabilities
    effectiveConfiguration: Record<string, number | string | null>
    activeOperations: number
    /** provider 自定：h2 是 session rows + reconcile；curl 是在途 child（pid/origin/protocol/startedAt） */
    details: ProviderStatusDetails
  }>
}
```

不适用字段用**显式 `not-applicable`**，不用缺失或裸 `null`——消费方必须能区分「没有 h2 session」与「当前根本没选 h2 provider」。`ui-v4` 的 `OverviewShadcn` / `OverviewLegacy` / `types/status.ts` 与 `tests/infra/management-routes.http.test.ts` 需同步（§1.1 第 6、7 项）。

## 10. 测试：约束 → 测试追踪表

v1 的「真起 Node oracle 跑 h1/h2、流式、trailers、故障注入、abort、大 body」过于笼统。逐条追踪：

| 约束（出处） | 测试 | 层 |
|---|---|---|
| §7.1 stdout EOF 不终止 Response；exit 决定终态 | 注入非零 exit，断言 consumer 见 error 而非成功 | it |
| §7.1 trailers 在 body terminal 前、且进 settle 快照 | trailers → ctx → 持久化 terminal 全链断言 | it |
| §7.2 三种 `http_version` × scheme 的参数映射 | 参数构造 + oracle 侧实际协商协议 | unit + it |
| §7.3 curl 自动 header 被抑制、`accept-encoding: identity` 保持 | **oracle 断言收到的完整 header 集**（不是断言参数数组） | it |
| §7.3 curl 不读代理环境变量 | 设 `HTTP_PROXY` 但选路判定不走代理，断言未经代理 | it |
| §7.3 `socks5` vs `socks5h` DNS 语义 | 分别断言解析位置 | it |
| §7.3 空值 header `;` vs 移除 `:` | oracle 断言 wire | it |
| §7.4 `Response` 在 body 完成**前** resolve | 断言 headers 到达即 resolve，body 仍在流 | it |
| §7.4 多 header block（1xx / CONNECT / 认证重试） | 各形态 oracle | it |
| §7.4 预读缓冲上限与 backpressure | 慢 consumer + 大响应，断言内存有界 | it |
| §7.5 分类矩阵：exit {7,18,23,28,56,92,unknown} × headers phase × 本方 abort | 完整矩阵，每个 retryability 分支真 wire | it |
| §7.5 忠实 `REFUSED_STREAM` | **须先补忠实 oracle**（当前未闭合） | it |
| §7.6 重复 abort、shutdown 全 child reap、无僵尸/fd 泄漏 | 资源计数断言 | it |
| §7.7 `probe()` 校验 `/dev/fd` 与 fd 继承 | 单测 + binary 不存在 / 无 HTTP2 feature 两种失败 | unit |
| §8 新旧键优先级、协议不匹配、undici-on-Bun 警告继续 | 配置兼容矩阵 | unit |
| §9 status 新 shape 与 ui-v4 | 契约测试 | http |
| §4.4 capability 声明与实际行为一致 | **正反双向 oracle**：每条 `unsupported` 要正样本对照证明确实缺失；每条 `supported` 同样要证明确实具备（`true` 一样会假绿） | it |

并发喂 stdin + drain stdout 的死锁防护须有**正向 control**（构造会死锁的错误驱动顺序，证明测试咬得住）。

> **夹具纪律**（本轮教训）：h2 故障夹具服务端**必须用 Node**；造 RST **必须用 `stream.destroy(err)`，绝不用 `stream.close(code)`**——后者不放出忠实 RST 帧，会让整套截断测试**假绿**。须写进 skill `debugging-ghc-api-upstream-transport`（该 skill 现已记载 Bun 服务端版本的同类 caveat，本次扩大其适用范围至 Node 服务端）。

## 11. 复评时需要被证伪的断言

1. §1.1 的九类耦合面是否**仍不完整**？
2. §4.3 的「可达性」判定是否会漏掉某条运行期才出现的明文上游路径（配置热重载后新增）？
3. §4.4 的维度拆分是否仍在按 curl 反向拟合？换 `undici` 或未来的进程内 libcurl 进来是否够用？
4. §7.1 冻结的六步顺序，是否与现役 `dispatch-lifecycle.ts` / `guardSseIterable` 的终止语义相容？
5. §7.5 的五级优先级是否存在两条同时命中且顺序错误的组合？
6. §8 的 `favor: true → provider: auto` 映射是否真的行为等价？
7. §9 的 shape 是否覆盖了 `ui-v4` 当前逐字段读取的**每一个**字段？

## 12. 评审处置表（v1 → v2）

| # | 评审发现 | 级别 | 处置 |
|---|---|---|---|
| 1 | §7.1 崩溃机制事实错误 | High | **采纳**（主会话独立复核确认）。改为数据不一致风险 + 冻结六步顺序，见 §7.1 |
| 2 | provider/selection/registry 混为一体，`auto` 不自洽 | High | **采纳**。拆三层，见 §4 |
| 3 | capability 按 curl 缺口反向拟合 | High | **采纳**。改带级别联合 + 维度拆分，见 §4.4 |
| 4 | 配置优先级 / h2c / 协议不匹配未冻结 | High | **采纳**。见 §7.2、§8 |
| 5 | §5 只说「回退」未定义可观察行为 | High | **采纳**。加故障形态 × endpoint 矩阵，见 §5 |
| 6 | 错误分类不完整、`Record` 非穷尽 | High | **采纳**。四输入五级矩阵 + unknown fallback，见 §7.5 |
| 7 | 流式 headers 获取缺失 | High | **采纳**。见 §7.4 |
| 8 | curl 自动 header + 环境代理未中和 | High | **采纳**。见 §7.3 |
| 9 | `close()` 与 shutdown 时序不兼容 | High | **采纳**。见 §7.6 |
| 10 | §8 测试未覆盖 §7 全部约束 | High | **采纳**。改约束→测试追踪表，见 §10 |
| 11 | `/api/status` 新 shape 未定义 | High | **采纳**。见 §9 |
| 12 | 「四个耦合点」不成立 | Medium | **采纳**（两评审 + 主会话三方确认）。见 §1.1，并反向修正 `reconcile*` 不是外部耦合点 |
| 13 | §6「唯一实质优势」自相矛盾 | Medium | **采纳**。见 §6 理由更正 |
| 14 | `/dev/fd/3` 平台边界未声明 | Medium | **采纳**。见 §7.7，首版限定 Linux/Unix，Windows 入 backlog |
| 15 | 「curl 无 h2 PING」应收窄 | — | **采纳**。见 §3.2 |
| 16 | §3.1 勘误措辞（原探针未进 git 历史） | — | **部分采纳**。取证 agent 确认现存探针确用 `stream.close(code)`、且 drop 探针用 `session.destroy()` 属忠实，故改为**部分勘误**（RST 半作废、drop 半成立），比 v1 的整条作废更准 |
| 17 | 建议修订交 `architect-advisor` 完成 | — | **不采纳**。修订涉及用户已作的三项裁决（provider 通用化、全局单选、启动即失败）与本轮实证的取舍，上下文在主会话；spec 定稿属主会话职责（项目纪律）。改为主会话修订 + 复评 |

### 12.1 复评（第二轮）处置

复评逐处核验 v2 的修订是否**实质**落实（而非敷衍），并按要求同时查过度设计。**全部 8 条采纳，无驳回。**

| # | 复评发现 | 处置 |
|---|---|---|
| R1 | §4 三层拆分**实质落实**，`auto` 下三个原始歧义已有确定语义 | 确认，无需改动 |
| R2 | v2 举的「热重载新增明文 `ghc_api_base_url`」**在现役行为里不存在**（启动期字段）；且 **SearXNG 明文上游根本没有实现**，全是陈旧注释 | **采纳**。G4 改为「undici 整体退役」；可达性改为权威 upstream-origin inventory。见 §2、§4.3 |
| R3 | 「拒绝该次重载并保留旧配置」**不可实施**（apply 非事务性、PUT 先写盘） | **采纳**。改 candidate-config preflight。见 §4.3 |
| R4 | reload-time 可达集覆盖不了运行期首次出现的动态 URL | **采纳**。加请求期 single-flight lazy probe 不变量。见 §4.3 |
| R5 | §7.5 静态优先级有**因果竞态**（晚到 abort 改写更早的真实上游失败） | **采纳**。改 first-terminal-cause latch + 子优先级。见 §7.5 |
| R6 | REFUSED 证据契约自相矛盾（exit 92 区分不了 code 7）；`unknown` fallback 会被宽泛 `isNetworkError` 重新判为可重试 | **采纳**（主会话独立复核确认 `TransportErrorReason` 无 unknown、`classify.ts:151` 宽泛匹配）。见 §7.5 |
| R7 | **过度设计命中**：`connectionReuse.withinDispatch`、`truncation.semanticTerminal` 无 provider 层消费者；`pool.*` 按 h2 塑形（含 `goawayDrain` 帧名） | **采纳**。删两字段，`pool` 拆为 `admission` + `connectionLifecycle.protocolDrain`。见 §4.4 |
| R8 | §7.1 自然路径与现役 lifecycle **实质相容**；但六步错误地把 consumer cancellation 与 producer terminal 混为一条；Phase 4 缺 SIGKILL escalation | **采纳**。拆顺序 A / B + 不可逆 `consumerCancelled` gate；补 Phase 4 escalation。见 §7.1、§7.6 |

**仍待完成**：复评的 B 部分（§11 七条待证伪断言的逐条取证）尚未执行。该轮完成前，本 spec 不应视为可进入计划阶段。
