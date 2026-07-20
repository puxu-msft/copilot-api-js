# CC 客户端「上游错误 → 重试/呈现」行为面 —— 可行性穷举

> ⚠️ **修正横幅（2026-07-13，实测 + 对抗评审后）**：本文件是**源码推断**初稿。事后有**运行时实测** [REPORT.md](REPORT.md) 与一轮**对抗性源码评审**，二者**独立收敛**，以下修正**权威、以此为准**：
> - **[窗口，实测+评审双证]** §2「inner-retry 窗口 = pre-content（仅 thinking 不算内容）」**错**。真实判据是 CC 的 `_r` 是否为空（`298412` 的 `ol` 分流）——**任何块完成第一个 `content_block_stop` 即关窗，一个已完成的 thinking 块就足够**。未完成的块（无 stop）仍在窗口内。实测：完成 thinking+overloaded→不重试（hits=1）、未完成 thinking+overloaded→重试（hits=3）。
> - **[连接层 ≠ body 层，评审补]** thinking-only 状态下二者行为**相反**：body 层 `overloaded_error` 帧→硬停（`298436`）；连接层 TCP reset / idle→**仍重发**（`298416` 的 `wn||jt` 腿）。原文二元 pre/post-content 模型把二者混为一桶，失真。
> - **[api_error，实测]** §2/§4「`api_error` pre-content → 降级非流式重发」**实测不成立**——`api_error` 任何位置都不触发客户端重试（headless `-p` + 默认 config 下）。
> - **[SDK 层，评审]** §1a 把 `@anthropic-ai/sdk` 传输层重试当 live lever（「≤2 次」）**错**。CC 全部客户端以 `maxRetries:0` 构造（`298096`/`297665`），**SDK 内层重试完全 dead**，只做「fetch 失败→`sP/vde`、非-2xx→带真实 status 的 `li`」分类抛错；所有 pre-commit 重试由 `lvo`/`x6_`（§1b）承担，默认 **10 次**（`l6_`）非 2。lever（status / `x-should-retry` 头）不变、只是消费层从 SDK 改为 `lvo`（`x6_` `370717`/`370729`）。
> - **[retry-after-ms，评审]** live 退避只读 `retry-after`（秒），**不读** `retry-after-ms`（后者仅在 dead 的 SDK `retryRequest` 读）。
> - **[计数,评审]** §1c「全 16 条」降为「≥13 条可辨认，完整清单以 `eOn`+onError 体为准」。
>
> **净蕴含（更强）**：post-commit 客户端重试窗口窄到「第一个 `content_block_stop` 之前」，真实流一旦完成任何块（含 thinking）即关 → **proxy 自身 buffered-retry 是 post-commit 唯一可靠出路**。

- **日期**：2026-07-13
- **性质**：逆向调研结论（非运行时实测；标注的不确定项需实测确认）
- **对象**：Claude Code CLI `2.1.207`，只读源码 `~/.claude/refs/claude-code-2.1.207/app.pretty.js`（461,543 行 prettified 混淆 bundle）
- **方法**：三个并行 subagent 分层穷举 SDK / inner-streaming / outer-`lvo` 三层，逐条 `file:line` 核；三方对「post-commit `event:error` 归属」独立交叉印证。
- **目的**：为「上游报错时把它整形成客户端会妥当处理的形态（可重试→触发客户端重试；不可重试→AskUserQuestion）」这一特性，先穷举 CC 客户端**实际**如何处理，划定代理可控 lever 的可行边界，再据此择优（择优结论写进 `docs/spec/`，本文件是其证据底座）。

> 术语：**commit** = 代理向客户端发出 HTTP `200` 响应头并开始 SSE 流。**pre-commit** = 200 头尚未发出（代理仍可返回任意 HTTP status）。**post-commit** = 200 已发、流已开始，之后只能靠 SSE 帧。**pre-content / post-content** = post-commit 内，是否已经吐过**真实内容块**（`text` / `tool_use`；`thinking` 不算真实内容）。

---

## 0. 最重要的结构性事实：CC 有两套互不相交的错误机制

任务最初的直觉「post-commit 流内 `event:error` → `status=undefined` 的 `li` → 逐条过 `x6_` 可重试判定」**不成立**。三个 agent 独立核对源码后一致确认：

| 机制 | 覆盖阶段 | 谁抛 | 捕获点 | 可重试判定 |
|---|---|---|---|---|
| **A. pre-commit**（`lvo` + `x6_`） | 响应头到达之前的失败（真实非-2xx status、连接错误） | `messages.create({stream:true}).withResponse()` 的 `.catch`（`298116`）把带**真实 status** 的 `li` 抛给 `lvo` | `lvo` 内 `catch`（`370499`）→ `onError` hook → `x6_`/`eOe`/fallback | **全套 `x6_`**（status / `x-should-retry` 头 / `Van` / 408/409/…） |
| **B. post-commit**（独立 mid-stream catch） | 200 头已发、流进行中的失败 | SDK SSE 解码器遇 `event:error` `throw new li(status=**void 0**, body, void 0, headers, body.error.type)`（`10019-10021`）；或真实断流/idle | 流在 `lvo` **外面**被 `for await`（`298199`）消费，异常被 `298389` 的 `catch(Ct)` 接住 | **不调 `x6_`**，改用 `eOe`/`dLs`/`.type==="api_error"` + 独立流式重试计数器 `zr`/`jr`/`dr` |

**推论**：`x-should-retry` 头、具体 HTTP status、`retry-after` 头、`Van`、408/409 等——**只在 pre-commit（机制 A）生效**。一旦代理 commit 到 200，这些 lever 全部失效，post-commit 只剩极少数 wire 手段（见 §3）。这条推论是整份取舍的地基。

`li` 形状（`9216-9240` 核实）：post-commit 的 `li` 是 `status=undefined`、`.error=body`、`.type=body.error?.type`、`.message=JSON.stringify(body)`（`makeMessage` 在 status/message 均缺省时回退到整包 body 序列化 `9221-9226`——故 `.message` 含 `"type":"..."` 子串，但也含 body 全部噪声）。

---

## 1. Pre-commit（机制 A）：代理返回真实非-200 status 时的全部腿

代理**尚未 commit 到 200**，返回什么 status + `error.type` + `.message` 子串就精确决定 CC 行为。默认 `maxRetries=10`（`pLs()`→`l6_`，`370752`；watchdog 下 300；`CLAUDE_CODE_MAX_RETRIES` 夹到 15）。

### 1a. SDK 传输层（`@anthropic-ai/sdk`，`makeRequest` 内，200 前）

| 触发（`file:line`） | 行为 | 代理 lever |
|---|---|---|
| fetch reject 且有剩余 attempt（`12344-12348`） | **无条件网络重试**（不看错误类型） | 断连/reset/TLS 失败/挂起超时 |
| `x-should-retry: "true"`（`12388`） | **强制重试**（覆盖任意 status，含 4xx） | 响应头 |
| `x-should-retry: "false"`（`12389`） | **强制不重试**（覆盖 429/5xx） | 响应头（**误设会一票否决重试**） |
| `408`/`409`/`429`/`≥500`（`12390-12393`） | 重试（默认 ≤2 次 SDK 层，指数退避） | HTTP status |
| 其余 status（`400/402/403/404/407/413/422`）（`12394`） | **不重试** → 抛结构化 `APIError` 交上层 | HTTP status |
| 退避时长 | `retry-after-ms`（ms）> `retry-after`（秒/HTTP-date）> 指数退避（`12397-12416`） | `retry-after[-ms]` 头 |

> SDK 层 `.type` 由 `body.error.type` 全控但**不据此重试**（仅 status + 头决定）。`.message` 想干净可控，须给错误体加**顶层** `message` 字段，否则含整包 body JSON。

### 1b. 应用层 `lvo`（在 SDK 之上，`370469-370600`）

| 触发（`file:line`） | 行为 | 代理 lever | bounded |
|---|---|---|---|
| `x6_(b)` 命中真实 status（408/409/429/5xx/`x-should-retry:true`）（`370549`/`370703`） | **重发整轮**（计入 `y`，退避后 continue） | status / `x-should-retry:true` 头（代理非 OAuth 场景 `Bo()`=false，门开）| `y>maxRetries`(默认10) 耗尽→停 |
| `lMp`(404 `not_found_error`+`model:`)/`cMp`(403 `permission_error`+`model:`)/`dLs`(5xx≠529) + 有 fallbackModel（`370508`） | **换 fallback 模型** | 真 status + `error.type` + `model:` 子串 | 一次性 |
| `eOe`(529/overloaded 子串) + 背景查询 `!uLs`（`370531`） | **优雅放弃**（不重试） | overloaded / 529 | 背景查询直接 drop |
| `eOe` + (有 fallback 或非首方 opus/fable)（`370533`） | 连续计数 `s`；`s≥svo(3)`→换模型 / repeated_529 放弃 | overloaded / 529 | **svo=3 硬上限** |
| `hMp`(400 context-overflow，精确文案 `input length and \`max_tokens\` exceed context limit: N + M > L`)（`370558`） | **自动调小 max_tokens 后重发** | 真 400 + 该文案 | 计入 maxRetries；可用空间<3000 抛 |
| `onError` hook 返回 `"retry:..."`（`370503`） | **重发但不计 attempt**（`y--`） | 见 1c（多为 400 文案） | 每唯一 key 去重一次，天然 bounded |
| 都不中且非 `x6_`（`370549-370555`） | **抛 non-retryable 停下**（`o4`）；有 fallback 且 status≠undefined→ last-resort 换模型 | — | 终止 |

### 1c. `onError` request-mutating retries（初始 POST 错误，`298121-298174`）——**代理可故意命中让 CC 自我修复**

这些腿要求初始 POST 返回**真实 status（多为 400）+ 特定 message 子串**。CC 会**剥掉/改写请求的某部分后重发**。全 16 条（`eOn` `69744`、`d7n` `169867`、各谓词 `170027-170088`）：

| retry-key | 触发子串（400） | 请求变异 |
|---|---|---|
| `retry:afk-beta` | afk beta 头相关 | 丢 afk auto-mode beta 头 |
| `retry:dispatch-header-strip` | ≥500 或连接错 + 曾带 dispatch 头 | 剥 `anthropic-dispatch-id` |
| `retry:advisor-strip` | `Advisor tool result content could not be processed` | 剥 advisor 内容 |
| `retry:foundry-capability-strip:<caps>` | `… not supported in your workspace` + `tool_search`/`structured_outputs` | 剥对应能力字段 |
| `retry:media-strip:<kind>:<m>.<c>` | 图片/文档/PDF 处理错（精确坐标） | 精确删该媒体块 |
| `retry:media-strip-latest:<kind>` | 同上无坐标，≤3 次 | 删最近 carrier 媒体块 |
| `retry:cache-diagnosis-beta` / `retry:prompt-caching-evict-beta` | 对应 beta 头 400 | 丢该 beta 头 |
| `retry:thinking-type` | `thinking.type … (enabled\|adaptive) … not supported` | 切换 thinking.type |
| `retry:thinking-signature-strip` | `signature in thinking block` / `thinking … cannot be modified` | 剥所有 thinking 块 |
| `retry:mid-conv-system` | `Unexpected role` / role system 相关 | role:system→`<system-reminder>` |
| `retry:context-hint` | prompt-too-long/400/409/529 hint | 清 context-hint 注入块 |
| `retry:fallback-credit-strip` / `retry:server-fallback-strip` / …(unattributed 变体) | `fallback_credit_token` / `server-side-fallback` / `Extra inputs are not permitted`+fallbacks | 剥对应参数/头 |

> 价值：其中若干（thinking-signature-strip、media-strip、mid-conv-system）与本项目已有的 sanitize/repair 管线**语义重叠**——代理遇到上游因这些原因报的 400，可以选择**透传该 400 让 CC 自己剥**，而非自己吞掉。属正交增强项，非本特性主线。

---

## 2. Post-commit（机制 B）：200 已发之后，代理中途发 `event:error` 帧

**代理唯一可控 lever = `body.error.type`**（`.message` 子串随之联动）。行为**取决于是否已吐真实内容**（`298389` 起的 catch 树）。

| 代理发的 `error.type` | 已吐真实内容（post-content） | 未吐真实内容（pre-content：仅 thinking/空） |
|---|---|---|
| `overloaded_error` | **B3 partial-finalize**：注入一行 `API Error: Server error mid-response. The response above may be incomplete.` text，**不重试** ❌ | **B8 inner-retry**：重发整个流式请求（`298457-298466`），前提**前台查询**（`uLs` 白名单）+ `zr<svo(3)`；耗尽→B9 模型 fallback ✅ |
| `api_error` | **B3 partial-finalize**：同注入「Server error mid-response」text，**不重试** ❌ | **B11 降级非流式重发**：以 non-streaming 重发整轮（`298472+`→ 第二个 `lvo`）✅ |
| 其它 type（`invalid_request_error`/`rate_limit_error`/`authentication_error`/自定义） | **B4 hard-stop**：已吐内容 + 末尾终端错误行，**不重试** ❌ | **B11 降级非流式重发** ✅ |

正交（非 `event:error` 帧的收尾方式）：

| 代理收尾方式 | post-content | pre-content |
|---|---|---|
| 中途真 **TCP reset**（ECONNRESET 等） | B3 注入 `Connection closed mid-response` text ❌ | **B6 inner-retry**（stale-connection，≤maxRetries）✅ |
| **停发字节** > idle 超时 | B3 注入 `Response stalled mid-stream` text ❌ | **B7 inner-retry**（watchdog，≤1）✅ |
| **干净 EOF**（无 message_stop 无 error 帧） | 静默当「完整但截断」接受，`stop_reason` 停留 null（无错误无重试）⚠️ | 抛 `Stream ended without receiving any events` → B11 降级非流式 |

**post-commit 主结论**：
1. **post-content 阶段客户端侧不存在干净的整轮重试**——最好也只是 partial-finalize（把错误变成一行 text 注记，正是要避免的「拼普通 text」行为）或 hard-stop。**要在 post-content 得到干净重试，只能靠代理自己的 buffered-retry（缓冲重放，proxy 内部）。**
2. **pre-content 阶段**有真客户端重试：`overloaded_error`→重发流式（前台，≤3）；`api_error`/其它→降级非流式重发。
3. `overloaded_error` 是 post-commit 让 CC **重发流式**的唯一 body-可控 lever，但受「前台查询 + pre-content + svo=3」三重约束。

---

## 3. 不可重试错误的「呈现」手段穷举（正交于重试）

若错误不可重试，代理能把它整形成哪些客户端形态。基线是 CC 自己的终端渲染器 `b7n`/`Ohg`（`170093-170219`）——它对已知错误给出分类化用户消息（`error` ∈ `server_error`/`invalid_request`/`rate_limit`/`billing_error`/`authentication_failed`），且对多种 400 形态带恢复提示（如 tool_use 并发→`Run /rewind`、invalid model→plan 提示、413→压缩提示）。

| 手段 | 机制 | 适用 | 代价 / 约束 |
|---|---|---|---|
| **让 CC 渲染终端错误**（现状，透传 canonical error 帧/status） | pre-commit 抛结构化 APIError；post-commit `event:error` 非 overloaded/api_error → hard-stop | 全模式（含 headless） | 硬停、turn 结束；但 CC 对已知形态给的提示其实不差；不污染历史 |
| **合成 AskUserQuestion tool_use**（成功轮次） | 合成 `tool_use{name:"AskUserQuestion"}` + `stop_reason:tool_use` | **仅交互式 TTY**（headless/`-p`/子 agent 无用户可问，会挂起） | 交互友好、可给可读说明+选项；但 tool_result 会 baked 进历史下一轮回灌上游 |
| **合成干净 end_turn text 块**（refusal-recovery 现有风格） | 追加 text 块 + `stop_reason:end_turn` | 全模式 | 软着陆不停；但代理注入的文本会 baked 进历史（richest-data-flow 须打 synthetic 标记） |
| **透传 400 命中 CC 的 request-mutating retry**（§1c） | pre-commit 保留上游 400 的特定 message 子串 | pre-commit | 让 CC 自我修复（剥坏块/切参数）而非代理吞掉——仅对语义匹配的 400 |

`AskUserQuestion` schema（`147667`；随请求默认下发、属并发安全工具集 `Q9_` `378861`）：`{questions:[{question, header, multiSelect, options:[{label, description, preview?}]}]}`，CC 总会额外加「Other/Skip」。

---

## 4. 代理可控 lever 总表（跨阶段）

| Lever | pre-commit | post-commit pre-content | post-commit post-content |
|---|---|---|---|
| HTTP status（408/409/429/5xx→重试；4xx→不重试） | ✅ 可靠 | ❌ status 已丢（undefined） | ❌ |
| `x-should-retry: true/false` 头 | ✅ 可靠（`Bo()`=false 门开）；`true` 强制重试、`false` 强制不重试 | ❌ 不被读 | ❌ |
| `retry-after[-ms]` 头 | ✅ 控退避 | ⚠️ mid-stream 用固定退避、不读 | ❌ |
| `body.error.type = "overloaded_error"` | ✅（eOe/x6_） | ✅ **重发流式**（前台，≤3）| ❌ 变 partial-text 注记 |
| `body.error.type = "api_error"` | （5xx 才重试） | ✅ **降级非流式重发** | ❌ 变 partial-text 注记 |
| 其它 `error.type` | 结构化 APIError | ⚠️ 降级非流式 | ❌ hard-stop |
| 真断 TCP / idle 停顿 | （连接层重试） | ✅ inner-retry | ❌ 变 partial-text 注记 |
| 合成 AskUserQuestion tool_use | ✅（成功轮次，仅交互式） | ✅ | ✅（但需在 stop 前追加） |
| 透传 400 命中 request-mutating retry | ✅（§1c） | — | — |

**bounded 性**：所有让 CC 重发的路径都有硬上限，代理无法用 wire 手段构造无限重发——maxRetries 默认 10（watchdog 300、`CLAUDE_CODE_MAX_RETRIES` 夹 15）、连续 529 `svo=3`、各 auth 腿 2 次、退避非 watchdog 单次>60s 直接抛。

---

## 5. 对本特性的取舍蕴含（择优输入，最终结论落 spec）

1. **retryable 的正确形状是「按阶段分治」，非单一 relabel**：
   - **pre-commit**：用真实 status（或 `x-should-retry:true` 头）让 CC 原生重试——**最可靠**，应尽量把可重试错误在 commit 前判定并如此返回。
   - **post-commit pre-content**：`overloaded_error` 帧可让 CC 重发流式（前台、≤3）；`api_error` 让 CC 降级非流式。是次优但可用的窗口。
   - **post-commit post-content**：**客户端侧无干净重试**。此处唯一能给用户「不中断」体验的是**代理自己的 buffered-retry（缓冲重放）**——印证了早先「proxy 先内部重试」的决策，且说明「推给客户端」在 post-content 根本不可兑现，不能作为 post-content 的兜底。
2. **要避免的 partial-text 注入**（`API Error: … mid-response`）恰恰是 post-content 发 `overloaded_error`/`api_error` 的**默认后果**——所以 post-content 千万别用这两个 type 去「试图触发重试」，那不但不重试还正好落进要避免的行为。
3. **AskUserQuestion 只在交互式有效**，与早先「config 门控默认关」决策一致；不可作为 headless 的默认。
4. **新发现的正交增强**：§1c 的 request-mutating retry——代理对语义匹配的上游 400 可选择透传让 CC 自愈（thinking-signature / media / mid-conv-system 等）。列为 backlog，非主线。

---

## 6. 待实测确认项（可信度：实测 > 本文档源码推断）

以下结论依赖 mock 上游 + 真实 CC 客户端跑一遍（`upstream-hook-mocking` skill + `pty-terminal-ui-testing` 或真 CC）才能定论，**在依赖它们之前不应写死**：

1. **`uLs` 前台白名单成员**（`y6_`，`370450`）：主前台请求的 `querySource` 是否在内——决定 post-commit `overloaded_error` 重发对**主请求**是否真生效（探针：mock 上游发 overloaded 帧 pre-content，看 History 是否出现重发条目）。
2. **实际 maxRetries**：SDK 默认 2、`lvo` 默认 10，但 CC 各调用点可能覆盖（agent 标注 `81622`/`42429` 有覆盖点）——真实重发次数需按调用点核。
3. **B1 401-token-refresh 腿**（`12386`）在 CC OAuth 流程下是否稳定触发。
4. **干净 EOF post-content 静默截断**（`stop_reason:null`）下游消费是否真无异常。
5. `overloaded_error` 帧 `.message` 子串命中 `eOe` 依赖 `JSON.stringify` 无空格产出 `"type":"overloaded_error"`——标准形状满足，非标准嵌套顺序不满足。

---

## 附：源码坐标索引（`app.pretty.js`）

- SDK：`makeRequest` `12335`、`shouldRetry` `12384`、`retryRequest` `12396`、`li`/`makeMessage`/`generate` `9216-9240`、SSE 解码 `event:error` `10019-10021`
- inner streaming loop：`e: for` `298068`、流消费 `298199`、mid-stream catch `298389`、partial-finalize 文本 `298433`、non-streaming fallback `298472`、`onError` `298121`、`eOn` `69744`、`d7n` `169867`
- outer `lvo`：`370469-370600`、`x6_` `370703`、`eOe` `370642`、`dLs` `370656`、`hMp` `370625`、`Bo` `92262`、`pLs`/maxRetries `370740`
- 终端呈现：`b7n`/`Ohg` `170093-170219`、`l7n` `169781`
- app 层分类：`S7n` `170238`、`v7n` `170295`、`MDg`/`$Dg` `202823-202844`
- AskUserQuestion：`147667`、并发安全工具集 `378861`
