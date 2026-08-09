# Responses ↔ Anthropic Semantic Bridge 实施计划评审记录

> **状态**：首轮发现 1 BLOCKER、4 MAJOR，均已采纳整改，待原 reviewer 复审
>
> **评审对象**：`docs/plan/2026-08-06-responses-anthropic-semantic-bridge/`
>
> **首轮基线**：`0c6ad2d783a90c39044034cd427858527f925a64`

## 评审视角

| 视角 | 主责 |
|---|---|
| 协议与判据证伪 | AC1–AC24、量词、false-green／false-red、SDK／CLI／真 GHC oracle 真相域 |
| 实施者第一人称走查 | 文件／符号、producer→consumer顺序、DAG、过渡owner、命令与测试真相域 |

## 首轮结论

- 协议 verifier：1 BLOCKER、1 MAJOR；不可定稿。
- 架构 reviewer：首次长报告因 API `Server error mid-response` 中断；恢复同一 agent 后返回 0 BLOCKER、3 MAJOR。
- 两位 reviewer 的隔离 worktree 均无改动。

## B1. Claude Code WebSearch 外层 oracle 与“不伪造 result”冲突

- **级别**：BLOCKER。
- **处置**：采纳（C），待复审。
- **事实复核**：Claude Code 2.1.207 `Xky` 只从 `server_tool_use` 计数，只从 `web_search_tool_result` 提取 `{title,url}`；普通 text 只进入 commentary。证据：`~/.claude/refs/claude-code-2.1.207/app.pretty.js:281505-281525,281604-281631`。
- **失败场景**：计划禁止伪造 `web_search_tool_result`，却要求结构化 links／`search_results_received`；正确实现必红，伪造 result 才绿并违反 AC7。
- **整改**：同步更正规格 P0-3／AC5 与 P4 E2E。降级路径要求 `searchCount>0`、query-update、duration与commentary；`data.results`不得含结构化link entry，外层tool_result不得含伪造`Links:`，不要求`search_results_received`。若未来要links，须有真实result source或另行裁决client adapter。

## M1. `CompatibilityErrorRenderer` 没有 exact wire contract

- **级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：原规格接口只有`formatHttp/formatTerminal`，计划写“400/422”“502或规格status”，没有2协议×4阶段唯一矩阵。
- **失败场景**：实现者可选不同status／terminal taxonomy且各自宣称通过；正确实现可能被任意fixture误红。
- **整改**：规格删除error内第二份suggested status，冻结status函数、Anthropic/OpenAI HTTP body、Anthropic/Responses terminal frame和唯一调用链；renderer用targetFormat判别union，Responses terminal强制sequenceNumber；P1新增renderer contract＋8格unit，P3按exact矩阵接codec/route/driver。

## M2. Candidate response collector 与 renderer 创建顺序倒置

- **级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：当前driver先`createCandidateRenderer`，后`createSession`，见`src/lib/pipeline/driver.ts:539-546`。
- **失败场景**：renderer无collector可写，实施者会临场增加第二collector或request-global side channel。
- **整改**：P3 Task 3.2要求candidate runtime先创建单一collector，再将同一实例传renderer与session snapshot；更新`FormatCodec.createCandidateRenderer`签名与两个codec；mutation恢复旧顺序必须红。

## M3. Non-streaming response 缺 candidate-local disposition 路径

- **级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：`runResponseNonStreaming`当前直接调用codec renderer，绕过`CandidateResponseSession`，见`src/lib/pipeline/driver.ts:238-248`。
- **失败场景**：whole response records丢失或写入request-global槽，破坏winner／loser隔离。
- **整改**：P3 Task 3.3新增whole-response candidate调用链：解析generation binding、使用该candidate collector、freeze后winner投影；response-only helper用显式synthetic candidate-local collector。

## M4. S2 request collector 没有贯穿真实 outbound cells

- **级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：生产`translateRequestVia`在`anthropic-cell.ts:103-106`与`openai-responses-cell.ts:88-101`调用，原计划只列hub／driver。
- **失败场景**：fixture override能绿，P4生产request却无collector／freeze／RequestState持久化。
- **整改**：P3 Task 3.4列两个cell；driver在S2前创建request-scoped open collector，通过RequestState supply传cell／hub，S2 finally冻结并替换成稳定diagnostics，candidate永不接open collector。

## 待复审命题

1. B1更正后的WebSearch oracle是否同时符合真实Claude Code行为与AC7，不再误要求links。
2. Error renderer的2协议×4阶段status／body／terminal／owner是否唯一、无双源。
3. Candidate collector是否在renderer前创建且whole／stream共用candidate-local owner。
4. Request collector是否真实贯穿driver→两个outbound cells→hub，并在candidate前freeze。
5. 整改是否引入新BLOCKER／MAJOR；若只剩minor，明确写“计划可定稿”。
