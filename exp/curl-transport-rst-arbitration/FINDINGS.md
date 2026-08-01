# 裁决：h2 中途截断到底谁能检测到？

日期：2026-07-31 · 由主会话执行 · 复跑：`bun probe.ts`、`node probe-nodehttp2.mjs <port>`

## 为什么有这份裁决

`exp/curl-transport-exe/` 与 `exp/curl-transport-libcurl/` 两个 PoC 对「curl 能否检测 h2 单流 RST_STREAM」给出**相反**结论（exe: exit 0 失明；libcurl: code 92 抓到）。同一个 libcurl 8.5.0，不可能都对。

## 第一层：冲突是 oracle 差异造成的

| PoC | `/rst` 端点 | 结果 |
|---|---|---|
| exe | `stream.respond({...})` —— **无** `content-length` | exit 0 |
| libcurl | `stream.respond({..., "content-length": "100"})` | code 92 |

交叉验证（`probe.ts` / `results.jsonl`），两条腿完全一致：

| 端点 | curl exe | 进程内 libcurl |
|---|---|---|
| `/ok-nolen`（正样本对照） | exit 0 | code 0 |
| `/rst-len`（有 CL） | exit **92** | code **92** |
| `/rst-nolen`（无 CL） | exit 0 | code 0 |
| `/rst-sse`（无 CL 的 SSE） | exit 0 | code 0 |

初步结论似乎是「只有已知 Content-Length 才检测得到」。**这个结论也是错的**，见下。

## 第二层：`stream.close(code)` 根本没在 wire 上放出 RST

`NODE_DEBUG=http2` 帧级追踪（客户端侧）：

```text
/rst-len   → Http2Stream closed with code 1 (PROTOCOL_ERROR)   ← 客户端自己的 content-length 对账
/rst-nolen → Http2Stream closed with code 0                    ← 没有收到任何 RST
/rst-sse   → Http2Stream closed with code 0
```

服务端发的是 `INTERNAL_ERROR(2)`，**四个客户端没有一个看到 code 2**。

⇒ Node h2 服务端的 `stream.close(code)` 在「已写过 DATA、未 END_STREAM」这个形态下**不发忠实 RST 帧**。`-len` 那格测到的是客户端自己的长度对账，与 RST 观测无关。

> 本项目 skill `debugging-ghc-api-upstream-transport` 已记载「Bun 服务端 `stream.close(code)` 不发忠实 RST」。**本次证明 Node 服务端在此形态下同样不忠实** —— 该 caveat 的适用范围比原记载更宽。

**因此：两个 PoC 的所有 h2 RST 行、以及本仓库 RFC 中「Bun 的 node:http2 对 clean server RST 交付 synthetic clean end」这一断言，其证据基础都是同一个不忠实夹具，全部作废。**

## 第三层：造出忠实 RST 后，结论反转

三种服务端变体（`/tmp/rst-faithful.mjs`，SSE 端点、无 content-length）：

```text
A  stream.close(INTERNAL_ERROR)   → curl 无错误          （夹具不忠实）
B  stream.destroy(new Error())    → curl: (92) ... INTERNAL_ERROR (err 2)   ✅ 忠实
C  stream.close(REFUSED_STREAM)   → curl 无错误          （夹具不忠实）
```

对变体 B（**忠实 RST，SSE，无 Content-Length**）的四客户端矩阵：

| 客户端 | 结果 | 检测到？ |
|---|---|---|
| curl exe | exit 92 `INTERNAL_ERROR (err 2)` | ✅ |
| 进程内 libcurl（bun:ffi） | code 92 `Stream error in the HTTP/2 framing layer` | ✅ |
| `node:http2` under **Node** | `error:ERR_HTTP2_STREAM_ERROR`, `rst=2` | ✅ |
| `node:http2` under **Bun** | `error:ERR_HTTP2_STREAM_ERROR`, `rst=2` | ✅ |

**全部检测到，包括 Bun。**

## 最终事实

| 中断形态 | curl exe | 进程内 libcurl | node:http2 @Bun | node:http2 @Node |
|---|---|---|---|---|
| 忠实 RST_STREAM（SSE，无 CL） | ✅ 92 | ✅ 92 | ✅ rst=2 | ✅ rst=2 |
| 整连接 drop（`session.destroy()`） | ✅ 18 | 未直接测 | ❌ 合成 clean end | 未测 |
| 服务端 `stream.close(code)` | 夹具不忠实，四方均不适用 | | | |

连接 drop 行沿用 `exp/curl-transport-exe/output-truncation.jsonl` + `output-current-http2.jsonl`：两个客户端面对**同一个 wire**，curl 报 18 证明 drop 确实发生，而 Bun 的 `node:http2` 在同一根线上报 clean end —— 有效差分对照，不需重造。

## 对决策的影响

1. **「curl 能诚实报截断而现役实现不能」这个动机基本不成立。** 忠实 RST 下 Bun 的 `node:http2` 与 curl 同样检测得到。
2. **curl 唯一被证实的诚实性增量是「整连接 drop」这一格**，且该场景对 SSE 已有应用层 `message_stop` / `[DONE]` 兜底。
3. 因此 curl 的价值应当**只按 h1 能力评估**（Bun × undici 永久 hang 的替代），不应按「更诚实的 h2」评估。

## 本裁决没有证明什么

- 未确定 `stream.close(code)` 不忠实的确切机制（Node 是否把它与 END_STREAM 合并、还是被 write 的 flush 顺序吞掉）。
- 未复现「整连接 drop」的独立忠实夹具：本轮两次尝试一次杀死服务端、一次 drop 根本没到 wire。结论沿用 exe PoC 的差分对照而非本轮重测。
- 未测 GOAWAY、`REFUSED_STREAM(0x7)` 在忠实形态下的四方行为（后者对本项目的 retry 策略有直接影响）。
- 未在真实 GHC 上游验证任何一格。
- 未回头修正 `exp/curl-transport-exe/` 与 `exp/curl-transport-libcurl/` 两份 FINDINGS 正文，只在本文件统一勘误。
