# PoC：进程内 libcurl 能否作为上游传输实现

日期：2026-07-31 · 环境：Bun 1.3.14 / Node v24.16.0 / 系统 libcurl 8.5.0（OpenSSL 3.0.13 + nghttp2 1.59.0）· 复跑：`./run-all.sh`

> 由 PoC agent 实测产出，主会话核对 `final-run-results.jsonl` 后落盘。
>
> ⚠ **勘误**：本文「h2 RST_STREAM → code 92」一行的 oracle 用了 `stream.close(code)`，事后证明该夹具**不发忠实 RST 帧**，测到的实为客户端自身的 Content-Length 对账。忠实夹具下的四客户端矩阵见 [`../curl-transport-rst-arbitration/FINDINGS.md`](../curl-transport-rst-arbitration/FINDINGS.md)，**以该裁决为准**。

## 可行性结论

**没有任何一条已实测路径同时满足 Bun + Node + 完整能力面。**

| 路径 | 结论 |
|---|---|
| `node-libcurl@5.1.2` | **Node 可行，Bun 不可行**。不是普通加载失败，而是初始化异步 `Multi` 时 panic：`unsupported uv function: uv_timer_init` |
| Rust + napi-rs + `curl` crate | **未验证**。最小 spike 已写，本机无 Rust toolchain，按判据停在构建门口 |
| Bun FFI + 系统 libcurl | **Bun 侧有条件可行**，能力面基本跑通；但 Node 不支持 `bun:ffi`，且 h2 PING 未成立 |

## 路径实测

### 1. `node-libcurl`

在 `/tmp/copilot-libcurl-node-poc` 独立安装（未改仓库依赖文件），命中约 13MB 预编译产物 `node_libcurl-v5.1.2-node-v137-linux-x64-glibc.tar.gz`（内置 libcurl 8.17.0），未回退 node-gyp。

```text
Node v24.16.0:  statusCode=200  bytes=559  elapsedMs=70.9  httpVersion=3
Bun  1.3.14:    exit=1
                Bun encountered a crash when running a NAPI module that tried to
                call uv_timer_init libuv function.
                panic(main thread): unsupported uv function: uv_timer_init
```

直接加载 `.node` 能列出 `Easy` / `Multi` 符号 ⇒ N-API 基础加载、架构、glibc 均匹配；**失败层是绑定内部 `Multi` 依赖了 Bun 尚未实现的 libuv API**。同步 `Easy` 不能构成替代（见下方事件循环测量）。

### 2. Rust + napi-rs

已写最小源码（`rust-spike/`：`Cargo.toml` / `src/lib.rs` / `build.sh` / `load.mjs`），形态对齐 `native/history-search`：`cdylib` + napi-rs 3.10.5 + 异步导出，curl easy 跑在 `tokio::task::spawn_blocking`。

```text
$ rustup toolchain list
no installed toolchains
error: rustup could not choose a version of cargo to run...
```

**不能声称它已编译或可加载。**

### 3. Bun FFI

`dlopen("/lib/x86_64-linux-gnu/libcurl.so.4")` 成功。最小 easy HTTPS：`code=0`、`bytes=559`，`WRITEFUNCTION` 经 `JSCallback` 收到真实响应字节 ⇒ **C 回调能安全接住流式数据**，不只是能调无回调的 API。

## 能力覆盖矩阵（Bun FFI 路径）

| 能力 | 实测结果 |
|---|---|
| h1 / h2 | 均成功 |
| 增量响应 | ✅ 三块分别约 16 / 196 / 376ms 到达 |
| HTTP/2 trailers | ✅ 正文三块后收到 `x-oracle-trailer`（**实时 header callback**，非事后读文件） |
| h2 RST_STREAM | code 92 —— ⚠ 夹具不忠实，见顶部勘误 |
| h2 连接 destroy | code 18 `CURLE_PARTIAL_FILE` |
| h1 chunked 缺结束块 | code 18 |
| h1 Content-Length 不足 | code 18 |
| 连接复用 | ✅ 两次 `connId=0`，第二次 `numConnects=0`、TLS=0ms |
| TCP keepalive | ✅ 落内核，`ss` 见 `timer:(keepalive,...)` |
| **h2 PING** | ❌ **系统 libcurl 8.5.0 活跃 multi 请求中未发出** |
| write callback abort | ✅ 立即，code 23 |
| progress callback abort | ⚠ code 42，但静默期约 1 秒才触发 |
| multi remove abort | ✅ 目标 180ms → 实际 184ms，remove 自身 0.165ms |
| **同步 easy 事件循环** | ❌ **不可接受**：1.61s 请求造成 1615.1ms 最大 tick gap |
| multi 事件循环 | ✅ 可接受：389ms 请求中 10ms metronome 得 37 tick，最大 gap 13.2ms |

### 连接复用

```text
first:   connId=0  numConnects=1  TLS=2.450ms  TTFB=3.528ms
second:  connId=0  numConnects=0  TLS=0        TTFB=1.095ms
```

Node oracle 侧亦观察到两请求共用同一 h2 session。仅证明 loopback 上确实复用，**不是公网性能基准**。

### h2 PING（关键未闭合项）

8 秒活跃 `/hold-long` 请求期间：

```text
CURLOPT_UPKEEP_INTERVAL_MS=100
curl_easy_upkeep calls=66      upkeep errors=0
Node h2 observed PING frames=0
```

**正样本对照**：同一服务端监听器在 Node 客户端调 `session.ping()` 后记录到 `{"event":"h2-ping","payload":"6f7261636c652121"}` ⇒ 「0 PING」不是监听器失效。`curl_easy_upkeep()` 返回 0 **不能**当作真的发出了 PING。

额外对照：

- `node-libcurl`（内置 libcurl 8.17.0）在活跃异步请求期间调 `handle.upkeep()` → 绑定内部 `Multi.cc:885` assertion 崩溃。
- Conda libcurl 8.18.0 的 easy HTTPS 可运行，但同样的活跃 multi + upkeep 探针在第 43 次 `curl_multi_perform` 返回 `CURLM_BAD_EASY_HANDLE`。

⇒ 只能证明**该调用组合不成立**，不能外推为「所有现代 libcurl 都无法对活跃流发 PING」。但对本项目而言，**当前可得的每条进程内 libcurl 路径都拿不到 h2 PING**。

参考：[`curl_easy_upkeep`](https://curl.se/libcurl/c/curl_easy_upkeep.html) · [`CURLOPT_UPKEEP_INTERVAL_MS`](https://curl.se/libcurl/c/CURLOPT_UPKEEP_INTERVAL_MS.html) · [maintainer 关于 multi upkeep 的说明](https://curl.se/mail/lib-2023-01/0053.html)

### 事件循环

```text
同步 easy:  request wall=1609.8ms   metronome max gap=1615.1ms   ← 冻结事件循环
非阻塞 multi: request wall=388.9ms   10ms ticks=37   max gap=13.2ms
```

PoC 用每约 5ms 调一次 `curl_multi_perform()` + `await Bun.sleep(5)`，**仅用于证明非阻塞形态成立**。正式实现应走 `curl_multi_socket_action` + socket/timer callback，或把完整驱动封进 napi-rs，不要照抄固定轮询。

## 部署代价

| 路径 | 构建期 | 运行时与分发 |
|---|---|---|
| `node-libcurl` 预编译 | 命中 artifact 免编译；未命中回退 node-gyp + C++ + vcpkg | 每个 Node ABI × OS × arch × libc 需对应 artifact；**Bun 即使 ABI 命中仍崩** |
| Rust napi-rs | 需 Rust/Cargo；系统链接需 libcurl headers/pkg-config，或 `static-curl` 打包 | 需为每个支持平台发布 `.node` |
| Bun FFI | 免编译绑定 | 用户机器须有 ABI 兼容且带 h2/TLS 的 libcurl；**Node 无法使用**；发行版版本差异会改变行为 |

本机实况：运行库 `/lib/x86_64-linux-gnu/libcurl.so.4` 存在，但 `pkg-config libcurl` 与 `/usr/include/.../curl.h` **均不存在** ⇒ **「运行库存在」不等于「可本机编译绑定」**。

`native/history-search` 的「有产物就真跑、没有就 skip」**不能原样套到热路径传输**：搜索缺失可显式 skip，上游传输缺失则所有 HTTPS 请求不可工作。合理形态只能是「发布受支持平台预编译产物 + 缺失时启动即明确失败」或「保留现役传输作为显式 fallback」，**不能静默 skip**。

## 本 PoC 没有证明什么

- 没证明 Rust spike 能编译、能加载、能流式回调。
- 没证明 Bun FFI 能在 Node 使用。
- 没证明任意系统 libcurl 都有相同的 h2 / TLS / 错误码 / upkeep 行为。
- 没证明现代 libcurl 配合正确驱动一定能对活跃 h2 stream 发 PING。
- 没证明 5ms multi polling 是生产级方案。
- **没有实现** WHATWG `Response` 包装、`ReadableStream` backpressure、body cancel、`onStreamClosed` teardown barrier。
- **没有实现**现役的 per-session 并发 cap、per-origin 硬 cap、FIFO wait、idle reap、GOAWAY retire、配置热重载、结构化错误映射。
- 没验证 proxy / SOCKS5 / mTLS / IPv6 / 上传流 / 压缩 / 真实 GHC 上游。
- 没重跑现役 Bun `node:http2` 的截断对照，「现役会合成 clean end」沿用任务给定背景（**该背景已被裁决部分推翻，见顶部勘误**）。
- TTFB 是 loopback 粗测，不是性能 benchmark。

## 产物

`run-all.sh` · `run-keepalive-probe.sh` · `run-ping-oracle-control.sh` · `oracle.mjs` · `ffi-libcurl.ts` · `run-easy-probes.ts` · `run-multi-probes.ts` · `node-libcurl-smoke.mjs` · `rust-spike/` · `final-run-results.jsonl` · `ss-keepalive.txt`

未触碰 4141，未修改仓库根依赖文件或正式源码，未 git add/commit。
