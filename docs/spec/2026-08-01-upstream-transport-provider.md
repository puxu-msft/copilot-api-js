# Spec：上游传输 Provider 化 + Rust/napi-rs 外部实现

状态：**v3 草案 —— 选型已从 curl 改为 Rust/napi-rs 并重写实现章节；两轮评审已逐条修订；§11 取证轮与 v3 复评尚未执行，未达「可进入计划阶段」** · 日期：2026-08-03 · 决策人：用户 · 撰写：主会话

关联：ADR `docs/decisions/2026-07-14-transport-config-three-axis-organization.md` · RFC `docs/spec/upstream-http2-transport.md`（**本 spec 勘误其中一条断言，见 §3.1**） · 实验 `exp/napi-http-spike/`（选型实证）· `exp/upstream-client-survey/`（七候选穷举）· `exp/curl-transport-exe/` `exp/curl-transport-libcurl/` `exp/curl-transport-rst-arbitration/`（已否决路径的取证）

> **v3 修订说明**：选型于 2026-08-03 由 curl 改为 **Rust + napi-rs（hyper/reqwest）**——curl 两种形态都发不出周期 h2 PING，而该能力经 spike 实测在 reqwest 上成立（§0.1、§3.2）。§3.2 / §5 / §6 / §7 已按新选型重写；§1–§4 的架构不受影响。
>
> **v2 修订说明**：v1 被两个独立 subagent 评审判为「需修订后再评」（0 Critical / 10 High / 3 Medium）。两处**事实错误**（§7.1 崩溃机制、§1 耦合面）已由主会话独立复核确认成立并改正。v1 把六项本应在 spec 冻结的契约推给了实现期，v2 逐一冻结。完整处置见 §12。

---

## 0. 实现选型与分发（2026-08-01 用户裁决，**取代 curl 作为通用 provider**）

> 本节是最新裁决，与下文以 curl 为通用实现的叙述冲突时**以本节为准**。§1–§4 的架构（三层契约、能力模型、选路）**不受影响**——provider 契约可插拔的意义正在于此。§7 中 curl 专属的实现约束（子进程、argv、dump fd、exit code）随之失效，**已在 v3 重写**；其中**与实现无关的三条不变量保留并沿用**：§7.1 的终止时序与 consumer-cancellation 分离、§7.3 的 wire parity 要求、§7.5 的 first-terminal-cause latch 与 `unknown-transport`。

### 0.1 选型：Rust + napi-rs（hyper / reqwest），不用 curl

穷举七个候选后（矩阵见 `exp/upstream-client-survey/`），**只有 Rust + napi-rs 同时具备 h1、h2 与周期 h2 PING**，其余每个都强制配对：

| 候选 | h1 | h2 | **h2 PING** | 连接复用 | 双运行时 |
|---|---|---|---|---|---|
| **Rust + napi-rs (hyper/reqwest)** | ✅ | ✅ | **✅** | ✅ | ✅ |
| 现役 `node:http2` | ❌ | ✅ | ✅ | ✅ | ✅ |
| curl exe | ✅ | ✅ | ❌ | ❌ | ✅ |
| 进程内 libcurl | ✅ | ✅ | ❌ | ✅ | ❌（`bun:ffi` 仅 Bun） |
| `node:net/tls` + `http-parser-js` | ✅ | ❌ | n/a | 需自建 | ✅ |
| Bun 原生 `fetch` | ✅ | — | ❌ | ? | ❌ 一致性 |
| Bun `node:http` shim | ? | ❌ | ❌ | ? | ❌ |

依据：reqwest `ClientBuilder` 的 `http2_keep_alive_interval` / `http2_keep_alive_timeout` / `http2_keep_alive_while_idle` 与 `pool_idle_timeout` / `pool_max_idle_per_host`（**官方文档核实**，docs.rs reqwest 0.13.4）。`while_idle` 的语义正对本项目需求：关闭时 ping **只在流活跃期间**发——长 thinking 恰是「单流活跃但静默」，正是 `curl_easy_upkeep` 够不到的场景。

**Bun 侧生死门已实测通过**：Bun 1.3.14 支持 Node-API ThreadSafeFunction 跨原生线程回调（用真正走 `Napi::ThreadSafeFunction::BlockingCall` 的 `@parcel/watcher` 验证，Bun 与 Node 双双收到 event，有正样本；`node-libcurl` 的 `uv_timer_init` panic **不会**必然重现）。
**但该实验只覆盖 Node-API 的 TSFN 机制**，未证明 napi-rs 自身的 wrapper、回调 backpressure、取消竞态与高频字节流——正式 spike 须用 napi-rs 本身复验。

被否的两条顺带记录：`llhttp` 官方 npm 包是**代码生成器**而非运行时解析器（要用需自维护 WASM 构建与 glue，代价接近一个小型原生组件）；现成可用的纯 JS 解析器是 `http-parser-js@0.5.10`（chunked + trailers 状态机完整，且 trailers 先于 message-complete 交付）。若将来放弃原生路线，它是 h1 的首选底座。

### 0.2 分发：per-platform 可选包发布产物（用户裁决 2026-08-03，**取代 2026-08-01 的「本地构建」**）

采用 napi-rs 生态的标准做法，与 esbuild / SWC 同型：

- CI 交叉编译矩阵产出各平台 `.node`，各自发一个 sibling npm 包（`@hsupu/copilot-api-linux-x64-gnu`、`-linux-x64-musl`、`-linux-arm64-gnu`、`-linux-arm64-musl`、`-darwin-x64`、`-darwin-arm64`、`-win32-x64-msvc` …）。
- 每个 sibling 包声明 `os` / `cpu` / `libc`；主包在 **`optionalDependencies`** 里列出全部，包管理器只装匹配当前平台的那一个。
- **`bun x` 下开箱可用**——已实测：`bun x esbuild --version` 输出 `0.28.1`，而 esbuild 的 bin 是 JS shim、必须调起原生二进制才能打印版本，故这证明 `bun x` 会解析并安装平台专属 `optionalDependencies` 并成功调用。

**napi 是 N-API（ABI 稳定），同一个 `.node` 同时服务 Bun 与 Node**，不像 `node-libcurl` 那样按 Node ABI 版本切产物——运行时维度不让产物数量翻倍，矩阵只按 OS×CPU×libc 展开。

#### 这条裁决解除了什么约束

2026-08-01 的「不发布产物」曾强制推出「默认必须保持 `node:http2`」（否则 npm 安装者开箱即挂）。**产物随包分发后，该强制约束消失**——Rust provider 具备成为默认的技术条件。是否真的把它设为默认是**独立决策**，见 §0.2.1。

#### 这条裁决**没有**解除什么

- **矩阵未覆盖的平台仍然拿不到产物**，且 `optionalDependencies` 的缺失是**静默**的（包管理器不会报错）。故 loader 必须在**启动时大声失败**并指明是平台不受支持，绝不拖到第一个请求、绝不静默降级。受支持平台清单须是 spec 的一部分。
- **版本锁步**：sibling 包与主包必须同版本发布，主包 `optionalDependencies` 用精确版本（非 range），否则会出现主包与产物 ABI/接口错配。
- **绝对路径覆盖仍然保留**——`bun x` 场景已不再依赖它，但开发期（改 Rust 代码后即时验证）与矩阵外平台自建产物仍需要它。

### 0.2.1 默认 provider：`auto` 探测（用户裁决 2026-08-03）

**`auto` = 有原生产物就用 Rust provider，没有就回落 `node:http2`。**

这与 §0.2 的「绝不静默降级」不冲突，因为**回落不得静默**。三条强制要求：

1. **启动期大声告警**：产物不存在时打一条明确的 `consola.warn`，指出原生产物缺失、因此**当前平台不受支持或未安装**，且 **h1 能力与经代理的长 thinking 保活默认不可用**，并给出补救方式。
2. **`/api/status` 可见**：Rust provider 的 `availability` 为 `{ level: "unavailable", detail: <原因> }`，`selection.routes` 如实反映实际生效的 provider——诊断消费方必须能区分「回落了」与「本来就选的 node:http2」。
3. **显式选择不享受回落**：`provider: rust` 被显式配置而产物缺失时 **启动即失败**，绝不回落。回落只是 `auto` 的语义，不是缺失产物的通用兜底。

理由：`auto` 的语义本就是「在当前环境下选最好的可用实现」，回落是它的正常行为而非降级事故；而显式指名一个 provider 是一项要求，要求不被满足就该失败。区分二者，「绝不静默降级」这条纪律才不会被稀释成「反正会回落」。

### 0.2.2 构建前提：`RUSTUP_HOME` 必须显式传递

本机 Rust 装在**非默认位置**：`RUSTUP_HOME=/home/xp/.local/rustup`（`stable-x86_64-unknown-linux-gnu`，rustc 1.97.1 / cargo 1.97.1，已安装 target 仅 `x86_64-unknown-linux-gnu`）。

⚠ **不继承交互 shell 环境的进程（构建脚本、CI、subagent 的工具 shell）会看到 `rustup toolchain list → no installed toolchains`，从而得出「没装 Rust」的假阴性**——本会话就踩了一次。构建脚本与 CI 必须显式设置 `RUSTUP_HOME`，或先探测多个候选位置再报错。

交叉编译矩阵还需 `rustup target add` 各目标三元组——本机目前只有 `x86_64-unknown-linux-gnu` 一个。

### 0.2.3 平台矩阵是自由参数，不是固定的七八个

napi-rs 生态的默认矩阵按 **OS × CPU × libc** 展开成 7–8 个（`linux-{x64,arm64}-{gnu,musl}`、`darwin-{x64,arm64}`、`win32-x64-msvc`）。libc 那一维是 Linux 特有的——glibc 与 musl 的 `.node` 不可互换。**napi 是 ABI 稳定的，Bun 与 Node 共用同一份产物**，运行时维度不参与展开。

**但 §0.2.1 的 `auto` 回落让矩阵大小成为自由参数**：未覆盖的平台不会坏，只会告警并使用 `node:http2`。

成本也非线性——每平台 ~6.5MB 产物是小头，大头是 CI：darwin 需 macOS runner、win32 需 Windows runner、musl 需交叉工具链。

**决定**：**刻意收窄**，首版只发实际在用的 `linux-x64-gnu`，其余平台走 `auto` 回落；加平台是纯增量的 CI 配置，按真实反馈逐个加。**这不是砍范围**——回落路径本就是设计的一部分（`ask-if-scope-shrink` 已考量：能力面不变，只是产物覆盖面随需求增长）。

### 0.3 打包接线（现状与需改动处）

现状：`prepack` / `prepare` = `bun run build` = `tsdown`（只打后端 bundle）；`build:history-search` **不在**其中（2026-07-28 纪律：没 Rust 的机器 `bun install` 也要能过）。`files: ["dist", ...]`，当前发布的 tarball 里没有任何 `.node`。

需改动：

1. `tsdown.config.ts` 的 `deps.neverBundle` 加入原生包说明符（同 `bun:sqlite` / `node:sqlite` 的既有处理），否则 bundler 会在构建期尝试解析它。
2. **CI 交叉编译矩阵 + sibling 包发布流水线**（napi-rs CLI 提供 `napi build` / `napi create-npm-dirs` / `napi prepublish`）。这是本次新增的**长期维护义务**，不是一次性成本。
3. `prepack` 仍**不**接原生构建——原生产物由 CI 矩阵产出并单独发布，不走本地 prepack（保持「没 Rust 的机器 `bun install` 能过」这条纪律）。
4. 加载器沿用 `src/lib/history/search-native.ts:30-47` 的形态（`createRequire(import.meta.url)` + 多候选），候选顺序为：**绝对路径覆盖 → 平台 sibling 包 → 开发树 `native/<crate>/*.node`**，全失败则抛。
5. **与 history-search 的关键差异**：搜索缺产物走 `describe.skipIf` 显式 skip；**传输层不可 skip**——未选中时不加载，选中而缺失则**启动失败**，绝不静默降级。

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

### 3.2 Rust provider 的实证能力（spike，2026-08-03）

`exp/napi-http-spike/`（`napi 3.12.0` + `reqwest 0.13.4`），**四个核心门槛全部实测通过，每项带 mutation 正控**：

| 门槛 | 结果 | 正控 |
|---|---|---|
| napi-rs TSFN 在 **Bun** 下可用 | ✅ 同一 `.node`，Node 与 Bun 各 5 次按序回调（~42/83/125/166/207ms） | 把预期改成 4 次 → 变红 |
| 流式字节增量回 JS | ✅ 三块间隔 ~250ms 分别到达，非 EOF 后一次性 | 断言改「间隔 > 400ms」→ 变红 |
| **周期 h2 PING 到达 wire** | ✅ **活跃但静默的流上 5.5s 内 5 个 PING** | 见下 |
| abort / 取消 | ✅ cancel→done 0.2ms(Node)/0.3ms(Bun)；`activeTasks:0`；oracle 见 `rstCode:8` | 预期 `activeTasks` 改 999 → 变红 |

**h2 PING 是本次选型的决定性证据**，故用双层正控（主会话独立复跑 Node-host 腿确认）：

```text
{"event":"ping","label":"control","payload":"434f4e54524f4c21","controlPings":1,"rustPings":0}
{"event":"ping","label":"rust","payload":"3b7cdb7a0b8716b4","controlPings":1,"rustPings":1}  ... ×5
{"event":"summary","totalPings":6,"controlPings":1,"rustPings":5}
```

① Node client 主动 `session.ping("CONTROL!")` 被 oracle 记到 ⇒ **监听器确实能观察 PING**，「计数 0」与「监听器坏了」可区分；② 把 `http2_keep_alive_interval` 改 `None` → rust 计数归零而 control 仍在 ⇒ **计数确实来自 reqwest 的机制**。服务端只发 headers 不写 DATA、保持流活跃 5.5s——**正是长 thinking 经代理的真实形态，也正是 curl 归零的场景**。

> 复核范围：主会话独立复跑了 **Node-host addon** 腿；**Bun-host 腿沿用 spike 报告，未经独立复核**。

**次要项**：backpressure 有界（`MaxQueueSize=1`+`Blocking`，producer 被消费速度反向节流——**该结论绑定有界 TSFN 策略，换 `NonBlocking` 即不成立**）；事件循环最大 tick gap 10.9–18.6ms（本地低吞吐，非 benchmark）；TCP keepalive 落内核（`ss` 见 `timer:(keepalive,200ms,0)`）。

**产物体积**：release `.node` 约 **6.5MB（已 strip）**——直接决定分发矩阵体积（§0.2.3）。

### 3.3 spike 未覆盖、须在实现期闭合的

跨请求连接复用（spike 每请求新建 `Client`）、真实 GHC 上游、**代理隧道内的 h2 PING**、mTLS/企业 CA、request body streaming 与全双工上传、trailers、完整 header 语义、重定向、错误分类、并发与连接池容量、admission queue、idle reap、GOAWAY/RST/connection-drop 分类、shutdown barrier、addon unload 与 TSFN closing 竞态、非 linux-x64-gnu 产物。



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

## 5. `auto` 回落到 `node:http2` 时失去什么

v1/v2 的本节写的是「curl 服务 h2 没有 PING、故长 thinking 保活退化」。**选型改为 Rust provider 后该前提消失**——reqwest 的周期 h2 PING 已实测到达 wire（§3.2）。退化场景随之从「PING 缺失」收窄为「**产物缺失时回落到 `node:http2`**」。

**回落时失去的**（仅此一项）：

| 能力 | Rust provider | 回落到 `node:http2` |
|---|---|---|
| h2 + 周期 PING + 连接池 | ✅ | ✅ **不受影响** |
| **h1 能力** | ✅ | ❌ **完全没有** |

⇒ 回落**不影响**现有的 h2 热路径（含长 thinking 经代理的保活），只影响 h1：明文 `http://` 上游不可用、TLS 终止型 MITM 代理给不了 h2 时无回退、未来 h1-only 上游无解。

**这不是相对今天的回退**：今天同样没有可用的 h1（undici 在 Bun 下 h1/h2 都永久 hang，且注释里那个明文上游是幽灵，见 §4.3）。回落只是**没有获得新增能力**，不是丢失既有能力。

**告警文案据此收窄**（v2 那段关于 `stream_idle` 与 Anthropic 默认无 buffered retry 的措辞已不适用）：应说明原生产物不可用、因此**当前平台无 h1 能力**，并指出受支持平台清单与自建方式——**不得**暗示 h2 或保活受影响。

> 保留的事实（与 provider 选型无关，仍是 `node:http2` 与 Rust provider 共同依赖的前提）：GHC 的 CAPI 代理**不透传** SSE `ping` 帧；经网络代理时 TCP keepalive 只覆盖「我方↔proxy」腿，**h2 PING 是唯一覆盖真上游全程的保活**（`http2-client.ts:228-260`、`:126-175`）。这正是选型必须要求 PING 能力、从而排除 curl 的原因。

## 6. 未采纳的候选与理由（`record-not-adopted`）

七候选穷举见 §0.1 矩阵与 `exp/curl-transport-*` / `exp/upstream-client-survey/`。逐条记录**为什么不选**，而非只记录选了什么：

| 候选 | 不采纳的理由 |
|---|---|
| **curl exe** | **无周期 h2 PING**（五条独立证据 + 正样本对照，范围限定为「当前受支持的 curl CLI 公共接口」，不外推至任何版本/私有 patch）。另无跨请求连接复用（TTFB +37ms 中位 / +103ms p95，另加每请求 ~7-8ms 进程开销）。曾是 v1/v2 的选型，被 §0.1 推翻 |
| **进程内 libcurl** | 同样无 h2 PING（`CURLOPT_UPKEEP_INTERVAL_MS` 下 66 次 `curl_easy_upkeep()` 全返回 0、oracle 观察 0 帧——upkeep 够不到在途 transfer）。且 `node-libcurl` 在 Bun 下 panic（`uv_timer_init`），`bun:ffi` 路线 **Node 不可用**造成运行时分裂 |
| **`node:net/tls` + `http-parser-js`** | **只有 h1**，违背「h1/h2 平等」的架构意图。零依赖是其优点，但连接池、代理隧道、背压、生命周期全须自建，实现代价在三个零依赖方向里最高。**若将来放弃原生路线，它是 h1 的首选底座** |
| **`llhttp`** | 官方 npm 包是**代码生成器**而非运行时解析器；要用需自维护 WASM 构建与 ABI/callback glue，代价接近一个小型原生组件，反而违背「优先成熟三方件」 |
| **Bun 原生 `fetch`** | chunked 正确性成立（**推翻了「Bun 的 HTTP 栈整体坏掉」这一可能的误读**——hang 是 undici×Bun 交互 bug），但无 TCP keepalive 旋钮、无 trailers、写死 300s 超时、忽略 dispatcher、双运行时不一致 |
| **Bun `node:http` / `node:https` shim** | CONNECT 已知损坏；trailers 缺失；不经过它才是本项目现有做法 |
| **undici** | **Bun 下 h1 与 h2 都永久 hang**（`exp/upstream-models-hang/`）。本 spec 的 G4 即为将其从 HTTP 路径整体退役 |



## 7. Rust provider 的冻结契约

> v2 的本节围绕 curl 子进程写（argv、dump fd、exit code、SIGTERM/SIGKILL），随选型变更整体失效。**三条与实现无关的不变量保留并沿用**：终止时序与 consumer-cancellation 分离（§7.1）、wire parity 要求（§7.3）、first-terminal-cause latch 与 `unknown-transport`（§7.5）。

### 7.1 终止时序（不变量保留，机制改写）

**顺序 A：producer-driven terminal**（Rust 侧自然结束或自行失败，**且 consumer cancellation 尚未获胜**）：

1. body 分片经**有界** TSFN 实时交付 consumer。
2. **「Rust 侧不再有分片」不等于 Response 成功结束**——终态由 Rust 侧交付的 outcome（success / error kind）决定，不由「流没了」推断。这条是从 curl 版继承的承重不变量：当时是「stdout EOF ≠ 成功」，现在是「分片耗尽 ≠ 成功」。
3. 在 outcome 回调中**同步**抢 `process-exit` latch（§7.5 沿用该名，语义为「producer 侧终态」）。
4. 若有 trailers 则**先**交付 `onTrailers`，**再**终止 body。
5. 按 outcome 执行 `controller.close()` 或 `controller.error()`。

**顺序 B：consumer-driven cancellation**——`ReadableStream.cancel()` 触发时：置**不可逆**的 `consumerCancelled` → 抢 local-abort latch → 取消 Rust 侧请求 → await 任务真正结束 → resolve `cancel()`。

`consumerCancelled` 为 true 后**不得**执行顺序 A 的第 4、5 步（不再 `onTrailers`、不再 `close/error`）——否则在上层已按 timeout / shutdown / client abort settle **之后**产生 late callback，重新制造 §7.1 要消灭的 History 数据分叉。

**为何单靠 latch 不够**（原因与 curl 版相同，与实现无关）：`guardSseIterable` **独立** race 原始 abort signal（`stream.ts:423-445`），故 provider 内部即使已判给 producer，上层仍可能先按 abort settle。`terminalCause` 决定**失败身份**，`consumerCancelled` 决定**此后是否还允许回调**——两个状态，不可合一。

**延迟 settle 是资源真实性**：`dispatch-lifecycle.ts:128-139` / `:43-48`、`generation/dispatch-scheduler.ts:324-331`、`context/request.ts:847-861` 构成的全序不变；有界性靠 stream idle timeout、Phase 3 abort、Phase 4 force-close 三道，**不靠提前 resolve lifecycle**。

⚠ **须实测闭合**：reqwest/hyper 交付 h2 trailers 的时机与 API（`body.trailers()`），以及它是否能满足「trailers 先于 body terminal」。spike **未覆盖 trailers**。在实测前，`trailers.capture` / `deliveryBeforeBodyEnd` 的能力声明须标 `unknown`，不得直接宣称 `supported`。

### 7.2 协议选择

| `http_version` | reqwest 配置 |
|---|---|
| `h1` | `http1_only()` |
| `h2` + `https` | ALPN 协商（默认行为，可 `http2_prior_knowledge()` 强制） |
| `h2` + `http`（h2c） | `http2_prior_knowledge()` |
| `auto` | 默认 ALPN；明文默认 h1 |

### 7.3 wire parity（要求不变，具体注入项须实测）

⚠ **reqwest 同样会注入 caller 未提供的 header 并读取代理环境变量**——这是与 curl **同类**的风险，不因换实现而消失。冻结要求：

- `method` / headers / body 以 `UpstreamFetchInit` 为**唯一**输入；**须逐项实测 reqwest 默认注入了什么**（`accept`、`accept-encoding`、`user-agent`、`content-type` 等）并显式抑制 caller 未提供的项。
- 保持 `accept-encoding: identity`（现役 `http2-client.ts:73-85,1001-1011` 的行为）；reqwest 的自动解压须显式关闭。
- **必须调用 `no_proxy()` 或显式 `proxy()`**：reqwest **默认读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`**。代理决策唯一入口仍是 `getProxyUrlForOrigin()`（`proxy.ts:228-244`）。
- 保留 `socks5` 与 `socks5h` 的 DNS 解析位置差异。
- transport-owned / h2 非法 header 的处理抽**共享 primitive**，不由各 provider 各写一份。
- ⚠ **不得照搬 spike 的 `danger_accept_invalid_certs(true)`**（仅为本地自签 oracle）。

### 7.4 流式与背压

Response headers 由 reqwest 直接给出，**不存在 curl 版那个「进程还在跑时怎么读 header」的问题**（§7.4 原有内容随之作废）。取而代之的承重约束是**背压**：

- TSFN **必须有界**（spike 用 `MaxQueueSize=1` + `Blocking`，实测 producer 被消费速度反向节流）。**换 `NonBlocking` 无界队列则该保证不成立**——大 body + 慢 consumer 会无界缓冲。
- 或改为 pull-based `ReadableStream`（`ReadableStreamDefaultController.desiredSize` 驱动 Rust 侧拉取）。二选一须在实现期定，**不得两者都不做**。
- ⚠ 须实测：完整 socket → hyper flow-control → TSFN → JS 消费链在高吞吐 / 大 body 下的峰值内存（spike 未覆盖）。

### 7.5 错误分类（latch 不变，输入源改写）

**第一步 first-terminal-cause latch**（原因与实现无关，见 v2 论证）：

```ts
type TerminalCause =
  | { kind: "local-abort"; reason: unknown }
  | { kind: "producer-terminal"; outcome: RustOutcome; headersReceived: boolean }
```

**第二步 `producer-terminal` 胜出时的子优先级**：

1. 经**忠实 oracle 验证**的 `REFUSED_STREAM` → `refused-stream`（可重试）。
2. headers 到达**前**、且属白名单内语义已验证的错误 → `pre-response-close`（可重试）。
3. headers 到达**后**的截断 → `mid-body-close`（不可重试）。
4. 其余 → `unknown-transport`（**不可重试**），**即使发生在 headers 之前**。

**输入源从 exit code 改为 `reqwest::Error` / hyper 错误分类**（`is_timeout` / `is_connect` / `is_body` / `is_request` + h2 层的 `RST_STREAM` code）。⚠ **须实测**逐类映射，不得从文档推断。

`unknown-transport` 仍须作为**结构化** `TransportErrorReason` 成员加入 `packages/foundation/src/error/transport-reason.ts` 并在 `classifyError` 的结构化 `switch` 中显式判为非 retryable、且**先于**宽泛的 `isNetworkError`（`classify.ts:151`）处理——否则它会被重新判为可重试。这是对 foundation 的**破坏性扩充**，须同步穷尽性守卫。

> **未闭合项（自 v2 沿用）**：忠实 `REFUSED_STREAM(0x7)` 夹具仍不存在。子优先级第 1 档在实测前**不得**上线为可重试契约。夹具纪律见 §10 注。

### 7.6 生命周期与 shutdown（从子进程改为 Tokio 任务）

**napi-rs 导出入口不在 Tokio context 内**——直接 `napi::tokio::spawn` 在 Bun 与 Node **双双 panic**（`there is no reactor running`，spike 实测）。原生模块**必须自己持有显式 runtime**。

- **`Client` 必须由 provider 生命周期持有**（长寿命单例），**不得**每请求新建——spike 为隔离实验那样做了，那正是**不能带进生产**的写法，否则跨请求连接池复用为零。
- **TCP keepalive 必须同时设 time + interval + retries**：只设 `tcp_keepalive(1s)` 会得到 ~14s 内核 timer（reqwest 0.13.4 的 `tcp_keepalive_interval` 默认 15s，spike 实测）。
- shutdown **Phase 1 不关闭 provider**；**Phase 3** 由每请求 AbortSignal 取消对应 Rust 任务并 await 其真正结束；**Phase 4** registry force-close：drop `Client`、取消全部在途任务、await Tokio runtime 静止。
- `close()` **幂等**；`fetch()` 与 close 竞态须返回带 **shutdown provenance** 的 cancellation。
- ⚠ **须实测**：addon unload、JS runtime shutdown、callback throw、TSFN closing 与取消同时发生的竞态（spike 明列未覆盖）。**Phase 4 必须有有界兜底**——若任务不响应取消，记录 lifecycle failure，**不得**宣称 quiesced。

### 7.7 平台边界

由原生产物矩阵决定，见 §0.2.3。`probe()` 须校验**实际加载的产物**可用（非按版本号或平台名推断），失败语义见 §0.2.1（`auto` 告警回落 / 显式选择启动失败）。

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
