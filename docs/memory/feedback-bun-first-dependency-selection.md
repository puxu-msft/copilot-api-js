---
name: feedback-bun-first-dependency-selection
description: 外部库选型必须 bun-first——所选库本身要能在 Bun 下原生工作；开发/运行命令 bun-only 没问题，Node 只是兼容目标
metadata:
  node_type: memory
  type: feedback
---

用户陈述的约束（2026-06-17）：**"开发命令可以只是 bun 的，native 只是兼容目标，所有选择的外部库也要满足 bun first"**。

> **已固化为 ADR**：[docs/decisions/2026-07-05-dependency-selection-bun-first.md](../decisions/2026-07-05-dependency-selection-bun-first.md)——这是真正的用户决策，决策背景/理由/备选方案以该 ADR 为权威源。本条保留原始出处（引语+日期）与审计手法。

**Why:** 项目是双运行时抽象（`typeof globalThis.Bun !== "undefined"` 分流：`Bun.serve`/`@hono/node-server`、`hono/bun`/`@hono/node-ws`、`bun:sqlite`/`node:sqlite`、Bun 内建 fetch 超时/undici）。但优先级不对称——**Bun 是一等公民、默认运行时、被 `bun test` 实测覆盖；Node 是有意维护的兼容目标，但实测保障弱于 Bun**（Node 专属分支如 driver.ts 的 `nodeFactory()` 在 bun test 下走不到）。因此选型的底线是"在 Bun 下能不能原生跑"，而不是"在 Node 下能不能跑"。

**How to apply:**
- **拒绝 node-gyp 原生绑定（binding.gyp）。** 这是 Bun 最大的兼容痛点。既有正面实践：driver.ts 刻意不用 `better-sqlite3`（"`better-sqlite3` is not yet supported in Bun"，Bun 1.3 加载时直接拒绝），改用 Bun/Node 各自的内建 SQLite。引入新库前先确认它不含原生编译步骤。
- **node-only 库可以做兼容路径依赖，但不能进 Bun 的运行时热路径。** `undici`、`@hono/node-server`、`@hono/node-ws` 都是 dependencies，但只在 Node 分支被动态 `import()`；Bun 下不加载即不违反 bun-first。`undici` 的 `setGlobalDispatcher` 在 Bun 下本就是空操作（同主题见 skill `bun-upstream-transport`）。
- **审计手段（实测，非推断）：** `find node_modules -name binding.gyp`（应为空=零 node-gyp 依赖）；`find node_modules -name "*.node"`（当前命中的 @rollup/@rolldown/@oxc-* 都是**构建工具**的预编译二进制，只在构建期用、不进运行时 dist，不算违反）；`grep postinstall` 查编译型安装脚本。
- **现状结论（2026-06-17 审计）：** 完全符合——零 binding.gyp；运行时 dependencies 全纯 JS（hono/consola/citty/yaml/gpt-tokenizer/socks/undici…）；`.node` 文件仅限构建链。

Related: [[feedback-architecture-health-is-user-need]]、[[feedback_complete_root_cause_fix]]。
