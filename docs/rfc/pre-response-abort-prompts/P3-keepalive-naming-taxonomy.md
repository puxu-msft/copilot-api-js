# P3 — keepalive 配置命名一族重整

> 开场先读 [README.md](./README.md) 通用红线 + 必读，读 RFC **§4.2.3.1**。**前置**：并发 L2 会话的 `protect_streaming_*` 字段冻结（建议与 [P2](./P2-c3b-delayed-commit.md) 同期，避免二次改名）。重构 + compat 迁移。

## 背景 + 为什么

心跳/保活概念已变拥挤，实测有**三个**交叉 knob：
- `anthropic.stream_fake_sse_heartbeat`（`anthropicFakeSseHeartbeat`）—— mid-stream 客户端保活 ping 间隔。"**fake**" 不精确：注入的是**真正的 Anthropic 协议 `event: ping` 帧**，只是代理本地**合成（synthetic origin）**而非上游转发——"fake" 把"合成来源"误说成"不是真的"（注释其实已用准确词 "Synthetic SSE keepalive"）。准确轴 = **synthetic / keepalive**。
- `protectStreamingHeartbeat`（并发 L2 会话新增的 `protect_streaming_*`，`handler-v4.ts` 的 `forcedHeartbeatSec` fallback）—— buffered/protected-generation 路径的强制心跳。
- `pre_stream_grace`（P2 落地后）—— grace + commit 后 ping cadence（复用上面的 interval）。

用户 2026-06-22 指示：**不做"把 `fake` 单独改掉"的 piecemeal rename，而是一次性建立一套连贯的 keepalive 命名分类**（避免与 L2 各改各的 + 二次改名）。

## 目标

把三者整理成一族连贯命名（如统一前缀 `stream_keepalive_*` / 把 grace 与 ping cadence 语义分清），经 [compat.ts](../../../src/lib/config/compat.ts) 的 legacy→current 迁移层落地：
- compat.ts 已有声明式 migration builder（`renameLeaf` 等）+ graceful warn + user-set 新键优先。**零破坏用户配置**。
- 范围：touch `config.yaml`（注释 + 默认）、`config/schema.ts`、`config/config.ts`（`setAnthropicBehavior` apply）、`config/validation.ts`（跨字段校验若引用旧名）、`config/compat.ts`（迁移规则）、`state.ts`（运行时字段名若改）+ 所有消费点（`handler-v4.ts`/`web-search-*`/`client-sink` 调用处）。
- **登记 `config-hot-reload.it.test.ts` 矩阵**（改键名须更新矩阵，否则完整性守卫 fail）+ 加 compat 迁移测试（旧键→新键 + warn）。

## 验收

- [ ] 旧键经 compat 迁移到新键、warn 一次、user-set 新键优先；迁移测试绿。
- [ ] 全消费点改用新名，`grep -rn '<旧键名>' src/` 仅剩 compat.ts 的迁移规则。
- [ ] config-hot-reload 矩阵更新、`bun test tests/config` 绿。
- [ ] subagent 复审（裁判轴）。doc-sync：DESIGN 运行时选项表 + hot-reload 表改名、RFC §4.2.3.1 标 ✅。
- [ ] **不 piecemeal**：三个 knob 一族定清（grace=首 ping 延迟 / interval=后续 cadence 语义分明），不只改 `fake`。
