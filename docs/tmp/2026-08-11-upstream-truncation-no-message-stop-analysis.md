# `upstream stream truncated: closed without message_stop` 请求历史分析（2026-08-11）

**问题**：用户观察到请求历史中大量出现 `upstream stream truncated: closed without message_stop`，要求分析。

**数据口径**：只读 `~/.local/share/copilot-api/history-v3.db`（解压 `v3_operations.manifest_gz` 全量扫描）+ 运行中实例 `GET /history/api/entries/:id` 全腿投影。窗口 = 该库当前保有的全部 operation：`2026-08-11T08:11:58Z → 11:44:03Z`（≈3.5 h），共 2798 条。数字随 reaper 与新请求漂移，重算用本文末尾的命令。

**运行时一致性**：运行中服务器 `gitSha d4819cb6`（分析时本地 HEAD 落后 59 提交）。本文引用的判定逻辑所在文件 `precontent-recovery-gate.ts`、`pipeline/delivery/session.ts`、`state-defaults.ts` 在 `d4819cb6..HEAD` **零差异**；`handler-v4.ts` 有差异但不触及截断/恢复分支（唯一命中是无关的 `truncateBaseline`）。故下述机制结论对**运行中的那个实例**成立。

## 1. 频次：是失败里的头号成因，但绝对比率不高

| 项 | 数 |
|---|---|
| 全部 operation | 2798 |
| 非 `completed` | 24（failed 21 + aborted 3） |
| 其中 `closed without message_stop` | **10** |
| 其中 `Stream closed with error code NGHTTP2_CANCEL` | 6 |
| 其中 `client disconnected` | 1 |
| 其余无 error 串 | 7 |

- 占全部请求 **0.36 %**；占全部失败 **42 %**。
- 「大量」的主观感受来源：它是失败里最大的一类，且**每一次都直接打断一个 turn**（客户端收到 synthetic `error` 帧终止），而不是它在总量里占比高。

## 2. 10 条全部零重试，且这是**有意设计**

`attemptCount` 全部 = 1。链路：

`handler-v4.ts` 的 `!acc.sawMessageStop` 分支 → `tryCleanEofRecovery()` → `tryReadyLiveRecovery({kind:"network-error"})` → `shouldAttemptPreContentRecovery()` → 最后一道 `return !hasDeliveredSemanticContent(input.session)`（`src/routes/messages/precontent-recovery-gate.ts:201`）。

该谓词读 `DownstreamDeliverySession.hasEmittedRealClientContent`，其翻转点在 `src/lib/pipeline/delivery/session.ts:266-278`，条件包含 `payload?.type === "content_block_start"`，注释写明是刻意的：

> A real block start is already irreversible client-visible protocol structure even before its first delta. Treat it as delivered content for recovery safety so a fresh attempt cannot open a second block at the same index beside the primary's still-open block.

**10 条全部已经把至少一个真实 `content_block_start` 发到了客户端线上** → 门关闭 → 无恢复余地，只能补一个 `error-shaping-canonical` 的 synthetic error 帧收尾。`preContentRecovery.enabled = true` 是开着的，它挡不住这一类——因为这些截断**不是** pre-content。

## 3. 截断位置：10/10 都死在「某个 content block 还开着」的时候

从不在块与块之间。按死时仍 open 的块分类：

| 时刻 | 时长 s | 请求 MB | 上游事件数 | 末字节后静默 s | 死时 open 的块 |
|---|---|---|---|---|---|
| 09:12:44 | 536.2 | 4.75 | 12 | 528.7 | `tool_use` Write |
| 09:38:01 | 5.7 | 3.07 | 3 | 2.9 | `tool_use` Bash |
| 10:12:58 | 508.8 | 3.08 | 2 | 503.9 | `thinking`（零 delta） |
| 10:39:28 | 58.1 | 1.22 | 25 | 7.4 | `tool_use` Write |
| 10:40:16 | 36.2 | 1.26 | 17 | 33.4 | `tool_use` Write |
| 10:40:46 | 6.8 | 2.65 | 13 | 0.0 | `tool_use` SendMessage |
| 10:41:53 | 46.5 | 1.25 | 21 | 41.1 | `tool_use` Write |
| 10:51:07 | 25.4 | 3.04 | 2 | 17.2 | `thinking`（零 delta） |
| 11:26:27 | 8.0 | 5.17 | 2 | 3.0 | `thinking`（零 delta） |
| 11:39:37 | 8.4 | 1.01 | 11 | 3.8 | `tool_use` Bash |

两种形态：

- **7 条死在 `tool_use` 块内**（Write ×4、Bash ×2、SendMessage ×1）——上游正在吐 `input_json_delta` 时断掉。工具名分布偏向 `Write`（大 JSON 参数）。
- **3 条死在刚 `content_block_start` 了 `thinking` 块、一个 delta 都没有**的位置。这 3 条对用户而言零信息量，却同样永久关死了恢复门（因为门以「真实 block start 已上线」为准，见 §2）。

模型：9 × `claude-opus-5`，1 × `claude-sonnet-5`。端点全部 `anthropic-messages`，全部 `translated: false`（直连 Anthropic 腿，非翻译腿）。

## 4. 时间形态：上游先于我方 idle 超时自己关掉连接

`streamIdleTimeout = 600 s`（config.yaml 显式设的）。但末字节后静默最长的两条是 528.7 s 与 503.9 s —— **上游在我方 600 s idle 超时到点之前就关了流**，我方的 idle guard 根本没机会开火。这两条期间客户端一直在收 `ping`（keepalive），所以客户端侧不是超时断的。

其余 8 条静默 0.0 ～ 41.1 s，属于「上游写着写着就没了」。

## 5. 与既有裁决的关系（不是新发现，是新证据）

`docs/todo/deferred-backlog.md` 已有承重结论，本次数据与之完全吻合：

- **预防层已到顶**：HTTP/2 不提供半关闭流的**流级** keepalive，若掐断方是 GHC 对单条 stream 的应用层超时，我方**没有任何新的主动发帧杠杆**；预防到 h2 PING（`upstream_h2_ping: 15`）为止。
- **恢复层只有一个杠杆**：L2 缓冲重试 `protect_streaming_generation`，当前 `false`。开启后响应会缓冲到 `message_stop` 才提交，截断可透明重试。
- **但它默认 OFF 是有硬门的**（backlog「Anthropic 块级 buffered 首块后的 >300s keepalive carrier」条）：`tests/e2e-client/anthropic-coexist-cli.e2e.test.ts` 实测块级 anchor-coexist wire 会让真实 `claude` CLI **静默完成为空结果**；解除条件写死为「**块级默认翻转之前必须完成方案 A**」（`docs/spec/2026-07-27-inter-block-keepalive-carrier.md`）。

**结论：这不是一个可以顺手打开的开关，也不是本次分析能自行裁决的事。**

## 6. 本次分析新增的、既有记录里没有的信息

1. **零重试是 100 % 命中，且成因单一**：10/10 都因为「真实 `content_block_start` 已上线」而被 `hasEmittedRealClientContent` 关门，不是配置问题，不是分类错误。
2. **3/10 死在零 delta 的 `thinking` block start 上**。这些请求客户端实际收到的语义内容是**空的**，却按「已交付内容」处理。这是个值得问的问题——但 `session.ts:266-278` 的注释已经给出了理由（避免新 attempt 在同一 index 开第二个块），属**已有裁决的权衡范围内**，要改需要用户重裁，不是缺陷。
3. **`tool_use` 是主要发生地（7/10），`Write` 是主要工具（4/10）**。既有 backlog 记的实证样本（`req_1783704300404_484`）也是「静默后爆发部分 `tool_use` 即被截断」，本次 7 个样本把它从单例升为模式。
4. **上游会先于 600 s idle 超时自己关流**（528.7 s / 503.9 s 两例），说明 GHC 侧的 stream 超时上限在 ~500 s 量级，低于我方 idle guard。这对「idle 超时该设多少」是有用的标定点：把 `stream_idle` 调到 600 以上不会有任何收益，因为掐断方不是我们。

## 7. 复算命令

```bash
bun - <<'TS'
import { Database } from "bun:sqlite"
import { zstdDecompressSync, gunzipSync } from "node:zlib"
const db = new Database(`${process.env.HOME}/.local/share/copilot-api/history-v3.db`, { readonly: true })
const rows = db.query("SELECT operation_id, manifest_gz, summary_json FROM v3_operations").all()
const dec = (b0) => { const b = Buffer.from(b0); return (b[0] === 0x28 ? zstdDecompressSync(b) : b[0] === 0x1f ? gunzipSync(b) : b).toString("utf8") }
const tally = {}
for (const r of rows) {
  if ((r.summary_json ? JSON.parse(r.summary_json).state : "") === "completed") continue
  const found = new Set()
  for (const m of dec(r.manifest_gz).matchAll(/"(?:error|dispatchReason)"\s*:\s*"((?:[^"\\]|\\.){1,200})"/g)) found.add(m[1])
  for (const f of found) tally[f] = (tally[f] ?? 0) + 1
}
console.log("total ops:", rows.length); console.log(tally)
TS
```
