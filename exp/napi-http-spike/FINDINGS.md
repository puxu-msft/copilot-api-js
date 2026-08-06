# Spike：napi-rs + reqwest 能否作为上游传输 provider

日期：2026-08-03 · 环境：Rust 1.97.1（`RUSTUP_HOME=/home/xp/.local/rustup`）/ Bun 1.3.14 / Node 24.16.0 · 锁定版本：`napi 3.12.0`、`reqwest 0.13.4`

复跑：

```bash
export RUSTUP_HOME=/home/xp/.local/rustup
export PATH="$HOME/.cache/cargo/bin:$PATH"
bash exp/napi-http-spike/run-all.sh      # 全量
bash exp/napi-http-spike/build.sh        # 只构建（生成自签证书 + release build）
```

## 结论

**四个核心门槛全部实测通过，且每项都做了 mutation 正控。** Rust + napi-rs + reqwest 可作为本项目上游传输 provider 的技术底座。

## 1. napi-rs 的 ThreadsafeFunction 在 Bun 下可用 ✅

同一份 `.node` 在 Node 24.16.0 与 Bun 1.3.14 下运行，Rust 自有 Tokio 多线程 runtime 每 40ms 从 worker thread 经 napi-rs `ThreadsafeFunction`（`MaxQueueSize=1`、`Blocking`）回调 JS：

```text
Node: 5 次按序回调 @ 41.9 / 83.1 / 124.3 / 165.7 / 207.1 ms
Bun : 5 次按序回调 @ 42.2 / 83.1 / 125.9 / 165.7 / 207.0 ms
```

**正控**：把预期 5 次改成实际只发 4 次 → probe 退出码 1 变红，证明断言咬得住缺回调。

> ⚠ **实现期必踩的坑**（首版真的踩了）：从普通 N-API 导出直接 `napi::tokio::spawn` 会在**两个运行时都 panic**：
> ```
> there is no reactor running, must be called from the context of a Tokio 1.x runtime
> ```
> 正式实现**不能假定 napi-rs 导出入口已处于 Tokio context**，原生模块必须自己持有显式 runtime。

## 2. 流式字节增量回到 JS ✅

Node HTTP/1 chunked/SSE oracle 分三次写 11/11/13 字节、间隔 ~250ms，第三块后再等 ~100ms 才结束响应：

| Runtime | oracle 写入时刻 | JS 收到时刻 |
|---|---|---|
| Node | 152.5 / 401.6 / 651.7 ms | 157.8 / 406.5 / 656.4 ms |
| Bun | 151.8 / 401.4 / 651.5 ms | 157.5 / 406.6 / 656.7 ms |

两端 `completed:3`，相邻 callback 间隔 ~249–250ms ⇒ **是增量交付，不是 EOF 后一次性回调**。

**正控**：把断言改成「相邻块必须间隔 > 400ms」→ 退出码 1 变红。

## 3. h2 PING 真正到达 wire ✅ —— **本次选型的决定性证据**

Node `http2.createSecureServer` TLS oracle 监听 `session.on('ping')`。reqwest 配 `http2_keep_alive_interval=1s` / `http2_keep_alive_timeout=2s` / `http2_keep_alive_while_idle=false`；服务端**只发响应头、不写 DATA**，保持 stream 活跃 5.5 秒。

主会话独立复跑原始输出：

```text
{"event":"ping","label":"control","payload":"434f4e54524f4c21","controlPings":1,"rustPings":0}
{"event":"ping","label":"rust","payload":"3b7cdb7a0b8716b4","controlPings":1,"rustPings":1}
... ×5 ...
{"event":"summary","totalPings":6,"controlPings":1,"rustPings":5}
```

- **正样本对照**：先由独立 Node client 调 `session.ping(Buffer.from("CONTROL!"))`，oracle 记到 payload `434f4e54524f4c21` ⇒ **监听器确实能观察到 PING**，「计数为 0」与「监听器坏了」可区分。
- **mutation 正控**：把 `http2_keep_alive_interval` 改成 `None` 后，`controlPings:1` 仍在而 `rustPingCount:0`，harness 退出码 1；恢复后重新绿 ⇒ **计数确实依赖 reqwest 的 keepalive 机制**，不是 oracle 自发事件或标签串线。

**这正是 curl 归零的场景**（`curl_easy_upkeep` 够不到在途 transfer），也是本项目长 thinking 经代理时唯一覆盖真上游全程的保活。

> 复核范围说明：主会话独立复跑的是 **Node-host addon** 那条腿（探针内部以 Node 托管 addon，即使用 `bun` 启动）。**Bun-host 腿沿用 spike 报告（`rustPings:5`），未经主会话独立复核。**

## 4. abort / 取消 ✅

对已收到响应头、body 永久 held-open 的请求，JS 在 ~350ms 调 `cancelRequest`：

```text
Node: cancel → done callback 0.2ms      Bun: 0.3ms
两端 done 后: activeTasks:0, requestIsRegistered:false, outcome:"cancelled"
```

独立 Node oracle 同时观察到 `request-aborted` / `response-close`（`writableEnded:false`）/ `request-close`；h2 路径另见 `rstCode:8`（CANCEL）⇒ **Rust body task 与在途连接确实结束**，不只是 JS 侧状态变化。

**正控**：把预期 `activeTasks` 改成错误值 999 → 退出码 1。

## 次要项

**5. Backpressure（初步通过）**：`MaxQueueSize=1` + `Blocking` 下，Rust 连发 120 事件而 JS 每回调 busy-wait 5ms —— Rust 最后一次 enqueue @ ~594ms（Node）/ ~595ms（Bun），JS 最后消费 @ ~610/611ms ⇒ **producer 被消费速度反向节流，没有无界排队**。
⚠ 该结论**绑定于有界 TSFN 策略**；若改成无界 `NonBlocking` 则不成立。正式实现应保留有界 TSFN 或改为 pull-based `ReadableStream`。

**6. 事件循环阻塞（本地低吞吐未观察到）**：请求期间 10ms metronome 最大 tick gap —— HTTP/1 流 10.9ms(Node)/13.6ms(Bun)、abort 10.3/14.9ms、h2 held-open 18.5/16.4ms、TCP keepalive held-open 15.5/18.6ms。**不是正式 benchmark**。

**7. TCP keepalive 落内核 ✅**：`ss -tno` 独立观察到 `timer:(keepalive,200ms,0)` / `timer:(keepalive,208ms,0)`（系统默认 `tcp_keepalive_time=7200s`，故非默认值假绿）。
⚠ **只设 `tcp_keepalive(1s)` 会看到 ~14s**——reqwest 0.13.4 的 `tcp_keepalive_interval` 默认 15s。要得到完整秒级策略**必须同时显式设 time + interval + retries**。

## 资源与实现提示

- release `.node` **约 6.5MB（已 strip）** —— 直接决定 per-platform 分发矩阵的体积。
- 本地 Cargo `target/` 约 384MB（构建缓存，非发布体积，**不入库**）。
- spike runtime：2 个 Tokio worker threads。
- ⚠ **spike 每请求新建 reqwest `Client`**（为隔离实验）。正式实现**必须**改为 provider 生命周期持有的长寿命 client，否则拿不到跨请求连接池复用。
- ⚠ `danger_accept_invalid_certs(true)` 仅用于本地自签 oracle，**正式实现不得照搬**。

## 本 spike 没有证明什么

- 没有完成正式 `UpstreamTransportProvider` / registry / selection / status snapshot / shutdown 接线。
- 没有验证真实 GHC 上游、MITM/HTTP/SOCKS 代理、**代理隧道内的 h2 PING**、企业 CA、mTLS。
- 没有验证 request body streaming、全双工上传、trailers、完整 header 语义、重定向与错误分类。
- **没有验证跨请求连接复用**（spike 每请求一个 client）。
- 没有验证多请求并发、连接池容量、admission queue、idle reap、GOAWAY/RST/connection-drop 分类、进程 shutdown barrier。
- 没有做正式吞吐/延迟/CPU/内存 benchmark；事件循环与 backpressure 数字只是受控量级观察。
- **没有证明 macOS / Windows / musl / ARM64 产物或 optional sibling package 分发**（本机仅装 `x86_64-unknown-linux-gnu` target）。
- 没有验证 addon unload、JS runtime shutdown、callback throw、TSFN closing 与取消同时发生的竞态。
- h2 PING **只验证了本地直连 TLS h2**，不证明每种代理拓扑都保留 PING。
- 探针结果**未持久化为结果文件**（只有 stdout）；主会话复跑了 h2 PING 一项，其余沿用 spike 报告。
