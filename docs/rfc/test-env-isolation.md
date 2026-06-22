# RFC: 测试环境隔离机制全面重写

**Status:** 调研/草案 — interim floor 已落地(commit `737f9a4`),全面重写待新会话推进。
**Date:** 2026-06-22
**Owner:** TBD(新会话继续)

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
