# exp/shutdown-keepalive-503 — 接管期客户端被钉在旧进程上

配套修复：commit `4a86e826`（fix）与 `1df8052b`（docs）。结论的权威载体是 [docs/lifecycle.md](../../docs/lifecycle.md)「优雅重启」节，本目录只保存**取得这些结论的可复跑手段**。

## 回答了什么问题

2026-08-09，一次 `--restart` 零停机接管开始于 13:02:06Z，而客户端到 13:09:24Z 仍在收 `503 Server is shutting down`——七分钟后、新实例早已在监听并服务。四个探针分别回答：

| 文件 | 问题 | 观测结果 |
|---|---|---|
| `query-history-gap.ts` | 事故窗口里 History 到底有没有记录？ | 13:01:57.734Z–13:11:46.755Z **零条**，前后请求密集 |
| `query-history-gap-bounds.ts` | 空洞是 drain 慢造成的吗？ | 不是。前任在途请求 13:02:22.581Z 就 drain 完了（约 16 秒），余下约 9 分钟是它**仍活着且仍在拒绝** |
| `probe-undici-pool-eviction.mjs` | undici（Claude Code 的 HTTP 栈）会因 `Connection: close` 弃用池中连接吗？ | 会。3 次请求 → **3 条新建连接**；对照组（不带头）复用，3 次请求 → 2 条连接 |
| `probe-bun-connection-close.ts` | Bun 会转发该头吗？会自己关 socket 吗？ | **转发，但不自己关**；两组 `serverClosedSocket=false`。所以驱逐是客户端做的 |

## 它没有证明什么

- **没有证明事故里客户端走的是哪条路径。** 证据不足以在「(A) 复用池中旧 socket」与「(B) 旧进程还没走到关 listener」之间判定——两者都能产生同样的观测。修复同时堵了两条，正是因为分不出来。
- **`probe-undici-pool-eviction.mjs` 用的是 `node:http` 服务端，不是本项目的 Bun 服务端**：它测的是**客户端**行为，不能拿来推断本项目服务端的任何性质。对照组的「3 次请求 → 2 条连接」也只说明存在复用，不是精确的池行为模型。
- **`probe-bun-connection-close.ts` 只覆盖了非流式 JSON 响应**，没有测 SSE、没有测 HTTP/2，也没有测 Bun 在真实关机（`server.stop`）期间的行为。
- **两个 History 查询读的是本机 `~/.local/share/copilot-api/history-v3.db` 的当时状态**，窗口与库路径都是硬编码的；它们证明「那段时间没有 operation 记录」，**不**证明「那段时间的请求都被 503 了」——被 503 的请求在建 `RequestContext` 之前就返回，本来就不会进 History。真正支持「确有请求且确实收到 503」的是客户端侧 transcript（13:05:42 / 13:06:00 / 13:09:24，至少四个 session），不在本目录内。
- 没有覆盖启动侧：同一次事故里新实例从启动到监听花了 803 秒（12:48:42 → 13:02:06），**成因未查明**，与本修复无关。

## 怎么复跑

```bash
bun run exp/shutdown-keepalive-503/probe-bun-connection-close.ts
node   exp/shutdown-keepalive-503/probe-undici-pool-eviction.mjs
bun run exp/shutdown-keepalive-503/query-history-gap.ts          # 只读打开真实 History 库
bun run exp/shutdown-keepalive-503/query-history-gap-bounds.ts
```

两个查询脚本硬编码了事故当天的时间窗口与本机库路径，换事故请改脚本顶部的常量。它们以 `readonly: true` 打开，不会写库——但仍是**真实的用户数据库**，改动前请确认这一点。
