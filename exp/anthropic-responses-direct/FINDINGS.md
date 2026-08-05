# Phase 0 探针实测结论 —— anthropic↔responses 直接桥 round-trip 物理前提

实测时间：2026-07-14｜方式：隔离测试服务器 **4157**（真 GHC auth、独立 history.db `/tmp/copilot-test-4157`、跑当前 worktree master 4f6e77b8）｜4141 主服务器全程未动、实测后复核 healthy。
用途：为 [RFC 2026-07-14 anthropic↔responses 直接桥](../../docs/rfc/2026-07-14-anthropic-responses-direct-bridge.md) §4/§5/§7.2 的 round-trip 物理可行性提供实测裁决（`empirical-verification`：实测 > 推断）。证据文件同目录 `probe-a-history.json` / `probe-c-websearch.json` / `probe-a-client.sse`。

模型：原始 Phase 0 探针使用 `gpt-5.5`（responses-native，路由确认 `{requested:"gpt-5.5", resolved:"gpt-5.5", outboundEndpoint:"/responses", translated:true}`）。2026-08-05 后续探针使用 commit `7dc82aaf` 的隔离服务器 45173 + `gpt-5.6-sol`，用于校准 `web_search_call` 的不完整变体；4141 主服务器全程未动。

---

## 探针 (a)：前向 reasoning round-trip —— **物理可行，用 `done` 权威版**

**问题**：GHC Responses reasoning item 的 `encrypted_content` 在 `output_item.added` vs `.done` 是否不同（GPT 审查 MAJOR）？回喂上游是否接受续接（RFC §7.2 P0-a）？

**实测裁决**：

| 观测 | 结果 |
|---|---|
| `added` vs `done` reasoning `encrypted_content` | **不同 blob + 不同 id**（added enc_len **1600** id `oh9qJ6Dq…`；done/completed enc_len **1684** id `kDP29WIY…`）→ **GPT MAJOR 属实** |
| 现有 CC 桥捕获点 | `responses-to-cc-stream.ts:66` 只在 `output_item.added` 捕获（=捕的是 **1600 中间态**，非 1684 权威版）→ **既有前向 round-trip 潜在隐患坐实** |
| 回喂 `done` 版（1684）续接 | **HTTP 200 接受** |
| 回喂 `added` 版（1600）续接 | **HTTP 200 接受** |
| 回喂 **空** `encrypted_content` 续接（对照） | **HTTP 200 接受**（！） |

**关键结论**：
1. **round-trip 物理可行**——Responses reasoning 回喂**无 400 墙**。
2. **意外发现（精化 RFC §1.2 分水岭）**：Responses reasoning 端点对 `encrypted_content` **宽松**（空/中间态/权威版全 200），根本**不是** 400 gate。退役 web_search 的 `encrypted-content-400` 墙是 **Anthropic `/v1/messages` 的 `search_result` 块**——不同端点+不同 item 类型。**真伪密文分水岭对 Responses reasoning 路径不成立**（它不 gate）。
3. **保真取向（非上游强制、是正确性）**：虽三版都 200，续接保真应回喂 **`done`/completed 权威版（1684）**——它是 reasoning 定稿快照，`added`（1600）是中间态。→ **直接桥 Phase 5 必须捕 `output_item.done`/completed 的 encrypted_content，修正现有 CC 桥的 added 捕获**。

**对 RFC 的影响**：§4.1 步骤 2 捕获时机 → 明确取 `done`；§7.2 P0-a → 已坐实可行。§1.2 分水岭表述收窄：reasoning round-trip 可行**不是因为过了 400 gate，而是因为 Responses reasoning 端点根本不 gate encrypted_content**。

---

## 探针 (c)：server-tool 透传 —— **responses↔responses 原生 round-trip 可行；anthropic-facing 渲染仍须降级**

**问题**：`/responses` 是否接受 `web_search` 并返结果（RFC §5 请求侧透传）？web_search 结果能否 round-trip（GPT BLOCKER：结果无真密文）？

**实测裁决**：

| 观测 | 结果 |
|---|---|
| `/responses` + `tools:[{type:"web_search"}]` | **HTTP 200**，输出 items = `[reasoning, web_search_call, message]`（gpt-5.5 先 reason 再搜） |
| `web_search_call` item 字段 | 原始 gpt-5.5 完成项 keys = `action, id, status, type` —— **确无 `encrypted_content` 字段**（**GPT BLOCKER 核心断言属实**）；`id` 是大加密 blob |
| `web_search_call` 不完整变体（2026-08-05，gpt-5.6-sol） | 同一 HTTP 200 响应先返回带 `action.{query,queries}` 的 `status:"completed"` 项，再返回**无 `action`** 的 `status:"incomplete"` 项；Anthropic-facing renderer 必须把后者诚实降级为 unknown-query 文本，不能无条件解引用 `action` |
| re-inject `web_search_call` 回 round-2（responses→responses） | **HTTP 200 接受**（opaque `id` 作载体、无需 encrypted_content） |

**关键结论（精化 GPT BLOCKER）**：
1. **请求侧透传可行**（RFC §5.1）——`/responses` 原生执行 web_search、返 `web_search_call`。
2. **responses↔responses passthrough**：web_search_call **原生 round-trip 无碍**（`id` 作 opaque 载体，re-inject 200，**无需转换、无 encrypted_content 问题**）。
3. **anthropic-facing 渲染须降级（GPT BLOCKER 对此方向成立）**：把 `web_search_call` 渲染给 **anthropic 客户端**须转成 Anthropic `web_search_tool_result` 块——那**需要非空 `encrypted_content`**（`exp/encrypted-content-400` 的 Anthropic 侧 400 墙），而 web_search_call **没有** → 只能合成 → 撞退役双跳墙。→ **RFC §5 对 anthropic-facing 的「结果回显永远降级」成立**，但须**精化**：
   - `(openai-responses 客户端, responses 模型)` = passthrough，web_search 原生 round-trip（无本 RFC 直接桥问题）。
   - `(anthropic 客户端, responses 模型)` = 本 RFC 前向直接桥，web_search 结果渲染 anthropic 须**降级为 tool_use/text**（无真密文可搬）。

**对 RFC 的影响**：§5 降级结论对 anthropic-facing 成立且须精化措辞；R-NO-REVIVE 精确到「anthropic-facing 渲染不合成 web_search_tool_result」。2026-08-05 的补充探针还校准了消费契约：`action` 是可选字段，缺失时保留 `status` 并显示 `(unknown query)`。

**补充探针没有证明什么**：它没有证明每个 `status:"incomplete"` 的调用都缺 `action`，也没有穷举未来可能新增的 action 类型；它只以真实 GHC 响应证明“缺 `action`”是消费者必须接受的输入形状。

---

## 探针 (b)：反向（openai-responses 客户端 → Claude 模型 @messages）—— **路由可行，reasoning 呈现须靠新桥**

**问题**：反向路由是否工作？Claude thinking 能否 round-trip 给 responses 客户端（RFC §4.2 / §7.2 P0-b）？

**实测裁决**：

| 观测 | 结果 |
|---|---|
| `/responses` + `model:"claude-opus-4.8@messages"` | **HTTP 200**，输出 = `[message]`（**无 reasoning item**） |

**关键结论**：
1. **反向路由工作**（responses 客户端 → Claude 上游 @messages → 响应翻回 responses 200）。
2. **当前 CC-via 反向路径丢 Claude thinking**（只 `message`、无 reasoning item）——正是本 RFC 反向直接桥要修的有损点。
3. **反向 round-trip 的两半（须 Phase 4/5 桥就位才能端到端验，本探针未直接测）**：
   - responses **客户端侧**接受合成 reasoning item：探针 (a) 已证 Responses reasoning 端点宽松（接受任意 encrypted_content 含空），**推定** responses 客户端回传外来 reasoning item 可行（待桥就位端到端复验）。
   - Claude **上游侧**接受回喂 thinking：受既有 **thinking-signature quarantine**（skill `ghc-anthropic-upstream`「cannot be modified」400）约束——反向转发的是**真 Claude signature**，只要**不被篡改**即应被接受（R-DIRECTION-ASYMMETRY：真 signature 转发路径，非哨兵合成）。

**对 RFC 的影响**：§4.2 反向须新建 primitive 成立；§7.2 P0-b 反向端到端探针**留 Phase 4/5 桥就位后复验**（当前无桥无法端到端测反向 round-trip，但两半的物理前提分别有旁证：responses 侧宽松 + Claude 侧真签名不篡改即接受）。

---

## Phase 5/6 设计参数（本探针落定，供 gated 阶段敲定）

- **Phase 5 前向 reasoning**：捕 **`output_item.done`/completed 的 encrypted_content**（非现有 CC 桥的 added），回喂上游续接（无 400 风险）。
- **Phase 5 反向 reasoning**：新建「真 Claude signature ↔ responses reasoning item」primitive；端到端 round-trip 待桥就位复验；Claude 上游侧靠真签名不篡改过 quarantine。
- **Phase 6 server-tool**：请求侧 anthropic web_search → Responses 裸 builtin `{type:"web_search"}` 透传可行；anthropic-facing 结果渲染**降级 tool_use/text**（web_search_call 无 encrypted_content、合成撞 Anthropic 400 墙）。

## 4141 保护
测试服务器起在 **4157**、独立 history.db，实测后按 PID 精确清理；4141 主服务器全程未 kill、复核 healthy。

---

## 探针 (d)：GHC Anthropic 腿是否接受相邻同角色 turn（Phase 4 MAJOR-2 定级，2026-07-15）

**问题**：反向请求腿把 mid-conversation system item 折成独立 user turn → 产生相邻同角色（user, user）。真 Anthropic API 要求严格交替，reviewer 标 MAJOR-2「可能 400」待验。

**实测（隔离服务器 4159、真 GHC、claude-haiku-4.5）**：

| 组 | messages | 结果 |
|---|---|---|
| CONTROL | user→assistant→user（严格交替） | HTTP 200 |
| TEST | user→**user**→assistant→user（相邻同角色） | **HTTP 200 ACCEPTED** |

**裁决**：GHC 的 Anthropic `/v1/messages` 腿**接受相邻同角色 turn**（不强制严格交替）。→ **MAJOR-2 降级为语义差异、非 wire 回归**：mid-conversation system 折成独立 user turn 是 **wire-safe** 的，且**保留了 item 位置**（旧两跳折进 top-level system 会丢位置）。按 richest-data-flow + 位置保全，当前行为反而更优，**无需修复**。（同族 [W2 探针](#) 证 GHC 接受任意 tool_use.id、此处证接受相邻同角色，GHC 上游对 Anthropic wire 约束比真 Anthropic API 宽松。）
