# Phase 0 探针报告:h2 客户端如何 surface REFUSED_STREAM(Bun vs Node)

目的:写 classify 匹配式前,实证钉死 pre-response REFUSED 的确切 `err.message`/`err.code`,并确认修复在生产运行时(Bun)有效。

环境:Node v24.16.0 / Bun v1.3.14 / Linux x64。脚本:`probe-refused.mjs`(同运行时)、`probe-x.mjs`(跨运行时,决定性)。

## 结论(决定性:Node-server ← Bun-client,忠实镜像生产 Bun-client ← GHC)

| 场景 | Node client | Bun client |
|---|---|---|
| **A. 真实 RST_STREAM(REFUSED)**(Node 服务端 `stream.close(REFUSED)`,发真帧) | `ERR_HTTP2_STREAM_ERROR` / `"Stream closed with error code NGHTTP2_REFUSED_STREAM"` / rstCode=7 | **同左,逐字一致** ✅ |
| B. MAX_CONCURRENT_STREAMS=1 超限 | 本地排队(不派发,无错误) | `ERR_HTTP2_STREAM_ERROR` / `"…NGHTTP2_INTERNAL_ERROR"` / rstCode=2 |

**核心事实**:Bun 客户端收到真实服务器 RST_STREAM(REFUSED) 帧时,抛出与生产日志**逐字一致**的 `"Stream closed with error code NGHTTP2_REFUSED_STREAM"`(code=`ERR_HTTP2_STREAM_ERROR`)。→ classify 匹配子串 `NGHTTP2_REFUSED_STREAM` 在 Bun 上有效,修复对生产 case 生效已证。

## 关键陷阱(为何 v1/v2 误导)

1. **Bun 服务端 `stream.close(code)` 不发忠实 RST 帧**:Bun-server→Bun-client(v2 probe A)时,Bun **客户端**看到 `clean end / rstCode=0 / 无错误`。这是 Bun **服务端**的问题,**非**客户端。必须用 Node 服务端(发真帧)才能测出 Bun 客户端的真实行为。→ 教训:测 REFUSED 重试,服务端夹具须用 **Node h2 server**(`http2.createServer` + `stream.close(REFUSED)`),客户端才收到真帧。
2. **code 不可用于区分**:REFUSED 与 INTERNAL_ERROR 的 `err.code` **都是** `ERR_HTTP2_STREAM_ERROR`,具体码只在 `err.message`(`NGHTTP2_REFUSED_STREAM` vs `NGHTTP2_INTERNAL_ERROR`)。→ 印证方案 M1:必须按 **message 子串**匹配,按 code 会破坏 REFUSED/CANCEL/INTERNAL 边界。probe B 的 `NGHTTP2_INTERNAL_ERROR` 样本即边界反样本(子串匹配不会误命中)。

## GOAWAY scope 决定

未能在探针中自然复现 `ERR_HTTP2_GOAWAY_SESSION`(Bun 超限走 INTERNAL_ERROR;两运行时的 GOAWAY drain 未触发该 code)。生产日志亦只见 REFUSED_STREAM。→ **scope 到 REFUSED_STREAM**(实证 + 生产观测),helper 留一行扩展位 + 文档标注:`ERR_HTTP2_GOAWAY_SESSION` 属同一协议安全族(RFC:高于 Last-Stream-ID 的流未处理),若生产日志出现即扩展同一 helper。非"无数据暂缓"——已探针,只是未复现。

## 对实现/测试的影响

- classify 匹配:`err.message` 含 `NGHTTP2_REFUSED_STREAM`(大小写不敏感,递归 cause)。
- transport 级 oracle 测试:服务端夹具用 **Node** `http2.createServer` + pre-response `stream.close(NGHTTP2_REFUSED_STREAM)`;`setHttp2SessionFactoryForTests` 注入 h2c 连接。**注意**:该测试在 `bun test`(Bun 客户端)下,只要服务端是真 Node h2 server 就能收到真帧 —— 但服务端 server 若也跑在 bun test 进程内(Bun http2.createServer),会退回 v2 的"不发真帧"陷阱。需评估:bun test 内 `http2.createServer` 是否发真 RST(疑似不发)。退路:classify 单元测试(合成 message)+ 本报告 + 生产 log 作 oracle。
