---
name: test-isolation
description: 当写/调 copilot-api-js 后端测试遇隔离问题时使用——bun 单进程跨文件单例泄漏、mock.module 无 teardown、测试污染真实 $HOME/~/.claude、Cannot use closed database、network guard、新增 module-global 单例。含 useIsolatedRuntime/RESETTERS/sandbox-paths preload/后缀分层与脚本速查。
---

# 测试隔离速查

后端测试两维度：功能域目录镜像 `src/lib/`，隔离后缀控速度。脚本走 `bun run`（非 npm）：`test:backend`=unit+it+http、`test:unit/it/http` 按后缀、`test:e2e*/ui` 单列。

## 选用

| 测试类型 | 用 | 给出 |
|---|---|---|
| `.unit`（纯函数） | `autoRestoreState()` / `autoRestoreFetch()` | 轻量快照还原 |
| `.it`/`.http`（起 runtime/app） | `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()` | history `:memory:` + state 快照 + afterEach reset RESETTERS + 未 mock 上游即 reject |

**别**同文件叠加 `autoRestoreState()` 与 `useIsolatedRuntime()`（快照时机互覆盖）。

## 铁律

- 用 DI/fetch-mock，**不用 `mock.module`**（进程级无 teardown）。
- fs I/O 用注入临时目录，**绝不写真实 $HOME/~/.claude/~/.local/share/copilot-api**。**Bun `os.homedir()` 忽略 `process.env.HOME` mutation**（运行时返回真实 `/home/xp`）——只能 DI `options.home`/paths 或 preload 沙箱隔离，绝不靠 env mutation、绝不把 `mock.module("node:os")` 当接缝（"修复/移除" mock 前先问它是否还承担 fs/网络封闭）。两次真实事故：把 `mock.module("node:os")` 换成 `process.env.HOME=tempDir` → `writeClaudeCodeConfig()` 覆盖真实 `~/.claude.json`；13 个 negotiation 测试里 9 个没沙箱 `PATHS.NEGOTIATION_STATES`、`resetAnthropicFeatureNegotiationForTesting()` 把空 map 持久化 → 每次 `bun test` 擦盖真实 `negotiation-states.json`、用户重启重学 beta（诊断靠 history 探针 + 未沙箱测试看真实文件 mtime，见 skill `empirical-verification`「记录消失」；paper-analysis 曾误判"无问题"被实测推翻）。**任何"test reset/teardown 助手持久化到磁盘"都是危险信号**：它写 `PATHS.X`、未沙箱即真实文件。
- 新增 module-global 单例 → 提供 `reset*ForTests` 并登记 `RESETTERS`，否则 `resetters-complete.unit.test.ts` 守卫 fail。

## 地板防线

`bunfig.toml` `[test].preload`（`tests/helpers/sandbox-paths.ts`）把 `XDG_DATA_HOME`+`CODEX_HOME` 重定向临时目录，兜住 APP_DIR 派生持久化（仅 bun test）。双守卫 sandbox-paths.unit + real-state-guard.it。完整设计 docs/spec/test-env-isolation.md（权威落地态）、DESIGN「测试组织」。相关经验 [[feedback_tests_never_touch_real_env]]、[[methodology-sync-to-async-persistence-refactor-invariants]]。

## 流式 / 时序测试（heartbeat 等异步注入）

测流式 handler 的异步注入(sink heartbeat、延迟-commit)用 `FakeClock`(tests/helpers/fake-clock.ts:拦 setTimeout/Date.now,`advance(ms)` 逐 due-timer fire + drain 2 microtask 让 await settle)。**mid-stream 场景**(上游发部分帧后静默):mock fetch 返回 `Response(ReadableStream)`、**test 持有 controller** 精确控帧——`ctrl.enqueue(block_start)` + `await Promise.resolve()×N` drain microtask 让 pump 消费到(内部状态如 openBlock 更新)、再 `clock.advance` 触发 timer、再 `ctrl.enqueue(rest)` + `close`。**坑**:注入的心跳帧落在预期 block **之前** = drain 步数不够(pump 还没 write 到那帧)、**非 bug**;分步 drain 修(生产中静默发生在 block 已 write 之后)。ReadableStream pull 走 microtask(FakeClock 不拦)故 drain 有效;但依赖 drain 步数本质**脆弱**,连跑 10 次确认确定性(见 user-level `verifying-authoritative-claims` flaky)。活案例 tests/anthropic/keepalive-e2e.http、stream-immediate-keepalive.http。证明「改的代码真被执行」的活路径/分层验证见 skill `empirical-verification`。