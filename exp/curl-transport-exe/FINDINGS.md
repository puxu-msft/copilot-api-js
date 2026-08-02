# PoC：curl 可执行文件能否作为上游传输实现（h1 + h2）

日期：2026-07-31 · 环境：Bun 1.3.14 / curl 8.5.0（nghttp2 1.59.0）/ Linux WSL2 · 复跑入口：`./run-all.sh`

> 本文由 PoC agent 实测产出，主会话核对了其中两条决定性数据（`output-truncation.jsonl` 的 h2-rst 行、`output-current-http2.jsonl` 的对照组）后落盘。

## 结论

**有条件可行，但不能完整替代现役 `node:http2` 传输。**

curl 在 Bun 下可覆盖 h1/h2 请求、流式 body、代理、TCP keepalive、大 POST 全双工、trailers，以及多数**连接级**截断。两个决定性能力缺口：

1. **h2 单流 `RST_STREAM` 截断无法诚实报告** —— 与现役 `node:http2` 同样失明。
2. **curl CLI 完全没有周期 HTTP/2 PING 能力** —— 经代理时长 thinking 保活相对现役实现发生**回退**。

此外每请求一个进程默认失去跨请求连接池。对 `https://api.github.com/meta` 连续 20 次：

| 实现 | TTFB median | TTFB p95 |
|---|---:|---:|
| curl exe（每次冷连接） | 42.840ms | 114.011ms |
| pooled `node:http2` session | 5.422ms | 10.602ms |
| **差值** | **+37.418ms** | **+103.409ms** |

## 事实矩阵

### 1. 状态行与响应头（`output-headers.jsonl`）

```text
-i h1:                                   HTTP/1.1 200 OK … BODY-OK，exit 0
-i h2:                                   HTTP/2 200 … x-mixed-case: Value，exit 0
-D /dev/fd/3，stdio[3]="pipe":           exit 23
-D /dev/stderr，stderr="pipe":           exit 23
-D 普通临时文件:                          exit 0，body/headers 分离
-D /dev/fd/3，fd3 绑定预先 open 的普通文件: exit 0
```

**`-D` 不能写 pipe**（exit 23 `Failed writing received data`）。Node `child_process.spawn` 下同样失败 → **不是 Bun 独有**，是本 curl 构建对 pipe 型 dump-header sink 的限制。Bun 的 `stdio` 数组确实能创建第 3 个 fd（`proc.stdio[3]` 返回 number），问题不在 fd 创建。

推荐做法：预先 `open` 一个 0600 普通文件、立即 `unlink`、把该 fd 继承为 fd 3，用 `-D /dev/fd/3`。body 独占 stdout、stderr 留诊断、metadata 走匿名文件 fd。

**不推荐生产用 `-i`**：body 可以包含类 header 字节，且 trailers 紧贴 body 之后出现，无法仅靠第一个空行完整分离 metadata。

h2 状态行实测为 `HTTP/2 200 `，header name 全部小写。

### 2. HTTP/2 trailers（`output-trailers.jsonl`）

curl **能**透出 h2 trailers。Node oracle（`waitForTrailers: true`）发 `x-trailer-one/two`，`-D` 文件里 trailers 追加在初始 header block 之后：

```text
HTTP/2 200
content-type: text/plain
…

x-trailer-one: one
x-trailer-two: two
```

正反对照：请求 `/trailers` 捕获 2 条 `x-trailer-*`，改请求 `/ok` 后为 0 条 —— 证明探针确实触达 trailing HEADERS，不是恒真。

能力边界：`-D` 输出**没有显式 trailers marker**；存在 1xx / redirect / 认证重试等多 header block 时必须自建解析状态机。本 PoC 只在 curl 退出后可靠读取该文件，**没有证明能保持现行 `onTrailers`「body data 之后、end 之前回调」的精确时序**。

### 3. 诚实的截断报告（`output-truncation.jsonl` / `output-current-http2.jsonl`）

```text
h2 clean:                 exit 0   BODY-OK
h2 RST_STREAM(CANCEL):    exit 0   PARTIAL-H2-RST-8   stderr=""
h2 connection destroy:    exit 18  PARTIAL-H2-DESTROY  "Transferred a partial file"
h1 Content-Length 短读:    exit 18  "transfer closed with 75 bytes remaining to read"
h1 chunked 缺结束块:       exit 18  "transfer closed with outstanding read data remaining"
```

h2 RST code 0 / 1 / 2 / 7 / 8 五项**全部**是「部分 body + exit 0 + 空 stderr」。

| 场景 | curl exe | 现役 node:http2 (Bun) |
|---|---|---|
| h1 Content-Length 短读 | ✅ exit 18 | 不适用（h1 不走它） |
| h1 chunked 缺 `0\r\n\r\n` | ✅ exit 18 | 不适用 |
| h2 整连接断开 | ✅ exit 18 | ❌ 合成 `end(rstCode=0)` |
| **h2 单流 RST_STREAM** | ❌ exit 0 | ❌ 合成 `end(rstCode=0)` |

对照组原始事件（三种场景**全部**如此）：

```text
response → data → end(rstCode=0) → close(rstCode=0)
```

**推论：curl 改善了「整连接断开」，但没有解决「单流 RST」。** 由于 SSE 响应从不带 `Content-Length`，本项目仍必须保留 `message_stop` / `[DONE]` 等**应用层终止符**检查 —— 对无独立协议终止符的响应，curl 的 exit 0 不能证明完整。

### 4. 中止与资源回收（`output-abort-loop.jsonl`）

先从 `-N` stdout 读到 `PREFIX` 再 kill，各连跑 30 次：

```text
SIGTERM: median 0.874ms  p95 1.062ms  max 1.083ms  exit 143/SIGTERM
SIGKILL: median 0.932ms  p95 3.276ms  max 4.021ms  exit 137/SIGKILL
两组 beforeFds=12 afterFds=12  childStates=[]  zombies=[]
```

kill 后 stdout EOF，curl **不会**自行补截断诊断 → 驱动器必须依据本方 abort reason + `signalCode` 分类（与本项目 abort-provenance 纪律一致）。

前提：始终 `await proc.exited`。fire-and-forget kill 不 reap child 的形态**不在本 PoC 证明范围**。

### 5. 连接复用与代价（`output-multi.jsonl` / `output-config-stream.jsonl` / `output-ttfb.jsonl`）

一个 curl 进程能复用**预先给定**的请求：本地 `--next` 顺序 3 URL 只建 1 条 TCP 连接；公网同 host 3 URL 的 trace 出现 2 次 `Re-using existing connection`；`--parallel` 可跑预先给定的多 URL。

**但它不能成为运行中按需接受请求的 daemon**。`curl -K -` 实测：

```text
写入完整 URL 配置并 flush，等 300ms：requests=0，进程未退出
关闭 config stdin 后：             requests=1，exit 0
```

即配置**必须读到 EOF 才执行**，stdin 不是在线 request protocol。要获得常驻按需池，只能另写使用 libcurl multi API 的长期进程，或继续用 `node:http2` —— 那已不是「curl exe 每请求一进程」。

### 6. 保活（`output-keepalive.jsonl` / `probe-node-ping.mjs`）

`--keepalive-time 3` 的 `ss -tno` 采样（偏移 0 / 1000 / 2500 / 3500ms）：

```text
timer:(keepalive,2.992ms,0)
timer:(keepalive,1.984ms,0)
timer:(keepalive,2.632ms,0)
timer:(keepalive,2.200ms,0)
```

⚠ 单位读法：`ss` 这里的 `ms` 后缀是渲染怪癖，实际是 **3 秒**倒计时（首两次采样 2.992→1.984 恰好是 1 秒后的锯齿）。要点在于它是**秒级**而非 OS 默认的小时级（7200s）→ 配置**确实落到内核 socket**。

**h2 PING 的否定性取证（五条独立证据）**：

1. curl h2 静默流持续 7 秒，Node oracle 收到 **0** 个 PING。
2. 同一 oracle 上跑 `node:http2 session.ping()` 后计数 0 → 1（**正样本证明 oracle 确实能观察到 PING**，不是恒零）。
3. `curl --help all` 搜 `ping` 无选项。
4. 已安装 libcurl headers 搜 `CURLOPT_*PING` / `HTTP2*PING` 无结果。
5. `--libcurl` 生成的代码只有 `CURLOPT_TCP_KEEPALIVE`，无 h2 PING 控制。

结论限定于 curl 8.5.0 CLI 与本机 libcurl API 表面：**没有周期发送 HTTP/2 PING 的办法。**

### 7. 代理（`output-proxy.jsonl`）

Bun.spawn 下四条路径均成功，目标 transfer 的 `%{http_version}` 均为 `2`：

```text
--proxy http://127.0.0.1:19082                  exit 0  http_version=2
--proxy https://localhost:19444                 exit 0  http_version=2
--proxy https://localhost:19444 --proxy-http2   exit 0  http_version=2
--socks5 127.0.0.1:19083                        exit 0  http_version=2
```

`--proxy-http2` 改变的是到 HTTPS proxy 的 proxy leg；CONNECT 隧道内目标 TLS ALPN 仍协商 h2（与本项目现有认知一致）。

### 8. 请求体与 headers（`output-body.jsonl` / `output-body-loop.jsonl`）

`--data-binary @-` 从 Bun stdin 喂 32MiB，服务端每读一块即回写同量数据（真全双工），curl 用 `-N`：

```text
exit 0   request bytes=33554432   stdout bytes=33554451
sha256=05f052c8f6da8ee5228ec291820b559c4be183773b9e97a6b82e30dacff85dd3
```

同场景连跑 10 次全部 exit 0，**无 pipe deadlock**。

关键前提：父进程从启动起**并发** drain stdout/stderr，同时 feed stdin，写完调 `stdin.end()`。`-N` 本身**救不了**「先写完 stdin 才读 stdout」的错误驱动方式。

任意 header 作为独立 argv 传给 `-H`、不经 shell。实测 `-H "X-Special: spaces; $dollar, colon: value"` 与 `-H "X-Empty;"` 服务端分别收到原值与空值。发真正空值须用 `X-Empty;`（`X-Empty:` 会被 curl 解释为**移除**内部 header）。

### 9. 进程开销（`output-overhead.jsonl`）

loopback 7-byte 响应连跑 50 次：

```text
spawn-to-exit wall: median 7.843ms  p95 9.844ms
curl 本地 TTFB:     median 0.595ms  p95 0.930ms
wall - TTFB:        median 7.182ms  p95 8.978ms
```

`wall - TTFB` 含进程装载、body 完成、pipe、exit 与 reap，不是纯 `fork/exec` CPU 时间，但可作为每请求固定开销量级。

## 能力缺口清单

1. **h2 单流 RST 截断被误报成功**（与现役实现同样失明，未改善）。
2. **无端到端 h2 PING**；经 proxy 的长 thinking 保活失守（相对现役是**回退**）。
3. **无常驻按需 session 池**；多 URL 复用仅覆盖预知 batch。
4. 不具备现役的容量选路、reservation、per-session cap、per-origin 硬 cap、idle-reap、GOAWAY retire-and-drain。
5. `-D` 不能写 pipe，必须用普通文件型 fd；metadata **不是**实时 callback。
6. 未证明可精确满足 `onTrailers` 的回调时序。
7. `onStreamClosed` 只能近似为 child exit / stdout EOF，拿不到真实 h2 physical stream close、RST code 或 GOAWAY 生命周期。
8. exit code / stderr 无法完整恢复现役结构化 `pre-response-close` / `refused-stream` / `mid-body-close` 分类。

## 本 PoC 没有证明什么

- 未请求真实 GHC 上游，未验证真实 SSE、鉴权、限流、GOAWAY 或长 thinking。
- 未跑数分钟至数小时的 NAT / LB / 企业 proxy idle-reap。
- 未穷尽 1xx、redirect、401/407 retry 与 trailers 混合时的 header 状态机。
- 未证明 trailers 可在 body end **之前**实时回调。
- 未覆盖 HTTP/3、WebSocket、server push、双向 h2 streaming。
- 未覆盖 proxy auth、企业 MITM CA、mTLS、NO_PROXY、PAC 与通用 IPv6。
- 未做数百并发 curl 进程、磁盘满、fd 上限或慢消费者压力实验。
- TTFB 只是一台机器、一个公网 host、20 样本的量级观察，**不是正式 benchmark**。
- 「没有 h2 PING」未穷尽未来 curl 版本、私有 patch、直接调用 nghttp2 或改 curl 源码。
- **未交叉验证 h2 RST 失明是 CLI 层还是 libcurl 层**（同一 libcurl 的进程内绑定是否同样失明，由 `exp/curl-transport-libcurl/` 回答）。

## 产物

`run-all.sh`（复跑入口，最新一次 exit 0）· `oracle.mjs`（Node h1/h2 故障 oracle）· `probe-local.ts` · `probe-abort-loop.ts` · `probe-keepalive.ts` · `probe-multi.ts` · `probe-config-stream.ts` · `probe-ttfb.ts` · `probe-current-http2.ts` · `probe-node-ping.mjs` · `output-*.jsonl` · `run-all.log`

未修改 `src/` / `tests/`，未 git add/commit。实验端口均已释放。
