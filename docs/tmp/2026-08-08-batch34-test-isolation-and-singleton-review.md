# Batch 3／4 instruction-text 独立评审

## 结论

- **评审范围**：`.claude/skills/test-isolation/SKILL.md`、`.claude/skills/debugging-test-pollution/SKILL.md`、`.claude/skills/owned-singleton-lifecycle/{SKILL.md,verification-log.md}`、`.claude/skills/persistence-async-invariants/SKILL.md`，并对照相关生产代码、测试、相邻 skill 与 memory。
- **已读取／执行的证据**：全文读取上述 instruction text、`docs/memory/reference-config-yaml-overwrites-setstatefortests-per-request.md`、`src/lib/config/config.ts`、四条 vendor handler／codec／system-prompt 接线、History registry 与测试、`tests/helpers/isolated-fixture.ts`、`process-lifecycle-shutdown`；用 CodeGraph 与 `rg` 全仓枚举调用和暂停钩子；执行 `bun test tests/config/history-persistence-queue-config.unit.test.ts tests/history/worker/registry.unit.test.ts`，结果为 **9 pass／0 fail**。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。
- **计数**：0 blocker／5 major。

## C1～C10 核验摘要

| 断言 | 结论与证据 |
|---|---|
| C1 | **部分证伪**。直接调用位置成立：chat `handler-v4.ts:179`、messages `:669`、server `:139`、config route `:159`；但 Responses 与 Gemini 的完整请求路径会在 codec `translateInbound` 间接调用，见 `src/lib/codec/openai-responses/codec.ts:326` → `src/lib/system-prompt/inbound.ts:39` → `override.ts:198-199,80-82`，以及 `src/lib/codec/gemini/codec.ts:241` → `override.ts:132-134`。另有 Responses WS `src/routes/responses/ws.ts:291`。 |
| C2 | **收窄后成立**。`applyConfigToState()` 对“effective config 中存在”的键逐项 `!== undefined` 写 state，缺席键保留 live state；请求级 policy 的注释与接线表明 reload 在冻结前。但 effective config = synthetic／bundled + user merge，不等同于“用户 config.yaml 显式键”。 |
| C3 | **成立**。生产定义仍在 `src/lib/config/config.ts:636-643`；三组活例的 `207/212`、`58/69`、`62/79` 均准确。 |
| C4 | **成立**。`mergeBySchema()` 在 user 缺席时保留 bundled（`src/lib/config/config.ts:535-578`），而 `applyConfigToState()` 仅对 `!== undefined` 字段写回；所以 effective config 中缺席与显式默认值确有不同语义。 |
| C5 | **基本成立**。新增段只给指针，没有复制修法正文；“单跑不变、顺序不敏感”只能作排除跨文件污染的启发式，最终仍须按 key + 实际调用路径核验。 |
| C6 | **语义成立、行号失效**。当前实现在 `src/lib/history/worker/registry.ts:58-68`：setter 纯赋值；reset 捕获 current、await shutdown、compare-and-clear。 |
| C7 | **判据可执行**。纯值侧例子是 `src/lib/config/config.ts:203` 的 parsed config cache；资源侧例子是 `src/lib/history/worker/registry.ts:28` 的 Worker runtime。丢引用后前者不运行／占句柄，后者仍持有 Worker transport。 |
| C8 | **成立**。四个相邻 skill 均存在；`test-isolation:22` 明定新 module-global singleton 登记 `RESETTERS`；`process-lifecycle-shutdown:56-77` 的 ingress seal／保留在途能力与 stop-producer／drain 类比成立。 |
| C9 | **成立**。各 `name` 与目录一致；`owned-singleton-lifecycle` description 是触发条件、症状和负边界，没有摘要执行流程，正文不冲突。 |
| C10 | **成立**。全仓未找到 shutdown 暂停期间安装 replacement 并断言幸存的等价测试；`tests/history/worker/registry.unit.test.ts:41-61` 只暂停 shutdown、断言旧值等待期间仍在及完成后清空。`deliverySessionTestHooks` 钩住 delivery commit，不是 singleton reset replacement。 |

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/test-isolation/SKILL.md:36-47` — 路径表把“route-level 不直接调用”写成“该路径不热加载”，会错误放过 Responses／Gemini 测试。  
证据：Responses 有条件经 codec → `processResponsesInstructions` → `applyConfigToState`；Gemini 经 codec → `processOpenAIMessages` 无条件调用；Responses WS 也是独立入口。  
修复建议：表格分成“route-level direct call”和“完整请求路径是否 reload”两列，并纳入 HTTP／WS、payload 条件及 indirect call chain；判定受影响须沿真实入口走到 policy freeze。

[major] `/home/xp/src/copilot-api-js/.claude/skills/test-isolation/SKILL.md:49-53` — 推荐的 config 注入／还原步骤没有处理 `cachedConfig`，可能注入不生效，也可能把 synthetic effective config 泄漏给后续测试。  
证据：`setBundledConfigForTests()`／`resetBundledConfigCacheForTests()`只改 `cachedBundledConfig`（`config.ts:636-643`），而 `loadConfig()`可在 debounce 内直接返回旧 `cachedConfig`（`:585-607`）；`resetConfigCache()`才清 effective cache（`:628-633`）。  
修复建议：把可执行合同写成注入前后同时清 `resetConfigCache()`，必要时再 `resetApplyState()`；不要把 `setBundledConfigForTests(null)`单独描述成完整 teardown，并修正未清 cache 的 chat 活例。

[major] `/home/xp/src/copilot-api-js/.claude/skills/test-isolation/SKILL.md:28-59` 与 `/home/xp/src/copilot-api-js/docs/memory/reference-config-yaml-overwrites-setstatefortests-per-request.md:10-16` — 两份复述已形成冲突双源，且没有命名哪一份是 canonical authority。  
证据：memory 仍断言“路由每请求调”且判据只有查 key；新 skill 已改成按 vendor／payload 路径判断。skill 只以“背景与实测”反链 memory，memory 没有反向声明 skill 为现行合同。  
修复建议：指定 `test-isolation` 为当前操作合同，memory 降为带日期／commit 的事故证据 stub 并明确引用 canonical skill；同步删掉 memory 的全称路径口径。

[major] `/home/xp/src/copilot-api-js/.claude/skills/owned-singleton-lifecycle/SKILL.md:20-26,48-53` — “injector 不拥有旧值，所以不该关旧值”缺少防泄漏前置条件；对非空 registry 直接替换会让 owner 永久失去旧资源引用。  
证据：`setHistoryPersistenceRuntimeForTests()`在 `registry.ts:58-60` 无条件覆盖；若旧 runtime 尚未 shutdown，之后 owner reset 只能看到 replacement。现有 source-registry 测试靠调用方先 `runtime.shutdown()`，不是 setter 自身安全。  
修复建议：明确 injector 只能装进空 slot／已由调用方处置旧值的 slot，或返回 displaced value 交由调用方处置；新增“替换非空 owned singleton 不泄漏旧资源”的判据。

[major] `/home/xp/src/copilot-api-js/.claude/skills/owned-singleton-lifecycle/SKILL.md:26,44` 与 `/home/xp/src/copilot-api-js/.claude/skills/owned-singleton-lifecycle/verification-log.md:21` — 承重“现成对照”既引用了错误行号，也没有满足正文自己要求的显式 shutdown 失败策略。  
证据：当前位置是 setter `registry.ts:58-60`、reset `:63-68`，不是 `:62`／`:67-72`；`current.shutdown()` reject 时函数直接抛且保留旧引用，正是 skill `:44` 称为“最糟组合”的默认形状。  
修复建议：将该实现限定为 compare-and-clear／角色分离示例而非完整正例，或先让生产实现明确失败策略；同步修正 SKILL 与 verification-log 的最终文件行号。

## 主观建议

无。除上述 major 外，未发现 blocker；批 4 的四条正反向判据均可执行，批 3 的 key 检查在补齐真实入口调用链后也可执行。结构怪味扫描覆盖了重复权威、职责边界、抽象泄漏与同一合同双份复述；需本轮处置的怪味已并入第 1、3、4 条 major。

## 复评轮

- **评审范围**：五条 major 的修复闭合性、修复 diff 新增断言与最终行号、config 两步判据的可执行性、skill／memory 权威收口。
- **已读取／执行的证据**：读取修复 diff 与四份最终文件；逐行复验指定生产／测试引用；另核对 `src/server.ts:127-142`、`tests/helpers/test-app.ts:16-60`、config 双层加载与 History source-registry teardown；执行 `git diff --check`（仅报 backlog 文件 EOF 多一个空行，属 minor，本轮不列）。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。
- **计数**：0 blocker／3 major。

### 闭合情况

- 上轮 M2、M3、M5 已闭合；M1、M4 仍各留一个承重缺口。
- M3 的双源已收口：`test-isolation` 明确拥有 canonical 操作合同；memory 仅保留带日期的事故观测、口径订正与识别指纹，并反链权威。历史证据与指纹属于有 provenance 的语境复述，不构成第二份合同。
- 指定的新 `file:line` 均已按最终文件复验；但修复正文沿用了一个未在清单里的错误语义：`src/server.ts:139` 不是“启动时”调用。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/test-isolation/SKILL.md:39-53` — M1 的路径判据仍漏掉最外层 harness，且把 `src/server.ts:139` 错写成“启动时”。  
证据：`src/server.ts:127-142` 是 production middleware，除 liveness 外**每请求无条件**先 apply；`tests/helpers/test-app.ts:16-60` 默认却不装该 middleware，只有调用方显式传 `preMiddleware` 才有前置层。  
失败场景：同一 Responses／Messages payload 在 `createServer` 下必 reload，在默认 `createFullTestApp` 下才由 route／codec 条件决定；现表按 vendor／payload 会把 production 路径误判。  
修复建议：两步前先判 harness：production `createServer`／真实 server = middleware 无条件命中；默认 `createFullTestApp` = 无该层，再查 route／codec；给出具体 consumer／freeze 点或动态探针，别只写“走到 policy 冻结点”。

[major] `/home/xp/src/copilot-api-js/.claude/skills/test-isolation/SKILL.md:53,57-67` — 第一步声称检查“生效 config”，命令却只查仓库根 bundled `config.yaml`，仍可 false-green。  
证据：`loadConfig()` 合并 `PATHS.BUNDLED_CONFIG_YAML` 与用户／测试 `PATHS.CONFIG_YAML`（`config.ts:585-607`）；测试还可用 `setBundledConfigForTests` 替换 bundled 层。`rg ... config.yaml` 看不到后两者。  
失败场景：键只存在于 sandbox user config 或 synthetic bundled object 时，命令零命中却仍会写回 state；反之用户层也可能覆盖 bundled 值。  
修复建议：把机械判据改为读取本测试实际 `PATHS` 与 synthetic seam 后的 `await loadConfig()` 结果并检查 key；注入合同同时声明 user-config 层必须隔离／为空或由 suite 明确拥有。

[major] `/home/xp/src/copilot-api-js/.claude/skills/owned-singleton-lifecycle/SKILL.md:22,65,88` — M4 新增的“setter 返还旧值”仍不是“不泄漏”的充分判据。  
证据：TypeScript／JavaScript 调用方可以无声忽略返回值；`:65` 更把“调用方手上拿到了它”列为通过条件，却没有证明旧 Worker／timer／socket 已停止。返回引用只转移能力，不会“逼”调用方处置。  
失败场景：`const old = setX(replacement)` 后不 dispose，甚至直接忽略 return；V5 仍可按“返还被顶掉的值”判绿，旧资源继续运行。  
修复建议：最终 oracle 统一为旧资源可观测地停止；机制上优先非空即抛，或提供 owner 级 async `replace` 原子处置旧值。若保留 return API，只能算辅助接缝，必须另证调用方 await dispose。


## 第三轮复评

- **评审范围**：上一轮三条 major 的闭合性；`createServer` middleware 豁免面、test harness 条件、config 双路径与生效值读取时机。
- **已读取／执行的证据**：逐行读取修订后的两个 skill 与 verification log；核对 `src/server.ts:68-169`、`tests/helpers/test-app.ts:17-61`、`src/lib/config/{paths.ts,config.ts}`、`src/routes/config/route.ts:89-96,180-230`；CodeGraph 枚举 config middleware 前后路由；`git diff --check` 已 clean。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。
- **计数**：0 blocker／2 major。

### 闭合情况

- 上轮 M1 的 harness／route 分层语义已闭合；`createServer` 中只有先注册的 `GET /health/liveness` 绕过 config middleware，notFound／browser probe、root、readiness、HTTP routes 与后续注入的 routes 均在 middleware 之后。
- `await loadConfig()` 可在 app 启动前的 async `beforeEach` 执行；前提是先装好 `PATHS`／synthetic bundled seam 并 `resetConfigCache()`。修订文本的这个主判据可执行。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/test-isolation/SKILL.md:31-33,65-67` — M2 尚未闭合：开篇仍把来源缩成“仓库根 config.yaml”，且把 `GET /api/config` 写成 `loadConfig()` 的等价 oracle。  
证据：`GET /api/config` 调 `buildEffectiveConfig()`，读的是已应用后的 camelCase `state` 投影（`src/routes/config/route.ts:89-90,180-230`），不是 bundled + user 合并后的 snake_case `Config`；默认 `createFullTestApp` 还没有前置 apply middleware。  
失败场景：读者按 snake_case key 查该响应会判 absent；或 synthetic／user config 尚未 apply 时读到旧 state。  
修复建议：开篇统一改为“生效 config”；删除 HTTP 备选，或明确必须先经真实 apply、再按 state 字段验证行为——检查 raw effective key 的唯一直接 oracle 是 seam 完成并清 cache 后 `await loadConfig()`。

[major] `/home/xp/src/copilot-api-js/.claude/skills/owned-singleton-lifecycle/SKILL.md:25-30` — M3 的 owner 级 async `replace(next)` 被称为“原子”，但“放在同一个函数”不能让跨 `await` 的替换原子化。  
证据：dispose 期间另一个 setter／replace 仍可改 registry；若旧 replace 随后无条件安装 `next`，会覆盖并泄漏中途 replacement，重现本 skill 正在防的竞态。`:30` 又把“只能空 slot／旧值已处置”写成三种方案共同的调用前置，与安全替换非空 slot 的目标冲突。  
修复建议：给 `replace` 明确同步机制与线性化点（mutex，或 capture → await dispose → compare-and-install，并规定比较失败时谁 dispose `next`）；把空-slot 前置限定给普通 injector，最终 oracle 仍为所有落败旧／新实例的资源均可观测停止。


## 第四轮复评

- **评审范围**：上一轮两条 major 的闭合性；`GET /api/config` 的 runtime-state 语义；async `replace` 两种线性化方案的完备性。
- **已读取／执行的证据**：读取两个 skill 与 verification log 最终文本；核对 `src/routes/config/route.ts:89-90,180-230` 的 state 投影；复核 `src/server.ts:68-169` 的 middleware 注册顺序；`git diff --check` 已 clean。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。
- **计数**：0 blocker／1 major。

### 闭合情况

- 上轮 M1 已闭合。`route.ts:191-193` 引用准确；`GET /api/config` 确实从当前 `state` 构造 runtime projection，适合回答“进程当前持有／对外报告的运行态配置”，但它会 mask／reshape 部分字段，不能当 raw effective config 或任意内部对象的逐字 oracle。当前正文已把用途限定到运行态，处置成立。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/owned-singleton-lifecycle/SKILL.md:27-32,75,98` — M2 仍未闭合：两种方案只协调 `replace`，没有保护普通 getter／setter／lazy-init，因此都不是 registry 的完整线性化合同。  
证据：mutex 若仅包住 `replace`，普通 setter 仍可穿透；compare-and-install 在 `await current.dispose()` 期间仍把 `current` 留在 registry，普通 getter 可拿到正在关闭／已关闭的实例。最终“只剩一个活实例”测试看不到这个中间态。  
修复建议：明确所有读、写、lazy-init 都参加同一 lifecycle protocol；mutex 路线须覆盖全部 access，CAS 路线须先原子 claim 为 closing／replacement promise，使 getter 等待或失败。CAS 失败时还须保持 winner、不再安装 next、dispose next，并以返回值／异常明确通知调用方“本次未安装”。


## 第五轮复评

- **评审范围**：owner 级 async `replace` 两条 lifecycle protocol 的闭合性与适用边界；V5 自验同步。
- **已读取／执行的证据**：读取 `owned-singleton-lifecycle/{SKILL.md,verification-log.md}` 最终文本；核对全部读写参与、claim 中间态、CAS 失败处置、并发／中间态判据；`git diff --check` 已 clean。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。
- **计数**：0 blocker／1 major。

### 闭合情况

- 上轮 lifecycle protocol 的正文 major 已闭合。`closing` 状态与 replacement promise 不是完全相同机制，但作为两种明确策略并列成立：前者可让 getter 明确失败，后者可让 getter 等待；关键是 claim 必须不可与活实例混淆，所有访问者识别它，compare 针对该 claim，正文已冻结这些性质。
- 没有把简单情形强制复杂化：第 1 档“非空即抛”明确优先且无需并发推理；只有业务确实要求替换非空 slot 时才进入第 2 档。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/owned-singleton-lifecycle/verification-log.md:24` — V5 自验记录没有随正文同步，仍声称修法是“空-slot 前置 + 建议 setter 返还旧值”，与当前合同冲突。  
证据：正文 `SKILL.md:27-36,79,102` 已明确 return 只是辅助接缝，并要求全访问 protocol、claim／mutex 线性化与落败实例释放；log 的“已修”却停在第三轮前的被证伪方案。  
修复建议：保留历史演化但补齐后续证伪链，明确 return-only 再次被证伪，并记录最终修法与两条测试 oracle；不要覆写成仿佛初次就写对。


## 第六轮复评

- **评审范围**：V5 verification log 的事实演化链；`debugging-claude-client-connection` 对 pre-response abort 裁决的引用归属与支撑力。
- **已读取／执行的证据**：读取 V5 最终条目、归档 memory、skill 引用上下文；对照活 spec `docs/spec/pre-response-abort-handling.md:10-12,386-399,486-499` 与 `docs/DESIGN.md:76`；检查相关 diff，无 whitespace error。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。
- **计数**：0 blocker／2 major。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/owned-singleton-lifecycle/verification-log.md:24` — V5 仍少记一轮，声称“连打三轮／修订 3 次”与本报告实际四次判据修订不符。  
证据：① 直接覆盖丢旧引用；② return 可忽略；③ 同函数内 async replace 不原子、需线性化及 CAS loser 处置；④ **只协调 replace 仍让 getter／setter／lazy-init 穿透，中间态外泄**。当前条目把③④合并成同一轮。  
修复建议：按四个独立 finding／复评轮记录为“修订 4 次”；最后一轮单列“所有 access 参加 protocol + claim 中间态 + getter oracle”，保留真实因果与轮次。

[major] `/home/xp/src/copilot-api-js/.claude/skills/debugging-claude-client-connection/SKILL.md:112` — 断链虽修成可达链接，但路由到了 archive memory，而活 spec 仍是该 GO 裁决的权威来源。  
证据：归档 memory `:19-22` 确实支撑 grace<60s、heartbeat<60s、残余可接受；但活 `docs/spec/pre-response-abort-handling.md:10-12,486-499` 同样直接记录 Q2 实测与 GO，且含后续 supersede／当前口径，DESIGN 也反链该 spec。  
修复建议：skill 直接链接 `../../../docs/spec/pre-response-abort-handling.md` 的 Q2／C3b；archive memory 只在需要事故叙事时作补充，不应成为现行技术结论入口。


## 第七轮复评

- **评审范围**：V5 四轮因果链、pre-response abort 活 spec 引用、`test-app.ts:54`，以及 `test-isolation`／`owned-singleton-lifecycle` 正文和现存 verification log 的全部数字行号。
- **已读取／执行的证据**：全文读取两个 skill 与 `owned-singleton-lifecycle/verification-log.md`（`test-isolation` 无 verification-log）；用最终文件 `nl -ba` 逐项复验全部数字引用；对照 driver S1a parse → S1b translateInbound 顺序及 Responses parse 的 config 消费点；`git diff --check` 已 clean。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。
- **计数**：0 blocker／1 major。

### 闭合情况

- V5 四段因果链与“修订 4 次”准确；`docs/spec/pre-response-abort-handling.md:10-12` 直接支持 grace／heartbeat `<60s`、错误帧残余与 GO；`tests/helpers/test-app.ts:54` 确为 conditional `preMiddleware` 安装。
- 全部数字 `file:line` 均指向所述代码；`tests/history/worker/registry.unit.test.ts:41-61` 从空行起且未含尾 `})`，但承重断言与暂停流程完整落在该区间，不构成错误。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/test-isolation/SKILL.md:30-35,52-73` — 三步判据仍只问“reload 是否发生在某个 policy freeze 前”，没有把**目标 key 的消费点**纳入判定，因而会把 post-consumption reload 错判为覆盖测试 seam。  
证据：driver 顺序是 S1a `parse` 后才 S1b `translateInbound`（`src/lib/pipeline/driver.ts:586-595`）；Responses 的间接 apply 在 S1b（codec `:325-326`），但 `normalizeResponsesCallIds`、image-tool filter、tool-name mapper 已在 parse `src/lib/codec/openai-responses/codec.ts:426,467-473` 消费 state。  
失败场景：默认 `createFullTestApp` + Responses 有 `instructions` 时确实 reload，但对这些 parse-time key 来得太晚；按当前三步会断言 `setStateForTests` 是空操作，实际本请求已经采信测试值。Gemini 同样是 parse 后 S1b reload。  
修复建议：第②步改为针对目标 key 画 `last test write → config apply → first consumer/snapshot` 的时序；只有 apply 早于该 key 的首个消费点才判“钉不住”。表格保留“会 reload”事实，但不得直接推出所有 config-managed key 都被覆盖。


## 第八轮复评

- **评审范围**：目标 key 的逐键时序判据及新增 `file:line`。
- **已读取／执行的证据**：读取 `test-isolation` 修订段；按最终文件复验 `src/lib/pipeline/driver.ts:586-593`、`src/lib/codec/openai-responses/codec.ts:426,467,471-473`；`git diff --check` 已 clean。
- **总体 verdict**：**可进入下一阶段（可以定稿）**。
- **blocker 数量**：0。
- **计数**：0 blocker／0 major。

### 结论

- 上轮 major 已闭合。新增引用准确：driver 的 S1a parse 明确先于 S1b translateInbound；三个 Responses 调用点均位于 parse，且分别消费 image-tool、normalize-call-id、tool-name sanitization 的 config-managed state。
- 逐键判据可执行：先从目标 config key 到 state camelCase 映射，再枚举 `state.<key>` 及封装它的 resolver／builder 引用，限制到真实入口调用链，取测试写入后的第一个实际消费／快照点，与 `applyConfigToState()` 排序。当前正文已给出三点时序、正反结论和具体正样本，足以让读者执行；补写上述检索动作只属 minor 清晰度增强，不阻断定稿。
- 未发现 blocker 或 major；可以定稿。
