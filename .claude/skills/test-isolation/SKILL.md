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
- fs I/O 用注入临时目录，**绝不写真实 $HOME/~/.claude/~/.local/share/copilot-api**。
- 新增 module-global 单例 → 提供 `reset*ForTests` 并登记 `RESETTERS`，否则 `resetters-complete.unit.test.ts` 守卫 fail。

## 地板防线

`bunfig.toml` `[test].preload`（`tests/helpers/sandbox-paths.ts`）把 `XDG_DATA_HOME`+`CODEX_HOME` 重定向临时目录，兜住 APP_DIR 派生持久化（仅 bun test）。双守卫 sandbox-paths.unit + real-state-guard.it。完整设计 docs/spec/test-env-isolation.md（权威落地态）、DESIGN「测试组织」。相关经验 [[feedback_tests_never_touch_real_env]]、[[methodology-sync-to-async-persistence-refactor-invariants]]。