# `tool_search` 注入的成本收益量化 —— 裁决：**保留，不退役**

日期：2026-07-27
起因：[2026-07-26-server-tool-provenance-routing.md](../../docs/spec/2026-07-26-server-tool-provenance-routing.md) §7 的待裁决项。用户要求「不得无限期搁置」，且在评审出 3 个 CRITICAL 后决定**先做本裁决再决定 spec 要不要重写**——因为若退役，spec 的大部分工作就是在给一个即将消失的机制精心设计支撑结构。

## 裁决

**保留 `tool_search` 注入。收益压倒性，不构成退役理由。**

| 轴 | 实测值 |
|---|---|
| **收益**：defer_loading 省下的 prompt token | **16,157 tok/轮（62.7%）** |
| **成本**：实际触发 tool_search 往返的轮次 | **1/120 = 0.83%** |
| 注入覆盖率 | 120/120 带 tools 的 claude 轮次 |

## 证据

### 1. 收益 —— A/B 实测（`ab-toolsearch.py`）

两台隔离测试服务器，**唯一差异**是 `anthropic.tool_search`；同一 payload（24 个真实客户端 tools + 一条短 user 消息）；oracle 是**上游自己报的 usage**（不是我方字节计数）：

| | tools 发送 | deferred | `input_tokens` | `cache_creation` | `cache_read` | 计费 prompt |
|---|---|---|---|---|---|---|
| A：`tool_search: true`（默认） | 29 | 12 | 9,597 | 0 | 0 | **9,597** |
| B：`tool_search: false` | 28 | 0 | 25,754 | 0 | 0 | **25,754** |

`cache_read = cache_creation = 0` 两侧皆然 → **无缓存干扰**，是干净对比。**差额 16,157 token/轮。**

这同时坐实了承重假设：**deferred 工具的 schema 确实不进 prompt**（此前只是推断）。

### 2. 成本 —— 离线扫描 120 轮真实流量（`quantify-toolsearch.py`）

```
with_tools:                120
tool_search_injected:      120     ← 带 tools 的 claude 轮次 100% 注入
has_deferred:              120
tool_search_ACTUALLY_used:   1     ← 模型真正调用它的轮次
deferred schema chars/turn: median=61,093（占 tools payload 68.7%）
```

即：**每轮都收割节省，只有 0.83% 的轮次付出一次 tool_search 往返**。

### 3. 粗估与实测的吻合

离线按 `chars/3.5` 粗估 ~17,455 tok，实测 16,157 tok —— 偏差 8%。**粗估方法可复用**于后续同类评估，但裁决仍以 usage oracle 为准。

## 踩坑（复跑必读）

- **配置键名是 `anthropic.tool_search`，不是 `tool_search_enabled`**。写错时 schema 会**静默 strip** 该键、服务器照常启动、health 照常绿，A/B 静默退化成 A/A 假实验。本次靠「启动日志 grep 未知键告警 + 断言 B 侧 `deferred=0/tool_search_declared=0`」抓住。**任何 config-driven 的 A/B，都必须在结果里断言配置真的生效了**，别只看进程起来了。
- 两侧 `cache_read` 必须都是 0 才可比；若非 0 说明撞了 prompt cache，差额失真。

## 对上游 spec 的影响

裁决为「保留」→ [2026-07-26-server-tool-provenance-routing.md](../../docs/spec/2026-07-26-server-tool-provenance-routing.md) 的工作**仍然必要**，需按评审的 3 个 CRITICAL 重写（收窄到 `clientFormat === "anthropic"`，GPT/Gemini 的 server-tool 语义归 Phase 6 另立 spec）。

同时，评审暴露的这条**现存缺陷**因本裁决而升级为必修（不再有「等 tool_search 退役就自动消失」的退路）：

> [rewrite-server-tool-blocks.ts:70-94](../../src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts#L70) 的 `stringifyServerToolResultContent` 是 web-search 专用的：`tool_search_tool_search_result` 的 content 是非数组 object，会命中 error 分支渲染成 **`"Web search failed: unknown"` + `isError: true`** —— 谎报失败、丢光真实工具引用。请求侧 downgrade 模式一旦对某模型被 learned 开启即触发。
