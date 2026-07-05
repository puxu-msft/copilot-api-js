---
name: feedback_tests_never_touch_real_env
description: "测试绝不能写入真实的用户配置/环境;使用依赖注入,而非 process.env mutation;运行前先验证"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2cc513ee-b169-4c19-a99a-9041eaf57d8d
---

一个针对 `setup-claude-code` 的测试(位于 `tests/`)在测试运行期间写入了用户的**真实 `~/.claude.json` / `~/.claude/settings.json`**。原因:我把一个 `mock.module("node:os")`(它曾安全地把 `homedir()` 重定向到一个临时目录)替换成了运行时的 `process.env.HOME = tempDir`——但 **Bun 的 `os.homedir()` 并不会在调用时重新读取 `process.env.HOME`**(它返回了真实的 `/home/xp`),于是 `writeClaudeCodeConfig()` 覆盖了真实配置。用户理所当然地警觉了("严重的问题... 实验不要直接修改了真实环境配置")。

**Why:** 我把一个 `mock.module` 单纯当作需要移除的跨文件泄漏,忽略了它还承担着一个**安全隔离**的用途(把 fs 写入隔离在真实 home 之外)。而且我在没有先证明它已被隔离的情况下,就对着真实环境运行了这个有缺陷的测试。

**How to apply:**
- 一个会对 `$HOME`/配置路径做真实文件 I/O 的测试,必须通过**依赖注入**来隔离——给函数一个 `options.home`(或 paths)参数,并传入一个 `mkdtemp` 临时目录。绝不依赖 `process.env.HOME` mutation(Bun 的 `os.homedir()` 在运行时忽略它),也绝不把 `mock.module("node:os")` 当作接缝。
- 在"修复"/移除任何 `mock.module` 之前,先问它是否提供了**安全隔离**(fs/网络封闭),而不只是文件间隔离——若是,则替代方案必须保留那层封闭。
- **在执行任何可能触及真实用户状态的操作前,先证明隔离**:确认该代码路径只能命中临时/沙箱位置。拿不准时,先取得用户确认(他们说过:未确认不动手)。
- 对于 CLI 本身,要尊重已有配置:检测已存在的自定义配置,展示直观的 `+/~/-` diff,在破坏性覆盖前确认,并区分"essential"(默认写入)与"extension"(仅 opt-in)设置。与 CLAUDE.md `architecture-health-first` 和 CLAUDE.md `architecture-health-first` 相关。

**第二次实例(2026-06-22):测试静默擦掉真实 negotiation 缓存。** 用户报告"重启后仍重学 beta",我先**纯靠读代码给了错误的"已确认无问题"**(load/persist/key 逻辑都对)——被实测推翻(`feedback-pass-null-clean-not-self-validating` / `empirical-verification`:否定性/通过性"确认"必须实测,绝不靠 paper-analysis 下结论)。真因:13 个 mark/reset feature-negotiation 缓存的测试里 9 个没沙箱 `PATHS.NEGOTIATION_STATES`,而 `resetAnthropicFeatureNegotiationForTesting()` 会把(清空后的)map 持久化到磁盘——于是任何一次 `bun test`(我本会话跑了多次)都把空快照写盖真实 `~/.local/share/copilot-api/negotiation-states.json`,擦掉所有学到的 beta/partner-feature/effort,用户每次重启都重学。诊断靠 history API 探针 + 运行日志(load 从不打印 "Loaded N" = 启动即空)+ 直接跑一个未沙箱测试看真实文件 mtime 变化坐实。

**How to apply(沙箱的地板修法,优于逐测试 DI):**
- APP_DIR 派生的持久化(本项目 `XDG_DATA_HOME`→`config/paths.ts` 的 `PATHS.*`)用**全局 bun-test preload** 一次性兜底:`bunfig.toml` 的 `[test].preload` 注册一个在任何 src 模块算 `PATHS` 之前就把 `XDG_DATA_HOME` 重定向到 `mkdtemp` 临时目录的脚本(`tests/helpers/sandbox-paths.ts`)。`[test].preload` 只作用于 `bun test`、**不影响 `bun run start`/生产**(顶层 `preload` 才会作用于所有 `bun` 运行——别放顶层)。这保护**每一个**测试(含未来新增)+ 每一个 APP_DIR 文件(negotiation/history.db/logs/learned-limits/telemetry),逐测试 DI 沙箱仍可在其上叠加覆盖。配一个守卫测试(`tests/infra/sandbox-paths.unit.test.ts`)断言 `PATHS.*` 落在沙箱内,防 preload 静默失效。
- 任何"test reset/teardown 助手会持久化到磁盘"都是危险信号:它写的是 `PATHS.X`,未沙箱即真实文件。
