# TTFB 超时"失效"排查——根因是配置非代码

## 触发

事故 shutdown 日志（2026-07-11 09:09）显示 8 个并发 `/v1/messages` opus-4.8 长挂：`executing 1112s/959s`、`streaming 750s`。经 History API 离线取上游原始轨，发现单次上游 attempt 挂 **691s / 750s** 才返回失败（GitHub "Unicorn" 502 页 / `NGHTTP2_REFUSED_STREAM`），远超 `responseHeaderTimeout` 默认/生效值 **300s**。

疑问：为何已存在且已接线的 300s TTFB 超时对 691s 的 h2 pre-response 挂起没有生效？

## 结论（先说答案）

**不是代码 bug。** 事故那一刻旧实例的 `timeouts.response_header` 极可能被设为 **0（禁用）**——`createResponseHeaderTimeoutSignal()` 在 `responseHeaderTimeout===0` 时返回 `undefined`，于是 streaming 路径的 `combineAbortSignals(undefined, undefined, clientAbort, reaper)` **没有 timeout 腿**，请求无限等到上游自己吐 502（691s）。用户于事故后（config.yaml mtime **09:34**）把它改回 300，问题自愈。当前生效 300 在生产精确工作。

## 证伪的三个假设（记录，避免后人重走）

1. **H0 复合信号 GC 失效**：`AbortSignal.any([AbortSignal.timeout(ms), other])` 在 Bun v24.3 / Node v24.16 都准时触发（含激进 `Bun.gc(true)` / `--expose-gc` 压力）。见 `gc-probe.mjs`。**推翻。**
2. **H1 排队 stream 忽略 abort**：maxConcurrentStreams 下被本地排队的 h2 stream，`AbortSignal` → `req.close(NGHTTP2_CANCEL)` 仍在超时点精确 reject。见 `probe.mjs`。**推翻。**
3. **H3 691s 是多次重试累加**：日志时间线证明 attempt[0] 是**单次连续** 691s（08:50:51 启动 → 09:02:22 唯一一条 502 日志），仅触发 1 次重试。**推翻。**

## 决定性正证（当前生效 300 的实例）

History API 取当前实例真实记录：
- `req_...364` @10:54 attempt[0] dur=**300147ms** → 恰 300s 熔断（up.status=None=被 abort）。
- `req_...300` @10:42 attempt[0] 71s→502，重试 attempt[1] dur=**300178ms** → 又恰 300s 熔断。
- `req_...342` dur=**256621ms** up.success=True → 合法 256s 长请求正常成功、未误杀（< 300s）。

即 300s TTFB 超时在生产精确工作、且不误伤 < 阈值的合法长请求。

## 忠实复现方法（4 层，全部在超时点 abort）

`e2e-concurrent.mts` 是最接近事故的复现：真 `http2Fetch` + 真 `combineAbortSignals` + 真 `createResponseHeaderTimeoutSignal`，静默 TLS h2 server（`maxConcurrentStreams` 低）+ 多并发共享池化 session，`responseHeaderTimeout` 设小值。所有携带 timeout 的请求都在阈值精确 abort。

坑：TLS `servername` 不接受 IP（用 `localhost` + 匹配证书）；`NODE_TLS_REJECT_UNAUTHORIZED=0` 须在进程启动前经 env 设置（进程内 `process.env` 赋值太晚）。

## 代码链锚点

`send.ts:111` `combineAbortSignals(createResponseHeaderTimeoutSignal(), stream?undefined:getShutdownSignal(), clientAbortSignal, reaperSignal)` → `upstream-fetch.ts` https→`http2Fetch` → `http2-client.ts` `runHttp2Fetch` 的 `onPreResponseAbort`（`req.close(NGHTTP2_CANCEL)` + reject）。`fetch-utils.ts:23` `responseHeaderTimeout===0 → undefined`（禁用腿）。d54fdba5（旧实例基）与 HEAD 此四文件提交版全同。

## 教训 / 后续

- **`response_header: 0` 是危险配置**：禁用后 GHC 长挂起可让单请求挂数百秒到上游自 502。考虑加下限/告警（deferred，待用户定）。
- **per-model 过载背压（独立特性）价值不减**：即便 300s 生效，`req_300` 仍"71s→502→重放同 payload→再挂 300s"=371s 白烧。GHC 过载时反复等 300s + 重放极浪费，正是背压要解决的。
