---
name: client-proxy-e2e-testing
description: 当需要在 copilot-api-js 里验证「真实客户端（@anthropic-ai/sdk 库 或 claude CLI）拿到代理转发的 wire 后**怎么反应**」而非只断言我方转发字节时使用——client↔proxy 端到端、上游 GHC 全程 mock。触发场景：想证 SDK 是否接受/拼装/throws APIError/静默丢 eventless 帧、想证 Claude Code agent-loop 是否 stall（轮变空→num_turns>1→「继续」循环，byte-golden 证不了的 agent 行为）、给某个「客户端到底会不会 X」的问题一个确定性可复现的自动化 oracle、离线不烧额度不靠人肉跑 claude。即使用户只说「测客户端行为」「e2e」「claude 会不会卡住」也用本 skill。区别于 upstream-hook-mocking（那个 mock 上游一段、本 skill 讲客户端侧当 oracle）与 debugging-claude-client-connection（那个查连接/流式症状、本 skill 搭可复现 e2e 骨架）。
---

# client↔proxy e2e 测试（上游屏蔽、真实客户端当 oracle）

golden/http 测试断言的是**代理转发的字节**；本骨架断言**真实客户端拿到那些字节后的可观测行为**——SDK 是否拼出连贯 message、是否 throws、是否静默丢帧；CLI agent-loop 是否 stall。字节对 ≠ 客户端接受。落地在 `tests/e2e-client/`，权威实证结论见 `exp/cli-e2e-stall/FINDINGS.md`。

## 两层 oracle（按能测什么选）

| 层 | 客户端 | 屏蔽机制 | 能测 | 文件 |
|---|---|---|---|---|
| **Tier 1 SDK** | 真实 `@anthropic-ai/sdk`（openai/@google/genai 同理） | **同进程** `Bun.serve(app.fetch, {port:0})` + `setUpstreamFetchForTests` | wire 契约：`.finalMessage()` 拼装、`throws APIError`、丢 eventless 帧 | `anthropic-sdk.it.test.ts`、`harness/{serve-in-process,upstream-script}.ts` |
| **Tier 2 CLI** | 真实 `claude -p` | **spawn 真 proxy**（非 4141）+ config hook mock 上游 | agent-loop 行为（stall/重发/渲染），SDK 复现不了 | `anthropic-cli.e2e.test.ts`（gated）、`harness/{spawn-proxy,drive-claude-cli,cli-refusal-hook}.ts` |

Tier 1 offline 确定性（`.it.test.ts` 进 `test:backend`）；Tier 2 需真 auth+网络+claude，gated（`.e2e.test.ts` 排除出 offline 全集，skip 除非 `claude` 在 PATH + 真 github_token）。

## 承重机制（都是实测踩过的，照抄别重推）

### 上游屏蔽：从 primitive 推理，别从流行 wrapper 泛化
**只用 `setUpstreamFetchForTests(handler)`**（`src/lib/transport/upstream-fetch.ts`，替换上游专用 `activeUpstreamFetch`、**只被 `upstreamFetch()` 调用、不碰 `globalThis.fetch`**）→ 真实 SDK 的 `globalThis.fetch` 天然打到 localhost proxy，两条路自动隔离、无需 host-scoping。**绝不用 golden 惯用的 `applyFetchMock`/`setFetchMock`**（装 `globalThis.fetch = mock` 会误伤真实 SDK 的请求→自锁）。教训：同一能力有干净 primitive + 耦合全局的便利 wrapper 并存时，从 primitive 实现判风险，别从主流用法泛化（我据 golden 的 applyFetchMock 把隔离风险搞反了方向）。→ 记忆 `methodology-reason-from-primitive-not-dominant-wrapper`。

### CLI 让 claude 认自定义端点
必须 **`ANTHROPIC_AUTH_TOKEN`（非 `ANTHROPIC_API_KEY`——订阅 OAuth 会覆盖 API_KEY、直连真 Anthropic）+ `ANTHROPIC_BASE_URL` + 隔离 HOME**（`.claude.json` 含 `hasCompletedOnboarding:true`、`.claude/settings.json` 写 env），对齐 `src/setup-claude-code.ts` `buildEssentialEnv`。隔离 HOME 既防订阅覆盖、又不污染用户真实 `~/.claude`。stall oracle = `claude -p --output-format json` 的 `{num_turns, result}`：**stall = `num_turns>1 && result===""`**（agent 空转一轮），对照非空 recovery → `num_turns===1`。

### spawn 真 proxy 的两个坑
- **boot 需真 auth+网络**：`bun run ./src/main.ts start --port <非4141>`（**带 `start` 子命令**，`bun run start` 的 npm 脚本无子命令会把端口当未知命令），隔离 `XDG_DATA_HOME`（→ 自有 config.yaml + history.db），把真 github_token 复制进隔离 APP_DIR（boot 做 github→copilot 交换 + model fetch）。token 真实路径用 `homedir()` 基（`~/.local/share/copilot-api/github_token`），**非** 被测试沙箱重定向的 `XDG_DATA_HOME`。
- **清理：`proc.kill()` 不够**——`bun run` + volta 的 bun shim 把 server 包进父子进程树，`proc.kill()` 只杀 launcher、真 server leftover（每跑漏一个）。用**端口精确** `pkill -9 -f "main.ts start --port <唯一高位端口>"`（只匹配自己、绝不碰 4141/peer），spawn 前也先清同端口 leftover。→ `protect-user-main-server`：按端口精确清自己的、绝不泛杀。

### upstream hook 文件的 data-URL 具名导出丢失
config-hook（Tier 2 mock 上游）经 `Bun.Transpiler`+`data:` URL 加载（`hooks/loader.ts`）。**触发 = 源码里 `JSON.stringify` 或字面 `{`/`}`/`"` payload**（比 skill `upstream-hook-mocking` 记的「yield 内联对象字面量」更细，bisect 出来的）→ `import()` 返回 `{__esModule,default}`、具名 `onExchange` 静默变 undefined（`exports none of: onExchange`）。**规避**：帧 `data` 存 **base64**（源码无 JSON 括号引号）、`atob()` 运行时解码；帧存 `[event, base64]` 字符串**元组**数组（非对象字面量数组）；hook **零 import**（`~/` 别名在 data-URL 模块不解析，用 raw 逃生口手构 `{frames, headers}`）。→ 记忆 `reference-cli-e2e-spawn-and-hook-load-gotchas`。config 声明 hook 后须 `POST /api/hooks/reload` 才真加载（`applyConfigToState` 不触发加载）。

## oracle 纪律（否则 harness 假绿）
- **客户端可观测为准**，非我方字节：成功路径 `.finalMessage()` **深等值**（含 `tool_use.input` 深等、`thinking.signature` 保真——这些跑完整 SSEDecoder+累积+JSON.parse，超字节层）；错误路径 **`throws APIError`**（二元不可伪造）；重试用 upstream handler **调用次数**（`new Anthropic({maxRetries:0})`）；agent stall 用 `num_turns/result`。
- **否定断言必配正样本对照**：证「SDK 丢帧/空转」前先证正常帧下拼装/不空，证 harness 真驱动了客户端、断言触达目标（`verifying-authoritative-claims`）。
- **实测坐实非凭文档**：SDK 遇 200+流内 `event:error` 是否同步 throw、eventless 帧到底怎么丢——实跑定，别臆断。
- **状态卫生**：`setStateForTests`（camelCase state 键如 `refusalSseRewrite`，非 YAML 键）MERGE 不 reset，每场景 `beforeEach` 复位 + `useIsolatedRuntime`，场景串行。

## 实证结论（本项目已坐实，直接引用）
- `setUpstreamFetchForTests` 零隔离风险（探针证 SDK 真打 localhost + upstream 恰调 N 次）。
- SDK 0.106.0 流式/非流式**都不补 `citations`** 字段。
- proxy **原样转发 eventless 帧**；SDK 确丢弃，但 eventless content_block_**START** 会被后续 event-ful delta 遮蔽（delta 宽容重开块）→ 要丢**内容 delta** 才可观测。
- refusal `error` 模式 + 200+流内 error → SDK **同步 throws APIError**、`maxRetries:0` 下上游恰调 1 次。
- **空串 refusal recovery（thinking-only end_turn）让 Claude Code STALL**（`num_turns=2, result=""`，上游被调 2 次）；非空 recovery 文本防住（`num_turns=1`）——实证了 refusal-recovery 特性的存在价值。→ `docs/refusal-recovery.md` 空串节。

## 扩展新场景/新 vendor
骨架 vendor 无关（已证：OpenAI SDK vendor smoke 与 Anthropic 共用核心）：`upstream-script`（脚本化上游 SSE，`createSseResponse`/`jsonResponse`/`httpErrorResponse`/`sequencedUpstream`——最后一个逐腿不同响应、驱动 proxy 内部 reactive retry）+ `spawn-proxy` 的 baseURL 契约 Tier1/Tier2 共用。加 OpenAI/Gemini SDK 场景改客户端库 + 上游帧构造即可，核心不重构。加新上游形状：Tier1 喂 `setUpstreamFetchForTests`，Tier2 改 `cli-refusal-hook.ts` 的 base64 帧元组（注意上面 data-URL 坑）。**待覆盖场景 backlog**（按承重排序、多数 `[DOC-REAL]`）见 spec `docs/spec/2026-07-13-client-proxy-sdk-e2e-harness.md`「e2e 场景覆盖 roadmap」节——挖自 docs/skills/memories 的客户端可观测行为考古，含 keepalive 300s 墙 / thinking 毒化恢复 / 其余 reactive retry 腿 / 翻译矩阵反向腿 / 三类中止区分等。**新绿测试务必变异验证有牙**（关掉被测行为→测试应变红、且只红对应那条）。
