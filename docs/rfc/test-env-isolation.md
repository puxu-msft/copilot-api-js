# RFC: 测试环境隔离机制全面重写

**Status:** 实现中 — P0/P1/P3 已落地、P4 文档已回填;P2 分域迁移进行中(models 域已迁,anthropic/openai/responses/gemini/pipeline 域暂缓至并发 L2 会话收敛)。interim floor `737f9a4`;设计 §8–§10;**§11 为权威落地态**(含 review 结论 + P0–P4 进度)。
**Date:** 2026-06-22
**Owner:** 新会话推进中

---

## 1. Context — 为什么写这份文档

排查"用户重启后 sonnet-4.6 反复 `unsupported-beta-retry` 重学"时,**实测**(非读代码)发现:不是生产持久化 bug,而是**测试在擦写操作者的真实状态**。`resetAnthropicFeatureNegotiationForTesting()` 会把(清空后的)negotiation map 持久化到磁盘;9/13 个触碰该缓存的测试**没有沙箱 `PATHS.NEGOTIATION_STATES`**,于是任何一次 `bun test` 都把空快照写盖真实 `~/.local/share/copilot-api/negotiation-states.json`,擦掉学到的 beta/partner-feature/effort。

顺着这条线全面审计后发现 **negotiation 擦除只是冰山一角**:30+ 测试文件还在读写/reap 操作者的真实 `history.db`(52MB)、`learned-limits.json`、`request-telemetry.json`。详见 §3。

**方法论教训(写在最前,新会话务必遵守):**
- 否定性/通过性结论("没问题""不会重学""已隔离")**必须实测**,绝不靠读代码下结论。本次最初的"已确认无问题"就是 paper-analysis,被运行日志 + 真实文件 mtime 当场推翻。见记忆 `feedback-pass-null-clean-not-self-validating` / `empirical-verification`。
- 验证手段:运行日志(load 从不打印 `Loaded N` = 启动即读到空)、真实文件 mtime before/after 跑测试、独立 round-trip 探针。

---

## 2. 既有隔离机制(现状,你说"以前有一套"是对的——但它是 opt-in,漏得大)

隔离是**逐测试、opt-in、分散**的,**没有全局地板**:

| 机制 | 文件 | 隔离什么 | 不隔离什么 |
|---|---|---|---|
| `autoRestoreState()` / `setStateForTests` | `tests/helpers/state-fixture.ts:46-51` | 内存 `~/lib/state`(快照/还原) | **任何 fs 路径** |
| `bootstrapTestRuntime()` / `autoTestRuntime()` | `tests/helpers/test-bootstrap.ts:48-61,106-118` | runtime 单例 + history **表内容**(`clearHistory`) | **history DB 文件路径**(见 §3) |
| `applyFetchMock` / `autoRestoreFetch` | `tests/helpers/mock-fetch.ts` | 网络(`globalThis.fetch` + `upstreamFetch`) | fs |
| 逐测试 `PATHS.X = mkdtemp()` | 各测试 beforeAll/afterAll | 该测试显式列出的那一个路径 | 没列到的路径 / 没自觉的测试 |

**这套真正覆盖到的**(既有 opt-in 生效处):`CONFIG_YAML`/`APP_DIR`(4 个 config 测试 reassign+还原)、专用 `history/*.it`(显式 `:memory:`)、`file-sink`/`telemetry`/`codex`/`setup-claude-code`(注入临时路径 + homedir 守卫)。

---

## 3. 泄漏审计(冰山,带 file:line)

> 已核验:negotiation 擦除、`initHistory` 默认路径语义。其余为 subagent 审计结论 + file:line,新会话应逐条复核。

| 泄漏 | 规模 | 机制(根因) | 证据 |
|---|---|---|---|
| **真实 `history.db` 读写 + reaper 删行** | **30 文件** | `bootstrapTestRuntime()`→`initHistory(true,100)`;`initHistory(enable, _legacyMaxEntries)` 第一参是 enable **不是 in-memory**;`dbPath = state.historyDbPath \|\| PATHS.HISTORY_DB`,`historyDbPath` 默认 `""` → 开**真实 db**,且启动 reaper(超限删行) | `src/lib/history/state.ts:62-74`、`src/lib/state.ts:969`、`tests/helpers/test-bootstrap.ts:51` |
| `negotiation-states.json` 写空 | 9 文件 | `resetAnthropicFeatureNegotiationForTesting()`→`persistFeatureNegotiation()` 写未沙箱的 `PATHS.NEGOTIATION_STATES` | `src/lib/anthropic/feature-negotiation.ts:270-281`;未沙箱测试见 §5 清单 |
| `learned-limits.json` 写真实 | auto-truncate 学习测试 | `engine.ts` 直写 `PATHS.LEARNED_LIMITS`,**根本没有注入 seam** | `src/lib/auto-truncate/engine.ts:210,231` |
| `request-telemetry.json` 写真实 | `management-routes.http` | `_resetRequestTelemetryForTests()` 把路径**还原成真实路径**;有 `_set...FilePathForTests` seam 但该测试没用 | `src/lib/request-telemetry.ts:107,532,535` |

**无泄漏(已确认安全)**:`COPILOT_LOG`(FileSink 测试都注入临时 logPath)、`GITHUB_TOKEN_PATH`(offline 不写)、`CONFIG_YAML`(config 测试自沙箱)。唯一绕过 preload 的真实**读**:`tests/e2e/config.ts:74` 读真实 `github_token`,只读、e2e 门控、有意为之,非 clobber。

---

## 4. 已落地的 interim floor(commit `737f9a4`,**不是最终方案**)

一个 bun-test preload 在唯一上游接缝兜底:

- `tests/helpers/sandbox-paths.ts` — 在任何 `src` 模块算 `PATHS` 之前,把 `XDG_DATA_HOME` 重定向到 `mkdtemp` 临时目录(`computeAppDir()` 读它,见 `src/lib/config/paths.ts:6-9`)。
- `bunfig.toml` `[test].preload = ["./tests/helpers/sandbox-paths.ts"]` —— **只作用于 `bun test`,不影响 `bun run start`/生产**(顶层 `preload` 才会作用于所有 `bun` 运行——切勿放顶层)。
- `tests/infra/sandbox-paths.unit.test.ts` — 守卫,断言 6 个 `PATHS.*` 落在沙箱内,防 preload 静默失效。

**实证**:全套件 2924 pass,真实 `negotiation-states.json` mtime 全程不变,测试写到 `/tmp/copilot-api-test-sandbox-*`。它把 4 个泄漏 `PATHS.*` × 40+ 文件一次性兜住,包括**根本没有逐测试 seam 的**(learned-limits、bootstrap 的 history 路径)。逐测试沙箱仍可在其上 override。

**为什么仍要"全面重写"而不止于此 preload**:preload 是**地板/止血**,不是架构。它掩盖了底层问题(测试默认就该隔离,而非靠一层 env 兜底);它不解决 in-memory 测试隔离(history 表跨文件复用同一临时 db、negotiation map 跨测试泄漏靠 afterEach reset)、不修"reset 助手会写盘"这种设计气味、不给 learned-limits 等补注入 seam。重写目标见 §6。

---

## 5. 未沙箱测试清单(negotiation,供重写参考)

触碰 negotiation 缓存共 ~14 文件,**已沙箱仅 3**:`feature-negotiation-server-tools.unit`、`server-tool-rejection.http`、`structured-outputs-rejection.unit`。
**未沙箱(靠 preload 兜底)**:`feature-negotiation.unit`、`strip-server-tools-learned.it`、`anthropic-request-preparation.it`、`anthropic-v4.http`、`response-rewrite-golden.http`、`pipeline/{server-tool-rejection-retry,deferred-tool-retry-strategy,context-management-retry-strategy,unsupported-beta-retry-strategy,pipeline-with-strategy}.unit`。
history.db 30 文件清单见 subagent 审计原文(新会话用 `rg -l "bootstrapTestRuntime|autoTestRuntime" tests/` 重新枚举)。

---

## 6. 全面重写的方向(待新会话设计 + 决策)

这些是**问题/方向**,不是结论——新会话应调研后定方案:

1. **默认隔离 vs opt-in**:是否让"所有 .it/.http 测试默认拿到全套临时路径 + 干净 state + mock 网络",而非每个测试自己记得沙箱?候选:统一 fixture / 全局 setup。
2. **bootstrapTestRuntime 用 `:memory:`**:history 测试默认开内存库(更快 + 天然隔离 + 无临时文件),需注入路径的测试再 opt-in 真实临时文件。评估 `:memory:` 与 reaper/WAL/磁盘特性测试的兼容性。
3. **补齐缺失的注入 seam**:`learned-limits`(无 seam)、统一 `negotiation`/`telemetry` 的 path 注入接口,让"持久化路径"成为一等可注入依赖,而非 module-global `PATHS`。
4. **"reset 助手写盘"是设计气味**:`resetAnthropicFeatureNegotiationForTesting` 为什么要 `await persistFeatureNegotiation()`?能否只 cancel timer + clear map、不落盘?审 drain 语义。
5. **preload 的去留**:重写后 preload 是保留为最后一道地板(防御纵深),还是被更结构化的 fixture 取代?倾向**保留**(零成本、防未来回归)。
6. **跨测试 in-memory 泄漏**:negotiation/state/effort map 是 module-global,靠 afterEach reset。是否需要更强的 per-test 隔离(如每测试新建 manager 实例 / DI)?
7. **守卫与 CI**:除了 `sandbox-paths.unit.test.ts`,是否加一个 L1 守卫——跑完套件后断言真实 `~/.local/share/copilot-api/*` mtime 未变(端到端证明零泄漏)?
8. **统一文档**:把测试隔离纪律写进 `docs/coding-conventions.md` / CLAUDE.md(现有纪律分散,且明显没被遵守)。

---

## 7. 新会话调研 kick-off 提示词

> 复制以下整段到新会话。

```
全面重写 copilot-api-js 的测试环境隔离机制。背景与现状已整理在 docs/rfc/test-env-isolation.md —— 先完整读它(含 §2 既有机制、§3 泄漏审计、§4 已落地的 interim preload、§6 重写方向),再开工。

裁判轴(本项目 CLAUDE.md,务必遵守,覆盖 subagent 默认的 ROI/YAGNI 价值观):唯一轴是"问题是否真实存在"和"哪个方案最终质量最高、最完整",而非风险/工期/改动量。架构健康 > 向后兼容;真实风险(测试擦写真实用户状态)必须根治,不归类为"等触发再说"。否定性/通过性结论(测试绿、"已隔离"、真实文件未变)**必须实测**,绝不靠读代码下结论——本问题最初就是栽在 paper-analysis 上。

调研阶段(只读,先全面摸清再动手,派 subagent 多视角对抗):
1. 复核 §3 每条泄漏:亲自读引用的 file:line + 实测(跑相关测试、看真实文件 mtime / 内容 before-after)。补全 history.db 30 文件、learned-limits、telemetry 的精确清单与机制。
2. 枚举所有 APP_DIR 派生持久化(src/lib/config/paths.ts 的 PATHS.*)及其在测试中的触碰方式(默认路径 vs 注入临时)。grep `PATHS\.` in tests/ + src persistence writers。
3. 摸清既有隔离 primitive 的真实边界(state-fixture / test-bootstrap / mock-fetch / 逐测试 PATHS 沙箱),哪些测试用、哪些漏。
4. 评估 §6 的 8 个方向,每个给出实测依据(如 :memory: 是否与 vacuum/WAL/reaper 测试兼容——亲自跑)。

设计 + 实现(调研后):
- 目标:**测试默认就隔离**(fs 路径 / 网络 / 全局 state / runtime 单例),消除"忘了沙箱就擦真实状态"的可能;给缺失的持久化补可注入 seam;保留 preload 作最后地板 + 端到端守卫(跑完套件断言真实 ~/.local/share/copilot-api/* 未被触碰)。
- 走本项目 big-feature-pipeline:≥1000 行或结构性重构先在本 RFC 补设计稿 + 3+ 轮对抗 subagent review,再按 phase 实现;每个中间 commit 都不让套件半坏。
- 验证用 bun(非 npm):bun run test:backend / typecheck / lint:all。eslint --fix 自动格式化(勿直接 prettier --write)。细粒度暂存、一阶段一 commit、提交信息不加 Claude 署名。

交付:更新本 RFC(现状→落地)、把测试隔离纪律回填进 docs/coding-conventions.md 或 CLAUDE.md、维护相关 memory(feedback_tests_never_touch_real_env 已含本次教训)。

已落地的 interim(commit 737f9a4,勿回退):tests/helpers/sandbox-paths.ts + bunfig.toml [test].preload + tests/infra/sandbox-paths.unit.test.ts。
```

---

## 8. 设计稿(范围=默认隔离全重写,§6 全 8 项)

### 8.1 核心理念:隔离从「opt-in 记得沙箱」变为「默认构造即隔离」

现状是**三层 opt-in 拼凑** + 一层全局 floor 兜底(§2、§4):测试各自记得调 `autoRestoreState`/`autoRestoreFetch`/`autoTestRuntime`/逐测试 `PATHS.X=mkdtemp`,漏一个就泄漏;floor(preload 重定向 `XDG_DATA_HOME`)是事后兜底,把 fs 危害降为零,但**不改变「测试默认不隔离」这一根本结构**。
重写目标:让 `.it`/`.http` 测试**默认**拿到「临时 fs 路径 + `:memory:` history + 干净的全部 module-global 单例 + 受控网络」,使「忘了沙箱就擦真实状态/泄漏到下个测试」从构造上不可能,而非靠记性 + floor。floor 保留为最后地板(防御纵深,零成本)。

### 8.2 中枢:统一 fixture `useIsolatedRuntime`

新增 `tests/helpers/isolated-fixture.ts`,导出单一入口 `useIsolatedRuntime(opts?)`,在 describe 顶部调一次,注册 `beforeAll`/`beforeEach`/`afterEach`,把现有 primitive 组合成「默认全隔离」:

- **runtime**:`bootstrapTestRuntime()`(改走 `:memory:`,见 8.4)+ `resetTestRuntime()` afterEach。
- **state**:`snapshotStateForTests` beforeEach / `restoreStateForTests` afterEach(吸收 `autoRestoreState`)。
- **network**:afterEach `restoreFetch()`;默认安装一个「未 mock 的上游调用即 throw」的 guard fetch(可 opt-out),让忘记 mock 网络的测试**响亮失败**而非真打网络(呼应 feedback_tests_never_touch_real_env)。
- **module-global 单例全 reset**(afterEach,这是「默认隔离」相对 floor 的真正增量——floor 只管 fs,管不了进程内跨测试 map 泄漏):
  `resetAnthropicFeatureNegotiationForTesting`(6 maps)、`resetAllLimitsForTesting`(auto-truncate)、`_resetRequestTelemetryForTests`、`resetModelsEtagForTests`、`resetUpstreamWsManagerForTests`、`resetProcessIdentityForTests`、`_resetConfigValidationWarnTrackingForTests`、`resetBundledConfigCacheForTests`、`resetAdaptiveRateLimiter`(已在 resetTestRuntime 内)、bus/context(已在 resetTestRuntime 内)。
  注册中心化为一张 `RESETTERS: Array<() => void>` 表,afterEach 顺序调用;新增 module-global 单例时**加一行**即全测试覆盖。

`opts` 字段(全部有安全默认,留 opt-out/opt-in 缝):
- `network?: "guard" | "passthrough" | "off"`(默认 `"guard"`)
- `history?: ":memory:" | "tempfile" | "off"`(默认 `":memory:"`;需真实磁盘特性的少数测试用 `"tempfile"` 拿注入临时文件)
- `wsSink?` / `consoleSink?`(默认不挂,沿用 bootstrap 现状)

### 8.3 补齐缺失的注入 seam(§6.3)+ 修「reset 写盘」设计气味(§6.4)

持久化路径应成为一等可注入依赖,而非只能靠 floor 重定向 `PATHS`:

- **`auto-truncate/engine.ts`**:当前**完全无 seam**(直写 `PATHS.LEARNED_LIMITS`)。加 `setLearnedLimitsPathForTests(path | undefined)`,内部读模块变量 `learnedLimitsPath ?? PATHS.LEARNED_LIMITS`。
- **`request-telemetry.ts`**:已有 `_setRequestTelemetryFilePathForTests`,但 `_resetRequestTelemetryForTests` 把 `telemetryFilePath` **还原成真实 `PATHS.REQUEST_TELEMETRY`**(L532)——这是气味,reset 反而解除沙箱。改为 reset **不动 path**(只清内存计数),path 由测试显式设/清。
- **`feature-negotiation.ts`**:`resetAnthropicFeatureNegotiationForTesting` 当前 `await persistFeatureNegotiation()` **落盘**(根因 bug 来源)。改为**只 cancel 防抖 timer + clear 6 maps,绝不落盘**——reset 是测试构造,不该产生持久化副作用。审 `persistTimer`/`schedulePersist` 的 drain 语义,确保 cancel 后无悬挂写。

这三处改完,「在 afterEach reset 全部 module-global」就**不再有任何写真实盘的路径**,floor 退化为纯防御纵深。

### 8.4 `bootstrapTestRuntime` 默认 `:memory:`(§6.2)

证据(§研究):`openDatabase(":memory:")` 显式支持(connection.ts:54 从不复用 memory 连接 / :108 跳过 VACUUM / 已有 `openInMemoryDatabase`);需真实磁盘特性的测试(`vacuum.it`/`search-backfill.it`/`incremental-recovery.it`)**自管 `mkdtemp` 路径、不经 bootstrap**,不受影响。
改 `bootstrapTestRuntime`/`resetTestRuntime` 的 `initHistory(true,100)` 前置 `setStateForTests({historyDbPath: ":memory:"})`(或经 fixture opts)。顺带修 test-bootstrap.ts:39 那条**撒谎注释**(写着 in-memory 实际开真实 db)。

### 8.5 module-global map 的 per-test 隔离:reset 而非 DI(§6.6)

评估结论:**默认 reset(8.2 的 RESETTERS)足够,不做 DI 改造**。
理由(architecture-health-first + YAGNI):full DI(把 feature-negotiation 6 maps 改成可注入实例)会触及每个 prepare step/strategy 消费点,是巨大表面;而一旦 8.3 让 reset 不再落盘、8.2 让 fixture **默认**在每个 .it/.http 的 afterEach 无条件 reset,跨测试 in-memory 泄漏就已从构造上根除(不再依赖「测试记得 reset」)。DI 只在「reset 证明不充分」(如异步 persist race 跨测试可见)时才上;本设计交对抗 review 专门证伪这一点(见 §10 Q3)。

### 8.6 端到端守卫(§6.7)——形态修正

**陷阱**:操作者服务器**常驻运行**、持续写真实 `~/.local/share/copilot-api/*`(history.db-wal/telemetry/log 秒级更新)。所以「跑完套件断言真实目录 mtime 未变」会被**生产服务器活动**污染成 false-positive,不可靠(本会话实测确认:这些文件 mtime 反映的是 live server,非测试)。
正确形态:守卫**主动行使每个 writer**,断言落点在 sandbox 而非真实 APP_DIR——`persistFeatureNegotiation()`/telemetry flush/learned-limits save/`openDatabase` 各跑一次,读回路径前缀含 `SANDBOX_MARKER`。这是确定性的、不受 live server 干扰。`sandbox-paths.unit`(静态断言 PATHS 解析)+ 新 `real-state-guard`(动态断言 writer 落点)双守卫。

### 8.7 文档(§6.8)

把隔离纪律写进 `docs/coding-conventions.md`(测试组织小节)+ CLAUDE.md 代码风格的测试隔离条:新增 .it/.http **默认调 `useIsolatedRuntime()`**;需真实磁盘/网络/特殊路径的显式经 opts 或注入 seam opt-in;新增 module-global 单例**必须**在 RESETTERS 表加一行 + 提供 `reset*ForTests`。

---

## 9. Phase 计划 + commit invariants

每个中间 commit 都不让套件半坏(`bun run test:backend` + `typecheck` 绿);细粒度暂存、一阶段一 commit。

- **P0 — src seam + 去副作用**(8.3+8.4 的 src 侧):加 `setLearnedLimitsPathForTests`;telemetry reset 不再 re-point;negotiation reset 不再落盘;bootstrap 走 `:memory:` + 修撒谎注释。
  *Invariant*:纯增量/行为保持(生产路径不变),全套件绿。这步本身已消除「reset 写盘」根因(即便后续 phase 未做,真实状态也已不被 reset 擦)。
- **P1 — 统一 fixture**(8.2):新增 `isolated-fixture.ts` + RESETTERS 表;**不迁移任何测试**。
  *Invariant*:additive,fixture 自带单测验证(开/关 network guard、reset 覆盖全表),全套件绿。
- **P2 — 分域迁移 .it/.http**(按 `tests/<域>/` 分批,每域一 commit):用 `useIsolatedRuntime()` 替换逐文件 `autoTestRuntime`+`autoRestoreState`+`autoRestoreFetch`+逐测试 negotiation reset 样板;保留各测试真正需要的 opts。
  *Invariant*:每批迁完该域绿;未迁的域仍走旧 primitive(新旧并存无害,旧 primitive 不删)。
- **P3 — 端到端守卫**(8.6):新增 `tests/infra/real-state-guard.unit.test.ts`(writer 落点断言)。
  *Invariant*:守卫绿且能在「故意解除沙箱」时红(自证非假阴性,呼应 feedback-pass-null-clean-not-self-validating)。
- **P4 — 收尾**:删除被 fixture 取代的死 primitive(若全消费者已迁;否则保留并文档化);回填 `docs/coding-conventions.md`+CLAUDE.md;更新本 RFC 状态→落地;维护 memory。
  *Invariant*:无悬挂死导出;文档与代码一致。

---

## 10. 交对抗 review 的 open questions(裁判轴=长远正确+完整,非 ROI)

- **Q1**:8.2 的「network guard 默认 throw on unmocked upstream」会不会误伤合法的本地/passthrough 测试(SearXNG 明文、e2e)?guard 的判别边界(upstreamFetch vs globalThis.fetch vs 真实外呼)是否精确?
- **Q2**:8.3 让 `feature-negotiation` reset 不落盘——`persistTimer` 防抖窗口内若已 schedule,cancel 是否彻底?有没有「reset 后 timer 仍 fire 一次落盘」的残窗?drain/serialize 语义需逐行核。
- **Q3**:8.5 的「reset 足够、不做 DI」——能否构造一个跨测试 in-memory 泄漏,是 afterEach reset **抓不住**的(如某 map 在 reset 表之外、或异步写在 reset 后落地)?若能,则 DI 不是 YAGNI 而是必需。
- **Q4**:P2 分域迁移期间「新 fixture + 旧 primitive 并存」是否真无害?有没有两者 afterEach 顺序耦合(如 fixture 先 restore state、旧 autoRestoreState 再 restore 一次旧快照)导致的交叉污染?
- **Q5**:`:memory:` 默认是否漏掉某个**当前依赖真实 db 文件**却经 bootstrap 的测试(grep 未覆盖的间接消费)?
- **Q6**:RESETTERS 表的**完整性**如何防漂移(新增 module-global 单例忘记登记)?是否需要一个 L1 守卫(类似 config-hot-reload 的完整性测试)枚举 src 里所有 `reset*ForTests` 导出、断言都在表内?

---

## 11. 对抗 review 结论与设计修订(权威 — 已亲自逐 file:line 复核每条断言)

3 轮并行对抗 subagent(correctness/coverage/architecture 三视角)+ 主会话亲自复核。**最重要的结论:RFC §3 审计与 §8.3 部分写于 floor 落地之际,引用的是 floor 之前的旧行为,已过时——下面纠正,以 §11 为准。**

### 11.1 已证伪 / 降级(pre-floor 过时框架)

- **negotiation reset「写空快照=根因气味」是过时描述**。亲验 `feature-negotiation.ts:338-354`:当前 `resetAnthropicFeatureNegotiationForTesting` 已是 **cancel timer → drain(`await persistFeatureNegotiation()`,写的是 still-populated 非空状态)→ clear maps**,注释 L343-346 明确解释 drain 是**有意**的(排空在飞写,避免 enqueued persist 在测试开始后才落 cleared 态)。**根因 bug(空快照擦真实文件)早已被这次重构 + floor 双修**。§8.3 提议「删掉落盘」是基于过时前提——**不删这个 drain**。修订:fixture 的 per-test afterEach 不该每测试都跑这条 async drain(纯 sandbox I/O 浪费);改为**新增一条轻量同步 `clearAnthropicFeatureNegotiationForTests()`**(只 cancel timer + clear maps,不 await、不 persist)供 fixture 默认调;既有 async drain-reset 保留给「需要把 cleared 态刷盘」的显式 caller。
- **telemetry reset「re-point 到真实路径=泄漏」也是过时框架**。`_resetRequestTelemetryForTests` 把 `telemetryFilePath` 还原成 `PATHS.REQUEST_TELEMETRY`——**floor 下 `PATHS.*` 即 sandbox,不是泄漏**。`management-routes.http.test.ts:200,216` 只调 `_reset`(从不 setPath),依赖这个 re-point,行为正确。修订:**telemetry 保持现状,不改 reset 语义**(§8.3 的 telemetry bullet 撤销)。`_setRequestTelemetryFilePathForTests` 留作显式 opt-in。

### 11.2 已证实的真实问题(必须纳入实现)

- **R1 — `rawModels` 跨测试泄漏(无 reset 导出的游离状态)**。亲验 `state.ts:707`:`rawModels` module-scoped、**不在 mutableState**、`setModels()` 写、`snapshot/restoreStateForTests` **碰不到**、无 reset 导出。subagent 探针实证 t1 `setModels` 残留到 t2。**修复:加 `resetRawModelsForTests()` 导出并入 RESETTERS**。教训:「枚举 `*ForTests` 导出」的 L1 守卫**抓不到无导出的游离状态**——所以完整性不能只靠枚举导出,补救是先给每个 module-global 补 reset 导出(无导出=守卫盲区)。
- **R2 — RESETTERS 手列已漂移(漏 ≥4 个)**。除 R1,审计漏:`setUpstreamWsConnectionFactoryForTests`(注入的 WS factory 不复位→跨测试复用 mock)、`__setTerminalWriterForTests`(同理)、`resetHistoryPersistErrorStats`(persist-guard,错误计数跨测试)、config 的 `resetConfigCache`/`resetApplyState`(config 域)。**「§8.7 靠人记加一行」当场被证伪**。修复:**加 L1 完整性守卫**(枚举 src 全部 `(reset|set)*ForTest(s|ing)` 导出 + 已知无导出游离态清单,断言每个要么在 RESETTERS、要么在显式豁免清单(setter 语义如 `setBundledConfigForTests`/`_setRequestTelemetryFilePathForTests`/`setLearnedLimitsPathForTests`)),对标 `config-hot-reload.it` 完整性测试。
- **R3 — RESETTERS 必须支持 async**。`resetAnthropicFeatureNegotiationForTesting` 是 `async`;若 fixture 用它须 `await`。修订:fixture 默认用 11.1 的同步 `clear*` 变体规避;但 RESETTERS 类型仍定为 `Array<() => void | Promise<void>>` 且 afterEach **串行 await**(future-proof,防下个 async resetter 被 fire-and-forget)。
- **R4 — CODEX_HOME 是 floor + 守卫双盲区**。亲验 `paths.ts:20-22`:`computeCodexHome()` 读 `CODEX_HOME` env,**不读 `XDG_DATA_HOME`**→preload 的 XDG 重定向**覆盖不到 `~/.codex/config.toml`**。codex 测试存在(`setup-codex.unit`/`codex-config.unit`/`setup-claude-code.unit`)。**修复:preload 同时重定向 `CODEX_HOME` 到 sandbox**(`sandbox-paths.ts` 加一行);`sandbox-paths.unit` 守卫加断言 `CODEX_CONFIG_TOML` 在 sandbox;端到端守卫行使 codex writer。
- **R5 — Q4 afterEach 顺序耦合(真实条件性)**。subagent 探针证实:`autoRestoreState`(call-time 快照)与新 fixture(per-test 快照)在同文件并存、且注册顺序使旧的陈旧 call-time 快照后跑胜出时,会覆盖正确基线(典型成因:`beforeAll` 设基线)。**修复:P2 迁移强制「新 fixture 取代旧 primitive,同文件不并存」**(原子替换,非叠加);并定 commit invariant。
- **R6 — network guard seam 必须钉死 `setUpstreamFetchForTests`**。https 热路径走 `http2Fetch`(`upstream-fetch.ts:59-62`)绕过 globalThis.fetch;guard 只 hook globalThis.fetch 会漏。须复用 `mock-fetch.ts` 的 bridge seam(`setUpstreamFetchForTests`)覆盖 http2+undici 双路径。**e2e 豁免要写成契约**(e2e 不进 fixture→天然豁免;record 模式若 fixture 化须 `network:"passthrough"`),非靠侥幸。
- **R7 — `:memory:` 的两个交互须文档化**。(a) `bootstrapTestRuntime` 的 module-level `initialized` once-flag × fixture `history` opts:per-describe 切 tempfile 会被 once-flag 吃掉(第二个 describe 的 bootstrap no-op);fixture 须绕过 once-flag 或显式 reopen。(b) `:memory:` 默认使经 bootstrap 的 .http 不再覆盖**真实 db 文件打开路径**(mkdir/WAL/`maybeVacuumOnStartup`)——这条生产路径(`state.ts:66`)迁移后**只剩 tempfile 测试(`vacuum.it`/`search-backfill.it`/`incremental-recovery.it`)覆盖**;承认这是覆盖面收缩(非纯收益),靠保留这些 tempfile 测试扛住真实路径回归。
- **R8 — floor/fixture 的 fs 职责边界写清**。floor(preload XDG/CODEX 重定向)=**全局 fs 根重定向**,fixture=**per-test runtime/state/network/单例 reset**,fixture **不**再做通用 fs 路径 override(fs 隔离归 floor)。文档明示这条边界,避免「fixture 名为 isolated 却把 fs 全甩给 floor」名实不符的困惑——这是有意分层:floor 管 fs 地板,fixture 管进程内状态。
- **R9 — real-state-guard 收窄**。动态 writer 守卫与已落地 `sandbox-paths.unit`(静态断言 PATHS 落沙箱)职责部分重叠;增量价值仅在「writer 是否真读了被沙箱的 PATHS」(尤其有独立 seam 的 `learned-limits`)。收窄到行使**每个有独立路径变量的 writer**(learned-limits、telemetry、negotiation、history、**COPILOT_LOG/FileSink**、**codex**),不重复 PATHS 静态守卫已覆盖的。

### 11.3 修订后的 P0–P4(取代 §9)— 落地态

进度图例:`[done]` 已落地 / `[wip]` 进行中 / `[deferred]` 暂缓(原因附后)。

- **P0 `[done]` — src seam + 去副作用**(8.3+8.4 的 src 侧):加 `setLearnedLimitsPathForTests`(engine.ts);negotiation **新增同步 `clearAnthropicFeatureNegotiationForTests`**(既有 async drain-reset 不动,11.1);加 `resetRawModelsForTests`(R1);bootstrap 走 `:memory:` + 修撞谎注释;preload 加 `CODEX_HOME` 重定向 + `sandbox-paths.unit` 加 codex 断言(R4)。**落地 commit**:`1c979a6`(P0a CODEX)/`8f2839f`(P0b seam)/`cc20561`(P0c :memory:)。全 backend 2960 pass。
  *注*:telemetry reset **未改**(11.1 证伪:floor 下 re-point 即 sandbox,非泄漏)。
- **P1 `[done]` — 统一 fixture + L1 守卫**(8.2 修订版):`tests/helpers/isolated-fixture.ts`(`useIsolatedRuntime`);RESETTERS=`Array<{name, reset}>` 串行 await(R3);network guard reject(不 throw)钉 `setUpstreamFetchForTests`(R6);RESETTERS 收全 13 项(含 http2-factory,R1/R2);L1 守卫 `tests/infra/resetters-complete.unit.test.ts`(R2)+ fixture 自测。**落地 commit**:`3d1b663`。全 backend 2968 pass。
- **P2 `[wip]` — 分域迁移**(按 `tests/<域>/` 分批,`useIsolatedRuntime()` 原子取代旧 primitive,R5 不并存):
  - `[done]` **models 域**(`9006e1b`,107 pass)——示范 setModels→rawModels 泄漏被 fixture 修。
  - `[done]` **低碰撞 batch 2**(`5dcf7fc`):infra/management-routes、anthropic/web-search(orchestrator/backends/web-search)、pipeline(route-matrix/payload-rewrite-registry)——autoTestRuntime+autoRestoreFetch(+autoRestoreState)原子取代;web-search 用 applyFetchMock 覆盖 network guard 实证不误伤。全 backend 2971 pass。
  - `[deferred]` **anthropic/openai/responses/gemini/pipeline 流式域**(~13 文件):被**并发的 L2 pipeline 会话**正在活跃编辑(anthropic-v4/streaming-l2-baseline、chat-completions-v4、responses-v4/ws、gemini-v4、pipeline/buffered-sink、helpers/sse),同文件并发改动会真实冲突。**暂缓至 L2 会话收敛后**再迁,非降级——迁移机械、pattern 已立(见 models/batch2 commit),任何人可续。
  - `[todo]` **autoRestoreState/autoRestoreFetch-only 的轻量文件**(纯 unit,不需全 runtime):是否迁移需逐个判断(useIsolatedRuntime 会起 runtime,对纯函数测试偏重);触碰 module-global 的才必须迁,否则旧 primitive 仍正确。
  *Invariant*:每批该域绿 + 全套件绿;未迁域走旧 primitive(新旧并存无害,旧 primitive 不删)。
- **P3 `[done]` — 端到端 writer 守卫**(R9 收窄版):`tests/infra/real-state-guard.it.test.ts` 行使 negotiation/learned-limits writer 断言落点含 SANDBOX_MARKER 且不在真实 home(可证伪)。**落地 commit**:`6e6fae1`。
- **P4 `[wip]` — 收尾**:`[done]` DESIGN.md 回填默认隔离纪律(`0b145bf`);`[todo]` P2 全迁完后删被取代的死 primitive(`autoTestRuntime`/`autoRestoreState`/`autoRestoreFetch`,判据=删后 typecheck+全套件绿)、更新本 RFC→完全落地、维护 memory。*注*:`docs/coding-conventions.md` 不存在(CLAUDE.md 引用但未建),纪律回填进 DESIGN.md §测试组织;CLAUDE.md 有大量预存未提交外来改动,未触碰避免裹入。
