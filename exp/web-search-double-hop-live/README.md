# Live 探针：web_search 双跳端到端实测（gpt-5.5 作搜索后端）

## 这是什么

一个 live 探针，补上 web_search 双跳（`src/lib/anthropic/web-search/orchestrator.ts`）**从未真实端到端跑通**
的缺口——此前只有 mock 上游的集成测试（`tests/anthropic/web-search/`，48 pass），
`docs/spec/request-lineage-v2.md:189` 实测确认「当前无真实 web_search 流量」。

用 **gpt-5.5 作搜索后端**（config `server_tool_web_search.backend: gpt-5.5`，走 Copilot `/responses`
的 `web_search_preview`，免起本地 SearXNG），真跑一次完整双跳。

## 怎么跑

```bash
bun run exp/web-search-double-hop-live/probe.ts
# 可选：PROBE_MODEL=claude-opus-4.5  PROBE_BACKEND=gpt-5.5  PROBE_ACCOUNT_TYPE=enterprise
#       PROBE_PROMPT="..."（要能强制联网搜索的 prompt）
```

⚠️ 发约 3 次真实上游请求（hop1 主模型 + gpt-5.5 搜索 + hop2 主模型），消耗真实 Copilot 额度。

## 实测结论（2026-07-13，individual，claude-sonnet-4.5→sonnet-5，backend gpt-5.5）

**✅ web_search 双跳前向编排 · 真实跑通。**

- hop1（claude-sonnet-5）决定搜索，query `"Bun runtime official website"`。
- gpt-5.5 搜索后端（真 Copilot `/responses`）返真实结果：`Bun — A fast all-in-one JavaScript runtime — https://bun.com/`（8546 input / 72 output tokens，真 gpt-5.5 用量）。
- hop2 + 合成产出规范序列 `server_tool_use{web_search} → web_search_tool_result → text`，终答 `The official Bun runtime website is **https://bun.com/**`。
- `usage.server_tool_use.web_search_requests: 1`，块类型序列 `["server_tool_use","web_search_tool_result","text"]`。

## 验到了什么 / 没验什么（诚实边界）

**验到（前向 / A 侧）**：
- hop1 真实主模型**真的**发起 web_search tool_use（非直接作答）。
- gpt-5.5 搜索后端**真返回**可解析结果（title/url）。
- hop2 + 合成**产出**规范 `server_tool_use → web_search_tool_result → text` 序列。

**未验（仍是 mock-only / 未测）**：
- **B 侧 child echo**（客户端下轮回传合成的 `server_tool_use{web_search}` → `server_tool_rewrite: downgrade` 处理）——本探针**单轮**，没测多轮回流。`request-lineage-v2.md:189` 关于 B 侧的论断仍成立。
- **流式路径 + HTTP route 层**——本探针直调 `orchestrateWebSearch`（非流式），没走 `web-search-handler` 的 SSE 合成 + 过滤器旁路。
- **thinking 块 echo 稳定性**（`synthesize.ts` 的 signature_delta 重建）——本次 hop2 未产 thinking，未触及。
- **encrypted_content:"" 的多轮兜底降级**（`sanitize/empty-encrypted-search-result.ts`）——需 B 侧回流才触发。

即：**前向双跳从 mock-only 升到 live-verified；B 侧回流 / 流式 / route 层仍待验。**

## 与 web_fetch PoC 的关系

`exp/server-tool-web-fetch-poc/` 实测 GHC 不原生支持 web_fetch（400），推广 web_fetch 需照抄 web_search 双跳。
本探针把「被照抄的参考实现」的前向路径从 mock-only 升到 live-verified，降低了照抄它的风险——但 B 侧 / 流式仍是
照抄前应补验的部分（见 `docs/todo/deferred-backlog.md` 的 server_tool provider registry 条目 caveat）。
