---
name: cc-client-source-reference
description: "Use when 需要以 Claude Code 官方打包源码（~/.claude/refs/claude-code-<ver>/app.pretty.js）为准，对照本项目面向 CC 下游客户端的代码（Anthropic /v1/messages 请求/响应/流式/工具/缓存/头/超时/keepalive/beta/usage）做 gap 审计、核对 CC 某行为、或新 CC 版本上线时同步。产出写 docs/todo/<topic>.md。区别于 ghc-api-reference（上游 GHC 侧的对称孪生）、debugging-claude-client-connection（症状排查）、client-proxy-e2e-testing（行为验证）。"
---

# CC 客户端源码对照参考：Claude Code 打包源码

## 这是什么、为什么重要

Claude Code CLI 的打包源码 `~/.claude/refs/claude-code-<ver>/app.pretty.js`（pretty 版，2.1.207 为 24MB / 46 万行）是 **CC 下游客户端行为的定义者**——它决定 CC 向本代理 `/v1/messages` 发什么（betas / metadata / tool_choice / defer_loading / thinking budget / image / system-reminder / `x-anthropic-billing-header`）、怎么消费我方（可能合成的）响应（SSE 解码、usage 累加、stop_reason 处理、thinking-signature / cache-beta / role:system 自愈重试、超时两层 watchdog）。

**本项目是它的对端**：我方转发/合成的 wire 是否被 CC 正确接受、我方的名单/检测/捕获是否跟得上 CC 版本，**以此源码为准**，不凭记忆或猜测。这是 `ghc-api-reference`（上游 GHC 侧）的**下游对称孪生**——上游侧有专门 skill，下游侧就是本 skill。

**活的事实库** = [docs/todo/cc-client-2.1.207-behavior-audit.md](../../../docs/todo/cc-client-2.1.207-behavior-audit.md)（F1–F32+ 累积 findings + 权威工具清单 + 优先级表 + 四条跨轮主线）。对照/续审先读它，别从零重刷已覆盖面。

## ⚠️ 「CC」词义冲突（起步必读，否则整条真实路径漏查/误判）

**本 skill 标题的「CC」= Claude Code（下游客户端）。但本项目代码里 `cc-` / `openai-cc` / `*-cc-*` 文件名的「cc」几乎全是 Chat Completions（OpenAI 协议）**，不是 Claude Code——`find src -iname "*cc*"` 命中的 20 个文件（`cc-to-anthropic-request.ts` / `anthropic-to-cc-request.ts` / `codec/openai-cc/` / `cc-family-strategies.ts` …）都是 Chat-Completions 翻译层。别被文件名骗（两个方向都会错：误当相关、或因没提示而漏查）。

**关键交集**：真实 Claude Code 客户端**并非只走** direct Anthropic 路径——当它把模型钉到非-Anthropic 后端（`@cc`/`@responses` 后缀，或无后缀自动路由到 gpt-* 等），会经**通用翻译矩阵的前向腿** `src/lib/openai/translate/{anthropic-to-cc-request,cc-to-anthropic,cc-to-anthropic-stream}.ts` 翻译成 OpenAI 协议上游（DESIGN.md:83「④ 前向腿…客户端仍 Claude Code、300s 断连」；`anthropic-to-cc-request.ts` 头注自证）。**这条腿虽文件名带「cc」（=Chat Completions），却是真实 CC 客户端的请求处理，属本 skill 覆盖面。** 审 CC 某请求字段时，除 direct 路径外**必查这条前向腿**（否则矩阵落地后字段处理已转移到这里，在旧目录里 grep 零命中 → 误判「无 gap」）。

## 源码导航（24MB 文件，别踩超时坑）

- **绝不整读**（会溢出上下文），也**绝不对全文跑回溯正则**（`grep -noE ".{0,50}foo\("` 之类在 24MB 上会 backtrack 数分钟超时——实测踩过）。
- 一律 `timeout 60 grep -nF "字面量"` 或 `timeout 90 grep -noE "简单模式"`；定位到行号后用 `sed -n 'A,Bp' | cut -c1-300` 读窄窗。
- 版本锚：源码里 `VERSION: "2.1.207"` / `GIT_SHA` / `BUILD_TIME`（grep `x-anthropic-billing-header` 那行也带 `cc_version`）。
- 找常量/工具名：`grep -noE '[A-Za-z0-9]+ *= *"ToolName"'`（如 `Hee = "WebSearch"`）比找字符串提及更权威（证「CC 内部有此工具」，但**不证**「每次都发进 tools 数组」——那要真实抓包，见 `client-proxy-e2e-testing`）。

## meta 模式：真实 gap 聚在三类（用它导航、提 ROI）

26 轮审计结晶：**核心 transform 正确性一律成熟无 gap**（thinking budget↔max_tokens / signature / cache_control 深度遍历 / header 转发 allowlist / model 解析 [1m]/别名/date / beta negotiation 通用剥离）——**别重复验这些**。真实 gap 高度聚集：

1. **名单陈旧 / Copilot-偏向**：`CLAUDE_CODE_OFFICIAL_TOOLS` / `API_DEFINED_TOOL_TYPE_PREFIXES` / `NON_DEFERRED_TOOL_NAMES` 等——CC 升级加了工具/类型，本项目名单没跟。
2. **richest-data-flow 捕获缺口**：CC 每请求自带的富信号（`metadata.user_id` 的 session/parent_session、`x-anthropic-billing-header` 的 cc_prev_req、usage 的 iterations/1h-cache/web_search_requests）被透传但没**捕获进结构化 history/telemetry**。
3. **新特性检测深度 / 对称性**：keepalive 块间空档回退裸 ping / vision 检测只扫顶层漏 tool_result 内嵌 image / 「开则加、关则不去」的非对称逻辑。

承重结构轴：**CC 的所有原生自愈（thinking-strip / cache-beta drop / role:system 回退 / refusal-fallback）都要求 HTTP-4xx**——任何错误在我方 post-commit 化成 200+SSE-error（`.status` undefined）会全灭 CC 自愈。

## empirical-verification 纪律（血泪，最容易栽）

**否定性 / 完备性结论不自证**——信一个 finding 或动代码前：
- **deep-read 引用的每处 `file:line`，读全定义、别在名单/函数中途停**。（实例：F30 全错，因只读到 `NON_DEFERRED_TOOL_NAMES` 第 82 行、漏了第 86 行 `...CLAUDE_CODE_OFFICIAL_TOOLS` spread。）
- **一个符号多消费点，grep 全消费面再下完备性断言**。（实例：F32 说「只 2 个消费点」，漏了第三个 `translateTools`。）
- **行为 claim 用独立探针实测**，别凭读码推断。（`bun test` 临时探针，验完即删；跨端点/客户端行为交 `client-proxy-e2e-testing`。）
- 可信度：亲手实测 > 文档推断 > 单方声称（executor/reviewer/文档/记忆都可能错）→ skill `empirical-verification` / `verifying-authoritative-claims`。

## 典型工作流

1. 选一个 CC-facing 面（超时/SSE/refusal/thinking/cache-beta/tool/image/usage/metadata…）；先读活的事实库确认是否已覆盖。
2. 源码定位 CC 2.1.207 的真实行为（`grep -nF` → `sed` 窄读），提取控制流/常量/字段。
3. 对照本项目对端代码找 gap（按 meta 三类）。**对端代码分两条路径**：① **direct Anthropic**（客户端不加后缀）——`src/lib/anthropic/`、`src/routes/messages/`、`src/lib/pipeline/`；② **翻译矩阵前向腿**（真实 CC 客户端钉非-Anthropic 模型，见上「词义冲突」节）——`src/lib/openai/translate/{anthropic-to-cc-request,cc-to-anthropic,cc-to-anthropic-stream}.ts`、`src/lib/codec/openai-cc/`。审某字段先 `grep -rn <字段> src/` 定位真实处理点在哪条路径，别只扫 direct 目录。
4. **不直接改**（除非用户要求实现）——findings 编号累积写 [docs/todo/cc-client-2.1.207-behavior-audit.md](../../../docs/todo/cc-client-2.1.207-behavior-audit.md)（或新 topic），每条标「读码结论 / 待实测」+ 严重度 + 触发条件 + 理想方向。
5. 需实测的项指向 `client-proxy-e2e-testing`（下游 mock oracle）；症状类排查转 `debugging-claude-client-connection`。

## 新 CC 版本上线（如 claude-code-2.2.x）

`ls ~/.claude/refs/claude-code-*`；新版打包源码到位后 diff 关注：betas 全表（`Q0("name","token")` 簇）、工具名常量、server-tool `type` 前缀、请求体新顶层字段、SSE accept-set、超时常量。名单类改动优先（meta 类别 1）。事实库顶部记版本锚。

## 交叉引用

- `ghc-api-reference` —— 上游 GHC 侧的对称孪生（读官方源码对照我方，方向相反）。
- `debugging-claude-client-connection` —— CC 连接/流式**症状**排查（本 skill 做 source 对照、那个查具体断流 incident）。
- `client-proxy-e2e-testing` —— findings 的行为**验证** oracle（真 SDK/claude CLI 消费我方 wire）。
- `empirical-verification` / `verifying-authoritative-claims` —— 不自证纪律的通用底座。
