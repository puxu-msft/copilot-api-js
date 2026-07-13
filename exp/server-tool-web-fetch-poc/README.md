# PoC：server_tool 能否被 proxy 实现（以 web_fetch 为最小样本）

## 问题

config `anthropic.server_tool_strip` + `anthropic.server_tool_rewrite` 现在对原生 Anthropic
server tool 的处理是「**假装它不存在**」——strip 掉声明、事后 downgrade 回流块。本 PoC 问的是反面：
**这些 server tool 能不能被 proxy 真的实现出来**，让客户端用上？

结论先行：**能。而且项目里已经有活的存在性证明**——web_search 双跳
（`src/lib/anthropic/web-search/orchestrator.ts`）就是「proxy 实现一个 server tool」的完整范式。
本 PoC 用 **web_fetch** 证明这套范式**可推广到 web_search 之外**，且是其中最干净的一个。

## 两个 config 键实际管的范围（不是单一工具）+ 一个常驻第三机制

两个 config 键各管**请求侧**一个机制，**都按块/工具类型统一匹配**（不针对单一工具名）：

- `server_tool_strip` → `stripServerTools`（`src/lib/anthropic/message-tools.ts:354`，用 `isServerToolType`）——剥**请求 `tools[]`** 里的 server-tool 声明。
- `server_tool_rewrite` → `rewriteServerToolBlocks`（`sanitize/rewrite-server-tool-blocks.ts:123`，用 `isServerToolResultType`）——改写**请求消息历史**里回流的 server-tool 块。

`SERVER_TOOL_TYPE_PREFIXES`（`message-tools.ts:325`）声明了全集：`web_search_` / `web_fetch_` /
`code_execution_` / `text_editor_` / `computer_` / `bash_`。

⚠️ **还有一个不受这两个键管辖的第三机制**：`server-tool-filter`（`server-tool-filter.ts:isServerToolBlock`）
是**响应侧、无条件常驻**的过滤器——`src/lib/codec/anthropic/response-rewrite-adapters.ts:264-285`
明写 `appliesTo: ANTHROPIC` + 「Always active … unconditionally」，**无任何 config 门控**，把上游响应里的
`server_tool_use` + 任意 `*_tool_result` 块**一律吞掉**再转发给客户端。这个机制对下面「路线 (A)」的可行性至关重要（见后）。

## 关键分类：server-executed vs client-executed

不是所有「server tool」都需要 proxy 自建后端。判据是**谁执行**：

| 工具 | 类别 | proxy 是否要自建后端 | 现状 |
|---|---|---|---|
| `web_search_*` | server-executed | 要 | **已实现**（双跳，`web-search/`） |
| `web_fetch_*` | server-executed | 要，但极轻 | 本 PoC |
| `code_execution_*` | server-executed | 要，且重（沙箱） | 未做 |
| `memory_20250818` | **client-executed** | **不要**，透传即可 | `server_tool_memory`（已探针实测） |
| `text_editor_* / computer_* / bash_*` | **client-executed** | **不要**，透传即可 | 未特殊处理 |

client-executed 的判据来自姊妹探针 `exp/server-tool-memory-probe/` 的实测：memory 是
`type:"tool_use"` + `caller:{type:"direct"}`，上游只**驱动**、真正存取由最终 client（Claude Code）
执行，**永不产生 `server_tool_use`** → 本项目侧无需自建后端，正确姿势是**别 strip、透传**。

**⚠️ 别把 web_fetch 的路线 (A) 误当成「和 memory 一样透传即可」**：memory 能透传是因为它产**普通
`tool_use`**（过得了常驻响应过滤器）；而 web_fetch 若被上游原生执行，产出的是 **`server_tool_use` +
`web_fetch_tool_result`**——**恰好是响应过滤器无条件吞掉的那一类**。所以即便走路线 (A)，proxy 也必须像
web_search 那样**主动绕过响应过滤器 + 走专用 handler**（`src/routes/messages/web-search-handler.ts`
就是为此存在），不是零工作透传。详见后面「路线 (A)/(B)」与「若要生产化」。

→ 所以「需要 proxy 自建实现」的真·server tool 只有三个：**web_search（已做）/ web_fetch / code_execution**。

## 双跳范式：四步里只有 execute 因工具而异

web_search 双跳骨架（orchestrator.ts）：

1. **探针 hop**：把原生 server tool 降级成普通函数工具，非流式调主模型，让它决定是否/如何调用。
2. **execute**：proxy 用自己的后端跑真实工作。 ← **唯一因工具而异的部件**
3. **二跳**：把结果作为 tool_result 喂回，主模型二次生成最终文本。
4. **合成**：拼出规范 `server_tool_use → *_tool_result → text` 序列，靠 `server_tool_rewrite: downgrade` 处理回流。

对 web_search，execute 是「跑搜索后端」（`web-search/backends.ts`，SearXNG/Responses 等，~15KB）。
对 **web_fetch**，输入已是一个确定的 URL，execute 退化成 **一次 fetch + HTML→正文** —— 见本目录
`fetch-backend.ts`（零外部依赖，~150 行）。

**复用度的诚实边界**：detect（识别工具）与 first-hop（降级成函数工具、探针调主模型）这两块**骨架可原样复用**；
但 **synthesize 与 downgrade 的内容层是 web_search 硬编码，需要 web_fetch 专用变体**，不是「原样复用」：
- `web-search/synthesize.ts:88-116` 写死 `name:"web_search"` / `web_search_tool_result` /
  `server_tool_use:{web_search_requests:1}`；web_fetch 的结果块是另一种形状（`web_fetch_tool_result`
  携文档内容，非 title/url 搜索项）。
- `sanitize/rewrite-server-tool-blocks.ts:77-101` 的 `stringifyServerToolResultContent` 写死
  「Web search results / Web search failed」措辞、只解析 `{title,url}` 数组——web_fetch 结果走 downgrade
  会**结构成功但语义错标**（把网页文档渲染成「Web search results」）。**结构层适用、内容层需专用变体**。

## 本 PoC 的两个产物

### 1. `fetch-backend.ts` —— 唯一的新部件，已本地跑通（无凭据、无额度）

```
bun run exp/server-tool-web-fetch-poc/fetch-backend.ts https://example.com
```

实测输出（example.com，73ms）：`ok=true status=200`，正文抽出 `# Example Domain …`。
证明 web_fetch 的 execute 步骤确实 trivial —— 连搜索后端都不用配。生产化时把朴素 HTML→text
换成 `@mozilla/readability` 等成熟库即可（battle-tested-over-hand-rolled），骨架不变。

### 2. `probe.ts` —— 活探针：也许根本不用双跳

在自建双跳之前，先实测一个更省的可能：**上游 CAPI 是不是原生就接受并执行 `web_fetch_20250910`**？

```
bun run exp/server-tool-web-fetch-poc/probe.ts
# 可选：PROBE_MODEL=claude-opus-4.5  PROBE_ACCOUNT_TYPE=enterprise  PROBE_URL=https://...
```

⚠️ 会发一次真实上游请求、消耗一次 Copilot 额度。`no-auto-server` 语境下 **AI agent 不替你跑，由你手动执行**。

探针经生产管线（`createAnthropicMessages`）发出原生 web_fetch 声明，用 `onPrepared` 抓 wire
佐证声明确实到达上游（默认 `server_tool_strip: false` 且未学习拒绝时原样转发，已核实），
再从响应判定：

- **路线 (A)** 上游回 `server_tool_use{web_fetch}` / `web_fetch_tool_result` → **上游原生接受并执行**。
  但**注意**：这些块在生产响应路径会被常驻 `server-tool-filter` 无条件吞掉，客户端看不到——所以 (A) 仍需
  proxy **绕过响应过滤器 + 走专用 handler**（同 web_search-handler），**不是零工作透传**。省掉的只是「自建 fetch 后端」这一步。
- **路线 (B)** 上游 400 拒绝 → proxy **必须自建双跳**（同 web_search），此时 `fetch-backend.ts` 就是 execute 步骤。

⚠️ **探针观测 ≠ 生产客户端可见**：probe 用 `createAnthropicMessages`，它非流式分支直接返回原始上游 JSON
（`client.ts:175`，**不**过响应过滤器），所以 probe 看得到 web_fetch 块——但同一响应在生产 v4/codec 路径上会被
过滤器剥掉。probe 证明的是「上游接不接受/执不执行」，**不**证明「客户端能不能看到」（后者取决于上面的 handler 旁路）。

无论 (A) 还是 (B)，结论都是「web_fetch 可被 proxy 支持」，只是路径不同。探针的价值是**在写生产代码前**用一次真实请求把路径钉死。

## 验证状态

- `fetch-backend.ts`：✅ 本地真实 URL 跑通（无凭据/无额度）。
- `probe.ts` + `fetch-backend.ts`：✅ 对真实项目类型 `tsc --noEmit` 编译干净（`exp/` 不在根 tsconfig
  include 内，故用临时 tsconfig `extends` 后显式 typecheck；已用注入错误反证该 typecheck 确实覆盖 exp）。
- `probe.ts` 上游接受性：✅ **已实测（2026-07-12，individual 账户，`api.githubcopilot.com`）**——**结论：路线 (B)**。
  - wire 佐证原生声明原样到达上游：`wire.tools = [{"type":"web_fetch_20250910","name":"web_fetch","max_uses":5}]`（默认 `server_tool_strip:false` 不预剥，如分析）。
  - 模型 `claude-sonnet-4.5`→解析 `claude-sonnet-5`，beta `advanced-tool-use-2025-11-20`。
  - 上游 **HTTP 400**：`{"error":{"message":"rejected tool(s): web_fetch","code":"invalid_request_body"}}`。
  - → GHC/CAPI **不原生支持 web_fetch**，proxy 必须走**路线 (B)：自建双跳**（同 web_search），`fetch-backend.ts` 即 execute 步骤。
  - 旁注（已核实）：这个 400 body 形状（`rejected tool(s): web_fetch` / `invalid_request_body`）与 web_search 反应式自愈所匹配的
    `the use of the web search tool is not supported` **不同措辞**。`server-tool-rejection-retry.ts:52-53` 的
    `SERVER_TOOL_REJECTION_TABLE` **只有 web_search 一条 pattern**——故当前 web_fetch（及 code_execution 等）被上游 400 拒绝时
    **不会被反应式学习/预剥**，会**硬失败**（除非全局 `server_tool_strip:true` 一律剥）。换言之现有 strip/rewrite 自愈路径本身也是
    **web_search-centric**；推广其它 server tool 时须给该表补对应 pattern。

## 若要生产化（超出 PoC，供排期）

现在 web_search 是**硬编码的单工具旁路**，走 legacy `runAnthropicPipeline`、不进 v4 driver，带着一串
已文档化的边界债（L3 主动隔离不覆盖、tool-field 反应式学习缺失，见 `docs/todo/deferred-backlog.md`）。
认真推广到多工具时，长远正确的形状是抽一个 **server-tool provider registry**：按 `type` 注册
`{ detect, downgradeToFunctionTool, execute, synthesizeResultBlock }`，web_search 收编为一条、
web_fetch 作第二条——而不是再复制一份旁路。这与项目 `against-yagni` / 架构健康优先取向一致。

生产化必须处理的**承重项**（本 PoC 不含，供排期）：

1. **响应过滤器旁路 + 专用 handler**（最大的一处，也是把 web_fetch 从「换个 execute」变成「需要一整套
   web-search-handler 平行件」的真正原因）：合成的 `server_tool_use{web_fetch}` + `web_fetch_tool_result`
   必须像 web_search-handler 那样**主动绕过常驻 `server-tool-filter`** 才能让客户端看到；否则被无条件吞掉。
2. **synthesize / downgrade 的 web_fetch 专用变体**（见上「复用度的诚实边界」）：结果块形状 + downgrade 措辞都要新写。
3. **legacy 管线债**：同 web_search 的 L3 / tool-field 学习缺口。
4. **web_fetch 独有的 SSRF 面（安全知会）**：execute 会 `fetch` 一个**模型/客户端可控的任意 URL**
   （localhost/内网/云元数据端点均可达）——web_search 后端**不**抓任意 URL，web_fetch **会**。按项目
   internal-tool 安全取向这不阻塞任务，但生产 execute 应加目标校验（拒绝私网/元数据 IP）与说明。

以上属独立的设计任务（本 PoC 只证明可行性与 execute 的 triviality，不含生产化）。
