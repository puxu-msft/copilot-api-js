# Responses ↔ Anthropic Semantic Bridge 实施计划评审记录

> **状态**：第二轮（复审）发现 3 MAJOR，均已核实并整改，待第三轮复评
>
> **评审对象**：`docs/plan/2026-08-06-responses-anthropic-semantic-bridge/`
>
> **首轮基线**：`0c6ad2d783a90c39044034cd427858527f925a64`
>
> **第二轮基线**：`90cccdb6`（代码基线 master `837fe522`）

## 评审视角

| 视角 | 主责 |
|---|---|
| 协议与判据证伪 | AC1–AC24、量词、false-green／false-red、SDK／CLI／真 GHC oracle 真相域 |
| 实施者第一人称走查 | 文件／符号、producer→consumer顺序、DAG、过渡owner、命令与测试真相域 |

## 首轮结论

> ⚠️ **本节及以下 B1／M1–M4 各条里的 `file:line` 是首轮（基线 `0c6ad2d7`／master `2c9b5d66`）的读数，现已全部漂移**——master 在 08-06→08-09 三天内前进 541 提交。这些行号**只作历史记录，不可据以定位**；当前位置见第二轮小节与计划正文的符号锚点（`outboundTranslateOut`／`createProcessor`／`runResponseNonStreaming`／两个 cell 的 `translateOut`）。各条的**实质结论仍成立**，漂的只是位置。

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

## 第二轮（复审，基线 `90cccdb6` / master `837fe522`）

两位 reviewer 均恢复原实例（`SendMessage`），逐条判定我提出的 5 条可验证命题。**两侧的 5 条命题全部判定成立**，但各自另发现新问题。两位的隔离 worktree 事后均确认干净。

### 结论

| 视角 | BLOCKER | MAJOR |
|---|---|---|
| 协议契约 | 0 | 1 |
| 管线接线 | 0 | 2 |

### MAJOR 1（协议）：`errorRenderer` 与 profile 的 `targetFormat` 无类型级绑定

`RequestBridgeProfile` / `ResponseBridgeProfile` 各自独立声明 `targetFormat` 与 `errorRenderer: CompatibilityErrorRenderer`，而后者是**自带判别键**的 union，不接收 profile 的 `targetFormat` 作参数——因此把 Responses renderer 挂到 `targetFormat:"anthropic-messages"` 的 profile 上**照样编译通过**。

**我方复核**：已亲自读 spec 两个 profile 接口，确认两字段确实互不约束，claim 成立。

**整改**：新增 `BridgeTargetFormat` 与条件类型 `CompatibilityErrorRendererFor<TF>`；两个 profile 增加 `TargetFormat` 类型参数，`targetFormat: TargetFormat` 且 `errorRenderer: CompatibilityErrorRendererFor<TargetFormat>`。同步更新 plan-2 runner 签名的类型参数列表（原为 8 参，现 9 参）与 spec 两处散文（§11 约束、第 14 条不变量）。

**并补上原先缺失的 mutation**：plan-1 Task 1.6 新增 Step 5b——negative type fixture 断言错配**编译失败**。这一格不可省：8 格运行时测试测的是各协议内部正确性，**覆盖不到装配错配**。这正是「判据之间留缝」的实例，不是某条判据写错。

### MAJOR 2（接线）：Task 3.1 自相矛盾，照步骤实现会被本 Task 自己的判据判红

Produces 要求「candidate fork 原样共享 records 值」，mutation 要求「每 candidate 复制 records 后红」，而实现步骤却写「实现 `snapshotStableState` clone+freeze」。

**我方复核**：读 `candidate-state.ts` 确认——该函数多数字段走 `cloneAndFreeze`（内部 `structuredClone`，每 candidate 得到**不同对象**），唯独 `sourceToolNameMapper` 带注释 “share by reference across candidates”、不 clone。claim 成立，且我原文确实指向了相反写法。

**整改**：步骤改为「按 `sourceToolNameMapper` 的形状追加按引用共享的 spread，freeze 只在 S2 finally 做一次」，断言明确为**引用相等 `toBe`**；并写明那条**危险歧路**——遇红时把断言放宽成深相等会永久落地 per-candidate 副本，使 mutation 从此不可实现，故只许改实现不许改断言。

### MAJOR 3（接线）：`outboundTranslateOut` 是「唯一分派实现」但有两个调用点

`runRequest`（受 try/finally 覆盖）与 `inspectRequest`（dry-run 探针，`stopAfter="translate"` 直接 return、**无 finally**）。原文「唯一分派点」的措辞会诱导实施者把 `resolveRequestTranslationRuntime` 塞进 `outboundTranslateOut` 内部，导致 inspect 路径也创建**永不 freeze、永不 publish** 的 open collector。

**我方复核**：读 `driver.ts` 确认两个调用点及 `inspectRequest` 无 finally、提前 return，且该路径由 dry-run 调试端点使用。claim 成立。

**整改**：Files 备注改为点名两个调用点及其生命周期归属差异；Step 3 明确禁止把 resolver 塞进 `outboundTranslateOut`；Step 5 改为「共路但不产生诊断」，写明 inspect 路径只解析、不 freeze、不 publish、不计 dispatch，并给出断言。

### 采纳的 minor

- **纠正我自己写错的理由**（重要，非措辞）：我原先称 open collector 进 `RequestState` 会「违反 request-lifecycle-stable 契约」。reviewer 指出这与代码不符——`RequestState` 本就收纳 `betaProbe`／`reverseMapperHolder`／`responsesFallbackScratch` 等共享**可变**句柄。真正的机械理由是 **fork 语义**：`validateOpaqueFactories` 要求进入 `RequestState` 的 opaque 可变句柄注册 per-candidate 工厂，于是会按 candidate 分裂，破坏 request-level 单份记录。结论不变，理由已在 spec 与 plan 两处替换。**留此记录是因为错误的理由比错误的结论更隐蔽**：结论正确会让人以为整段都对，而后来者会照着错理由去推别的结论。
- Task 3.2 改为**复用既有的 `CandidateState.responseState`** 槽（已存在但零生产消费者：`forkEnv` 只挂回 `requestState`、丢弃 `responseState`），避免实施者新造一套 supply，并顺手了结该死槽。
- 点明 `createCandidateRenderer` 共有**四个**实现（另有 gemini、openai-cc，不在本对内），第二参数可选故不破编译，但清单不得让人误以为只有两个。

### 未采纳

无。本轮 3 条 MAJOR 与 3 条 minor 全部采纳。
