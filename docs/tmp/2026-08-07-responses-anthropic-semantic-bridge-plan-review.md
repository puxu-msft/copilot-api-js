# Responses ↔ Anthropic Semantic Bridge 实施计划评审记录

> **状态**：第四轮复评——两侧各 1 MAJOR，均已实测复核并整改（提交见下）。整改后需第五轮。
>
> **评审对象**：`docs/plan/2026-08-06-responses-anthropic-semantic-bridge/`
>
> **首轮基线**：`0c6ad2d783a90c39044034cd427858527f925a64`
>
> **第二轮基线**：`90cccdb6`（代码基线 master `837fe522`）
>
> **第三轮基线**：`7c5ba2ed`（代码基线 master `837fe522`）
>
> **第四轮基线**：`62075b12`（管线侧）／`7c5ba2ed`（协议侧）

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
- ~~Task 3.2 改为**复用既有的 `CandidateState.responseState`** 槽~~ —— **⛔ 已被第三轮 MAJOR B 推翻，不要照此实施**：该路径必须穿过 `RequestEnvelope`，而 `with()` 的 patch 键集被刻意收窄且在四个 codec 里逐字段重建，漏一处即静默丢字段。现行做法是 collector 在 `createProcessor` 里按 candidate 创建、不走 envelope；死槽另记 `docs/todo/deferred-backlog.md`。详见第三轮小节。
- 点明 `createCandidateRenderer` 共有**四个**实现（另有 gemini、openai-cc，不在本对内），第二参数可选故不破编译，但清单不得让人误以为只有两个。

### 未采纳

无。本轮 3 条 MAJOR 与 3 条 minor 全部采纳。

## 第三轮（复评，基线 `7c5ba2ed`）

只评第二轮**新写**的内容。新写的内容没有历史校验，是最容易出错的一档——本轮结果印证了这一点：**管线接线视角判 `不可定稿`，2 MAJOR 全部落在我第二轮新写的三处改写上**。

### 管线接线视角

| 命题 | 判定 |
|---|---|
| 1. Task 3.1 改写后四方自洽 | **成立**（并补验了一条我没写的前提：`createDriverCoordinator` 晚于 S2，故 by-reference spread 拿得到已 freeze 的值，不会恒为 `undefined`） |
| 2. Task 3.4 的 inspect 断言咬得住 | **不成立 → MAJOR** |
| 3. Task 3.2 走 `responseState` 路径可行 | **不成立 → MAJOR** |

#### MAJOR A：Step 5 的断言恒绿，零判别力

我写的「跑完 `inspectRequest` 后 ctx 无 bridge diagnostics publish、dispatch 计数不变」**在正确与错误两种实现下都不可能红**：publish 只发生在 `runRequest` 的 try/finally 里，而 `inspectRequest` 根本没有那段；`stopAfter="translate"` 直接 return，物理 dispatch 在这条路径上任何情况下都到不了。它测的是「inspect 不 publish／不 dispatch」这个**结构上本来就成立**的事实，而非「resolver 有没有在 inspect 路径上被调用」这个目标机制。

**我方复核**：读 `driver.ts` 确认两处结构性事实，claim 成立。**这是我自己在派活时就点名「最没把握」的一条，reviewer 证实了担心**——说明「我不确定」的直觉值得写进派发件，它确实指向了真缺陷。

**整改**：断言换成直接观测目标机制（spy `CellAssembly`，断 `translateOut` 第二参数 `runtime === undefined`；或给 resolver 加调用计数断 inspect 路径为 0），并**明文写下那条恒绿写法及其为何恒绿**，防止后来者退回去。另外采纳 reviewer 的第二半：**该负控必须在 fixture `profileOverride` 生效的配置下跑**——production 集合为空时 resolver 两条路径都返回 `undefined`，换了断言照样恒绿。

#### MAJOR B：走 `responseState` 需穿过被刻意收窄的 `with()` 契约，且漏一处即静默丢字段

`RequestEnvelope` 无 `responseState` 字段，`with()` 的 patch 是四键 `Pick`（`envelope.ts:130`，紧邻注释说明为何窄），且 **`with()` 不是 `{...base, ...patch}`——四个 codec 各自 `makeEnvelope` 逐字段重建**。漏改一处，该格式路径上下一次 `with()`（S3、S4 都会调）就把字段静默抹掉：字段可选、无编译错误、renderer 于是自建 collector，**正是本 Task 要防的缺陷**；而 Task 3.2 用 mock codec，碰不到真实 `makeEnvelope`。

**我方复核**：读 `envelope.ts:130` 与 `anthropic/codec.ts:532-556` 确认逐字段重建，`rg makeEnvelope` 确认四处，claim 成立。

**整改**：采纳 reviewer 倾向的方案 ②——**不走 envelope**。collector 在 `createProcessor` 里按 candidate 创建（`candidate.ts` 保证每 candidate 只调一次）并直接传给 renderer 与 session，`forkEnv` 与 `with()` 契约一律不动。这也撤回了我第二轮采纳的「复用 `CandidateState.responseState`」——**上一轮的 minor 建议被这一轮推翻**，死槽改为记入 `docs/todo/deferred-backlog.md` 单独处置，不在本计划扩大范围。

### 采纳的 minor

- Task 3.1 Step 2 补「**深冻**（含 `records` 数组）」：`snapshotStableState` 用的是浅 `Object.freeze`，by-reference spread 也不冻 diagnostics 本身；若 S2 只做浅冻，`records.push` 照样成功，「不可 append」又变成一条恒绿判据——**与 MAJOR A 同型**，同一轮里出现两次，说明「断言恒绿」是我当前最高发的缺陷形态。
- Step 4 的 `stableState` 是 `candidate-state.ts` 的内部局部名，driver 上下文照抄会找不到标识符，改为 `env.requestState`。

### 未采纳

无。本轮 2 MAJOR + 2 minor 全部采纳。

### 本轮的方法论收获

**两条 MAJOR 与两条 minor 中有三条是同一形态：我写的断言在正确与错误实现下都不会红。** 判据自身的判别力，比判据覆盖了什么更容易出错，且**自审抓不到**——因为写断言时我脑子里只有「正确实现应该满足它」，从不检验「错误实现会不会也满足它」。可执行的防法：每写一条断言，当场问「把目标机制改坏，这条会红吗」，答不上来就现场构造那个坏实现。

## 第四轮（复评，基线 `62075b12` / 协议侧基线 `7c5ba2ed`）

两侧各 1 MAJOR，**均已实测复核并整改**。协议侧本轮用**真跑 tsc 的 PoC** 给结论，管线侧用「把断言真的写一遍」的第一人称走查，两者都不是读码推断——这是本轮结论比前几轮硬的原因。

### MAJOR C（协议）：条件类型在**宽实例化**容器下 false-green

`CompatibilityErrorRendererFor<TF>` 对**具体**实例化有判别力（错配 `TS2322`、正确装配不误红），但一旦 `TF` 被加宽为 `BridgeTargetFormat`——即 `satisfies Record<X, Profile<BridgeTargetFormat>>`——**同一份错配 exit 0、零报错**。

**我方复核**：不满足于采纳，自己写了最小 PoC 实跑 `tsc 5.9.3 --strict`，三格全部复现（宽容器 false-green、联合容器 `TS2322`、正确装配无红）。并确认 `hub-translate.ts:199,266` 现有 `satisfies Record<...>` 正是宽容器形状，**实施者照房内惯例写就会掉进去**。

**整改**：没有采纳 reviewer 建议的「禁止宽化容器」这条纪律式修法——它与仓内既有惯例对着干、且靠人记住。改为**结构性修法**：registry 值类型必须是「具体实例化的联合」（每个 `targetFormat` 字面量各一臂），该写法经实测既保住判别力又保住房内 `satisfies Record<...>` 惯例。Step 5b 相应从一格扩为**两格**（具体实例化 + 容器实例化）。

**明确标为未验证**：不冻结联合别名的确切写法——`RequestBridgeProfile` 另有 8 个类型参数，它们在联合臂里取何值尚未实测。规格锁**不变量**（两格负样本必须成立），不锁写法。PoC 与「它没有证明什么」一并留在 `exp/bridge-profile-renderer-binding/`。

### MAJOR D（接线）：第三轮换上的新断言**写不出来**，退而求其次的变体**又恒绿**

同一位置**连续第三轮**出恒绿判据，每次形态不同：

| 轮次 | 恒绿写法 | 为什么恒绿 |
|---|---|---|
| 三 | 「inspect 后 ctx 无 publish、dispatch 计数不变」 | publish 只在 `runRequest` 的 finally 里；`stopAfter="translate"` 使物理 dispatch 根本到不了 |
| 四 | 「spy `CellAssembly` 断第二参数 `undefined`」 | `DriverDeps` 无 cell 覆写槽，spy 无处注入 |
| 四 | 同上，退而用 mock codec | mock codec 无 `requestState` → `migratedCell` 返回 `null` → 落 legacy 分支，该分支永远只传一个实参 |

外加一条独立成立的：不提供 `bridgeProfileOverride` 就断 resolver 返回 `undefined`——production 集合为空时两条路径都返回 `undefined`，无差别。

**我方复核**：读 `driver.ts` 确认 `DriverDeps` 无 cell/assembly 覆写槽、`resolveCellAssembly` 是模块级静态、`migratedCell` 在 `!env.requestState` 时返回 `null`，三条机械原因全部属实。

**整改**：采纳 reviewer 的选项 ①（driver 层 DI，绕开 mock-codec 与 module mock）。Files 补两个 fixture-only 测试缝 `DriverDeps.resolveRequestTranslationRuntime?` 与 `DriverDeps.bridgeProfileOverride?`（仿既有 `decideRoute` 的 DI 形状）；断言改为**调用计数**：`runRequest`=1、`inspectRequest`=0，错误实现下 inspect 变 1 而红。并把**三条已知恒绿写法连同各自的机械原因**写进计划，防止后来者绕回去；另加一句硬要求：落地时先构造坏实现、亲眼看它红再提交。

### 采纳的 minor

- 深冻改为点名复用**已导出**的 `deepFreezeDiagnostic`（`diagnostics/snapshot.ts`）——`candidate-state.ts` 里那个 `deepFreeze` 未导出，照抄会造第三个轮子。已复核导出属实。
- 记下 `toThrow` 成立的依据（ESM／严格模式下冻结数组 `push` 抛 `TypeError`，非严格模式静默 no-op）——这是那条断言不恒绿的前提，值得写明。

### 本轮方法论收获（比上一轮更具体）

上一轮我总结的是「每写一条断言就问『把目标机制改坏会红吗』」。**这一轮证明那句话不够**——第三轮我正是这么问的、也自认为答了，结果还是恒绿，因为我**在脑子里回答**了这个问题。真正管用的判据只有一条：**把断言实际写出来，包括找到注入点**。三条恒绿里有两条不是"想不到会恒绿"，而是"根本没有注入缝"——这种缺陷只有在动手写测试时才会撞到，纯思考撞不到。

对应到计划文本的可执行要求：凡是写「注入 X 并断言 Y」的判据，**必须同时点名 X 的注入缝在哪个类型/参数上**；点不出来就说明这条判据当前写不出来，应当先补缝或明确降级为人工检查（并说明它不是自动门），不许留一条看起来是门、实际零判别力的断言。
