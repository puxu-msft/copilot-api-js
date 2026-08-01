# Spec：上游传输 Provider 化 + curl 外部实现

状态：**草案，待评审** · 日期：2026-08-01 · 决策人：用户 · 撰写：主会话

关联：ADR `docs/decisions/2026-07-14-transport-config-three-axis-organization.md`（三轴配置） · RFC `docs/spec/upstream-http2-transport.md`（h2 传输，**本 spec 勘误其中一条断言**） · 实验 `exp/curl-transport-exe/` `exp/curl-transport-libcurl/` `exp/curl-transport-rst-arbitration/`

---

## 1. 问题

本项目所有 `https://` 上游走内建 `node:http2`，明文 `http://` 走 undici。根因是 **Bun × undici 的组合下 h1 与 h2 都永久 hang**（body 永不 finalize，`exp/upstream-models-hang/`）。这留下三个缺口：

1. **`upstream_transport.http2.favor: false` 这个热回退口在 Bun 下是假的**——它回退到 undici，而 undici 在 Bun 下必挂。配置项逐字生效，只打一条警告，实际等于「关掉 h2 就没法工作」。
2. **明文 `http://` 上游（本地 SearXNG）仍骑在会 hang 的 undici 上**，只是响应小、暂未触发。
3. **没有任何 h1 能力**。TLS 终止型 MITM 代理给不了 h2 时 `awaitH2Handshake` 直接 reject，无 h1 回退；未来出现 h1-only 上游同样无解。

更深一层的结构问题：**只有一个 provider，所以 provider 契约从未被命名过**。`http2Fetch` / `closeHttp2Sessions` / `getH2SessionStatusSnapshot` / `reconcileH2SessionsForConfigChange` 这四个函数已经构成契约的形状，但它们被写死成具体名字，散落在四个消费点：

| 耦合点 | 位置 |
|---|---|
| 发请求 | `transport/upstream-fetch.ts` → `http2Fetch` |
| 状态快照 | `transport/status-snapshot.ts` → `H2SessionStatusRow` / `getH2ReconcileStatus` |
| 关机 | `shutdown.ts` → `closeHttp2Sessions` |
| 配置热重载 | `reconcileH2SessionsForConfigChange` |

外加配置里只有 `upstream_transport.http2.*` 一支，以及 `onTrailers` / `onStreamClosed` 两个 h2-only 回调挂在通用的 `UpstreamFetchInit` 上。

## 2. 目标

- **G1** 把上述四个动词提成协议无关的 `UpstreamTransportProvider` 契约，让传输实现可替换。
- **G2** 引入 curl 作为一个 provider，**能服务任意 h1/h2 路径**——h1 与 h2 在这个缝上是平等的，协议不绑定 provider 身份。
- **G3** 让「某 provider 做不到某件事」成为一等公民：能力声明 + 诊断可见 + 选中时告警，绝不沉默退化。
- **G4** 明文 `http://` 上游脱离 undici。

### 非目标

- **不**让 curl 成为默认 h2 传输。默认仍是 `node:http2`（理由见 §5 能力矩阵）。
- **不**引入进程内 libcurl（`bun:ffi` / `node-libcurl` / Rust napi-rs）。理由见 §6。
- **不**为 curl provider 复刻现役的池治理（容量选路 / reservation / per-origin 硬 cap / idle-reap / GOAWAY retire-and-drain）。每请求独立进程使这些机制失去对象。

## 3. 实证基础

三份 PoC，可复跑脚本与原始输出均在 `exp/` 下。**以下每条都是实测，不是文档推断。**

### 3.1 一条必须先勘误的既有断言

RFC `docs/spec/upstream-http2-transport.md` 记有「**(实现期实测, CRITICAL 限制)** Bun 的 `node:http2` 客户端对任何中途连接终止都交付 synthetic clean `end`——clean server RST 与完整连接 drop 皆然」。

**该断言的 RST 部分不成立**，其证据基础是一个不忠实的测试夹具：

- Node h2 服务端的 `stream.close(code)` 在「已写过 DATA、未 END_STREAM」形态下**不在 wire 上放出 RST 帧**（`NODE_DEBUG=http2` 帧级追踪：客户端侧 `closed with code 0`，服务端发的 `INTERNAL_ERROR(2)` 无人看到）。
- 改用 `stream.destroy(new Error())` 造出忠实 RST 后，在**无 Content-Length 的 SSE 流**上，四个客户端**全部**检测到 `rst=2`：curl exe (exit 92)、进程内 libcurl (code 92)、Node 上的 `node:http2`、**Bun 上的 `node:http2`**。

⇒ 「curl 比现役实现更诚实地报截断」这个动机**基本不成立**。唯一被证实的差异是**整连接 drop**（curl 报 18，Bun 的 `node:http2` 报 clean end），而该场景对 SSE 已有应用层 `message_stop` / `[DONE]` 兜底。

> 本项目 skill 已记载「Bun 服务端 `stream.close(code)` 不发忠实 RST」。**本次证明 Node 服务端在此形态下同样不忠实**，caveat 适用范围比原记载更宽。两个 PoC 加主会话，三方都被这个夹具骗过。详见 `exp/curl-transport-rst-arbitration/FINDINGS.md`。

### 3.2 curl 的能力与代价

| 能力 | 实测 |
|---|---|
| h1 / h2 请求、流式增量 | ✅ `-N` 增量交付正常 |
| 代理（http / https / socks5 / `--proxy-http2`） | ✅ 四条全通，隧道内目标仍协商 h2 |
| TCP keepalive | ✅ `--keepalive-time 3` 落内核（`ss` 见秒级倒计时锯齿，非 OS 默认 7200s） |
| 大 body 全双工 | ✅ 32MiB `--data-binary @-`，10 次复跑无死锁，sha256 一致 |
| h1 截断检测 | ✅ Content-Length 短读 / chunked 缺结束块均 exit 18 |
| trailers | ✅ 能透出，但**只能进程退出后从 dump 文件读** |
| abort | ✅ SIGTERM median 0.874ms，60 次无僵尸/fd 泄漏 |
| **h2 PING** | ❌ **完全不存在** |
| **连接复用** | ❌ 每请求一进程 |

**h2 PING 的否定性取证（五条独立证据 + 正样本对照）**：静默 h2 流 7 秒，Node oracle 收到 0 个 PING；同一 oracle 上 `session.ping()` 让计数 0→1（证明 oracle 不是恒零）；`curl --help all` 无 ping 选项；libcurl headers 无 `CURLOPT_*PING`；`--libcurl` 生成代码只有 `CURLOPT_TCP_KEEPALIVE`。进程内 libcurl 侧同样失败：`CURLOPT_UPKEEP_INTERVAL_MS=100` 下 66 次 `curl_easy_upkeep()` 全部返回 0，Node oracle 观察到 **0** 个 PING 帧——`upkeep` 够不到在途 transfer。

**连接复用代价**（`api.github.com/meta` 连续 20 次）：

| | TTFB median | TTFB p95 |
|---|---:|---:|
| curl exe（每次冷连接） | 42.840ms | 114.011ms |
| pooled `node:http2` | 5.422ms | 10.602ms |

外加每请求约 7-8ms 进程开销（loopback 扣掉网络后测得）。

## 4. 契约

### 4.1 `UpstreamTransportProvider`

```ts
interface UpstreamTransportProvider {
  readonly id: "http2" | "curl" | "undici"
  /** 该 provider 能服务的协议。curl: ["h1","h2"]；http2: ["h2"]；undici: ["h1"] */
  readonly protocols: ReadonlyArray<"h1" | "h2">
  /** 启动期可用性探测；不可用即抛，进程启动失败（见 §4.3）。 */
  probe(): Promise<void>
  /** 唯一物理请求入口，签名 = 现有 UpstreamFetchFn */
  fetch(url: URL, init: UpstreamFetchInit): Promise<Response>
  readonly capabilities: ProviderCapabilities
  statusSnapshot(): ProviderStatusRows
  reconcile(): void
  close(): void | Promise<void>
}
```

### 4.2 `ProviderCapabilities`——让「做不到」成为一等公民

沿用 `status-snapshot.ts` 既有的「**能力**（这个实现根本做不到）vs **配置**（你把它关了）」惯例（该文件的 `TransportRuntimeCapability` 注释已明确此区分存在的意义）。

```ts
interface ProviderCapabilities {
  /** curl: false —— 长 thinking 经代理的保活退化 */
  h2Ping: boolean
  /** curl: false —— TTFB +37ms 中位 / +103ms p95 */
  connectionReuse: boolean
  /** curl: false —— 无 per-session cap / per-origin 硬 cap / idle-reap */
  poolGovernance: boolean
  /** curl: "after-end" —— 只能在进程退出后读到 trailers */
  trailerTiming: "before-end" | "after-end"
  /** curl: "both"；http2(Bun): "stream-rst" */
  truncationDetection: "connection-drop" | "stream-rst" | "both"
}
```

`/api/status` 的 `h2Sessions` / `h2Reconcile` 泛化为 provider 归位的诊断行 + 能力矩阵。这是本次唯一的**破坏性外部形状变更**，UI 消费方需同步。

### 4.3 选路与配置

```yaml
upstream_transport:
  provider: auto        # auto | http2 | curl | undici
  curl:
    binary: curl        # 可覆盖为绝对路径
    http_version: auto  # auto | h1 | h2
```

- `auto` = **https → http2，明文 http → curl**（G4：明文上游脱离 undici）。
- 显式 `curl` = **全部**上游走 curl，含 https h2（G2：h1/h2 平等）。
- 全局单选，**不做 per-origin 覆盖**（用户 2026-08-01 裁决：契约最简，排错时一行配置整体切换）。
- `http2.favor: false` **保留兼容层 + 警告继续**，映射为 `provider: curl`。配置不享受代码那套「无向后兼容负担」。
- **选中的 provider 不可用时启动即失败**（用户裁决）。绝不静默回落到 undici——那是回落到一个已知在 Bun 下必挂的实现，等于把启动期硬错误换成运行期悬挂。
- 选中 curl 且配置了 `http2.ping_interval > 0` 时**启动告警**：该 provider 无此能力。

## 5. 为什么默认仍是 `node:http2`

curl 服务 h2 时**没有 PING**。本项目长 thinking 期 wire 上唯一的活动就是保活，而 GHC 的 CAPI 代理**不透传** SSE `ping` 帧；经网络代理时 TCP keepalive 只覆盖「我方↔proxy」腿，**h2 PING 是唯一覆盖真上游全程的保活**。因此让 curl 接管 h2 热路径是**能力回退，不是平移**。

用户已知悉此代价并要求保留该能力路径。本 spec 的处理是：**不禁止，但如实声明**——能力矩阵、启动告警、`/api/status` 三处可见。

## 6. 为什么不用进程内 libcurl

| 路径 | 结论 |
|---|---|
| `node-libcurl` | **Bun 下 panic**：`unsupported uv function: uv_timer_init`（初始化异步 `Multi` 时）。Node 下可用 |
| Rust + napi-rs | **未验证**——本机无 Rust toolchain，spike 停在构建门口 |
| `bun:ffi` + 系统 libcurl | Bun 侧能力面基本跑通（含连接复用、实时 trailers 回调），但 **Node 不支持 `bun:ffi`** → 运行时分裂；且 **h2 PING 同样拿不到** |

进程内路径的**唯一实质优势是连接复用**，而它换不回被否决的 h2 PING。同时它需要自写 `curl_multi_socket_action` 驱动 + `ReadableStream` backpressure + `onStreamClosed` teardown barrier，全部未实现。另有部署硬约束：本机 `libcurl.so.4` 存在但 `pkg-config libcurl` 与 curl headers **均不存在**——「运行库存在」不等于「可本机编译绑定」。

`native/history-search` 的「有产物就真跑、没有就 skip」**不能套到热路径传输**：搜索缺失可显式 skip，上游传输缺失则所有请求不可工作。

> 本条为**暂缓**而非否决。若未来 h2 PING 在 libcurl 侧成立、或出现 Bun/Node 双可用的绑定，进程内路径应重新评估。入 `docs/todo/deferred-backlog.md`。

## 7. curl provider 的实现约束（PoC 踩出，避免实现期重踩）

- **头部**走 `-D /dev/fd/3`，fd3 绑定**预先 open 后立即 unlink 的普通文件**。`-D` 写 pipe 必失败（exit 23，**Bun 与 Node 皆然**，不是 Bun 特有）。**不用 `-i`**：body 可能含类 header 字节，且 trailers 紧贴 body 之后，靠第一个空行分不干净。
- **body** 用 `--data-binary @-` 喂 stdin，父进程**必须从启动起并发 drain stdout/stderr**，写完调 `stdin.end()`。`-N` 救不了「先写完 stdin 才读 stdout」的错误驱动顺序。
- **abort** 用 SIGTERM，且**必须 `await proc.exited`**（防僵尸与 fd 泄漏；fire-and-forget kill 不在 PoC 证明范围）。
- **代理**用 curl 原生 `--proxy` / `--socks5`（可绕过手搓 CONNECT 隧道），但代理选路**必须**仍从 `getProxyUrlForOrigin` 读，不另起一套。
- **空值 header** 须写 `X-Empty;`；`X-Empty:` 会被 curl 解释为**移除**内部 header。
- **错误映射**到现有 `TransportErrorReason`，判据与现役一致（**是否已收到响应头**决定 pre 还是 mid）：exit 7/28/56 且无头 → `pre-response-close`（可重试）；exit 18/92 且有头 → `mid-body-close`（不可重试）；exit 92 且 stderr 含 `REFUSED_STREAM` → `refused-stream`（可重试）。

### 7.1 必须点名的集成风险：trailers 时序

curl 只能在进程退出后读到 trailers（`trailerTiming: "after-end"`），而现役 `onTrailers` 契约是「body 之后、`end` **之前**」，`transport/http-transport.ts:94` 据此写入 `ctx.setOutboundResponseTrailers`。

**settle 之后再写 ctx 会撞 `assertWritable` 抛错**，并可能经孤儿 promise 放大成整进程崩溃（skill `debugging-server-crashes` 的三条同构放大链之一）。

⇒ curl provider **不得**沉默地按现役假设接线。二选一，实现期必须显式决定并写进 plan：① 在 settle 前抢到 trailers；② 走 best-effort 静默丢弃路径（语义写保持 loud-throw、best-effort 观测写静默丢弃——判据同上 skill）。

## 8. 测试策略与一条固化的纪律

- **unit**：curl 参数构造；exit code → `TransportErrorReason` 的穷尽 `Record` + `never` 守卫；capability 声明的穷尽性。
- **it**：真起 Node oracle 服务端跑 h1/h2、流式、trailers、故障注入、abort、大 body 全双工。
- **守卫**：provider 契约实现完备性；capability 声明与实际行为一致（**每条 `false` 都要有正样本对照证明该能力确实缺失**，否则是自证）。
- **启动失败路径**：`binary` 指向不存在的可执行文件时进程启动失败且错误明确。

> **纪律（本轮血的教训，须同时写进 skill `debugging-ghc-api-upstream-transport`）**：h2 故障夹具的**服务端必须用 Node**；造 RST **必须用 `stream.destroy(err)`，绝不用 `stream.close(code)`**——后者不在 wire 上放出忠实 RST 帧，会让整套截断测试**假绿**。本轮两个 PoC 加主会话三方全被它骗过，并据此写出了一条与事实相反的结论。

## 9. 待评审时需要被证伪的断言

供评审者逐条取证，每条都应给 file:line 或命令输出：

1. §1 的四个耦合点是**全部**耦合点——是否漏了消费 h2 专属形状的第五处？
2. §3.1 的勘误是否成立——RFC 那条断言的原始证据是否确实来自 `stream.close(code)` 夹具？
3. §3.2 的「curl 无 h2 PING」是否穷尽——是否存在未被五条证据覆盖的写法？
4. §4.3 的 `auto` 语义是否会让任何现有上游改变传输（除明文 http 外）？
5. §7.1 的崩溃风险是否真实——`setOutboundResponseTrailers` 在 settle 后调用是否确实抛错？
6. §5 的「PING 是经代理时唯一覆盖全程的保活」是否仍与当前代码一致？
