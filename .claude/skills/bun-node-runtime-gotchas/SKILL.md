---
name: bun-node-runtime-gotchas
description: 当 copilot-api-js 在 Bun/Node 双运行时下遇到「stdlib/Web 标准行为诡异」或 Bun 独有 API 能力边界时使用——undici.Response≠globalThis.Response（instanceof 跨 realm 假失败、Bun 下恰好相等掩盖 Node bug）、new Headers 对异大小写同名键逗号拼接非覆盖（头合并畸形双 Bearer）、bun:sqlite `.get()` 返 null 而 node:sqlite 返 undefined、触发器写入被计入 `.run().changes`、Bun.Terminal 伪终端不给子进程投递 SIGWINCH+stdout.rows 不刷新（PTY 测 resize 恒绿假测）、node-pty 在 bun 下 spawn 语义损坏。凡「Bun 能跑 Node 挂」「两 runtime 行为分歧」或「Bun 独有 API 悄悄不工作」的排查。
---

# Bun / Node 跨运行时 stdlib 陷阱

本项目 bun-first 但 history 走 bun:sqlite（一等）/ node:sqlite（兼容）双驱动、上游 fetch 走 undici（见 skill `debugging-ghc-api-upstream-transport`），故常撞「同一 API 两 runtime 行为分歧」。这类 bug 的共性：**Bun 下恰好成立会掩盖 Node 路径的 bug**，`bun test` 测不到。判据永远是**实测两 runtime**，别凭直觉。

## undici.Response ≠ globalThis.Response（别用 `instanceof Response` 跨 realm）

**Node 运行时下** `import { Response } from "undici"` 与 `globalThis.Response`（lib.dom）是**两个不同的类**：`undici.Response === globalThis.Response` 为 **false**，`undiciFetch(...)` 返回对象 `instanceof globalThis.Response` 为 **false**（`instanceof undici.Response` 才 true）。**Bun 下相反**：Bun 的 fetch shim 返回全局 Response，`undici.Response === globalThis.Response` 为 true——所以 `instanceof Response` 在 Bun 下「恰好」成立，**掩盖** Node 路径的 bug。

**陷阱（C2 实例）**：`web-search/backends.ts` 曾用 `response instanceof Response` 判别 fetch 成功（配 `.catch(e=>e)` 把 reject 转 Error）。改走真 undici（`upstream-fetch.ts`）后，Node 下成功的 undici Response `instanceof globalThis.Response===false` → 成功搜索被误判为失败。`bun test` 测不到（Bun 下 instanceof 恰好成立 + mock 桥返回全局 Response 双重掩盖）。

**修法**：别用 `instanceof Response` 跨 undici/lib.dom 边界判身份。用**结构判别**——这里改 `instanceof Error`（reject 必为 Error，见 fetch 规范），成功分支 `as Response` cast（两者成员级结构兼容、只是名义类型不同）。成员访问（`.ok/.status/.headers.entries()/.json()/.text()/.body`）在两者上都兼容，**只有 `instanceof` 身份判别会坑**。grep 全仓 `instanceof Response` 确认无遗漏。

## new Headers 对异大小写同名键**逗号拼接**（非覆盖）

`new Headers(record)` 对**异大小写同名键**做**逗号拼接**（Bun + Web 标准，`bun -e` 实测）：

```
new Headers({ authorization: "Bearer A", Authorization: "Bearer B" })
  → get("authorization") === "Bearer A, Bearer B"   // 拼接！
```

普通 JS 对象 `{ authorization, Authorization }` 是**两个不同键**，`{ ...low, ...High }` spread 两个都保留；只有到 `new Headers(obj)` 这一步才按 lowercased 折叠、且**拼接**而非取一个。

**后果与护栏**：任何「合并两组头再 `new Headers`」的代码，**绝不能靠 spread 顺序实现"某组优先"**——异大小写撞键会把两边值拼起来（客户端 `authorization` + 代理 `Authorization` → 畸形双 Bearer，把客户端凭证拼给上游）。正确做法：merge **之前**按 **lowercased** 把要让位那组里所有与优先组同名（lowercased）的键**剔除干净**，使两组按 lowercased 无交集。落地于 `anthropic.strict_request_headers` 透传（`buildAnthropicHeaders` + `selectPassthroughHeaders`）：`coreLower = new Set(Object.keys(core).map(toLowerCase))` 从**实际构造出的** core 对象动态取键，据此剔除 passthrough 里所有 core 键后才 `{...pass, ...core}`。两轮 plan review 中这是被推翻的 CRITICAL 假设（最初以为 spread 顺序=优先）。用真实 `new Headers` 实测裁决，别凭直觉。

## bun:sqlite `.get()` 返 null / 触发器写入计入 `.changes`

两个跨 runtime 分歧（实测 `exp/fts-audit/`）：

1. **`.get()` 无匹配的哨兵值分歧**：bun:sqlite 返 **`null`**，node:sqlite 返 **`undefined`**。故 `prepare(...).get() !== undefined` 在 Bun 下对「无行」恒为 `true`（`null !== undefined`）——曾用它做 FTS 表存在性判定，导致 backfill 永不触发。**判存在一律用真值检查 `Boolean(row)` / `if (!row)`，绝不用 `=== undefined`/`!== undefined`**（项目 eslint `eqeqeq` 还禁 `!= null`）。codebase 既有多用 `row ? ... : undefined` 或 `if (!row)`，是对的；strict undefined 比较是 outlier。

2. **触发器写入被 bun:sqlite 计入 `.run().changes`**：一条 UPDATE/DELETE 若触发 AFTER 触发器写别的表，bun 的 `.run().changes` 把触发器侧写入也算进去（实测 1 行真实 UPDATE + FTS 触发器 → changes=9/19；node:sqlite 只算 1）。**凡带触发器/级联的表，行数用 `SELECT COUNT(*)` 单独数，别读 `.changes`**（`reclaimStaleActiveRows`/`reclaimOrphanedActiveRows` 已改 COUNT+UPDATE 同事务；`evictBucket` 早因 `ON DELETE CASCADE` 同理避开）。

> history 的 external-content **FTS5 三陷阱**（COUNT 穿透、`'delete'` 腐败、VACUUM renumber rowid）是 history 专有，见 skill `history-sqlite-schema`。

## Bun.Terminal 伪终端：node-pty 损坏 + 子进程感知不到 resize（PTY 测试）

`tests/tui/pty/` 用 `Bun.Terminal`（Bun 1.3.14 内置伪终端）spawn 真 `TerminalUi` driver、输出喂 `@xterm/headless` 解释成网格，测 raw-mode TUI 的整屏效果（不吞行/footer 钉底/退出还原/切 detail）。三条实测踩出的坑（PoC `exp/poc-js-pty-grid/`、spec/plan `2026-07-14-tui-pty-terminal-grid-testing`）：

1. **node-pty@1.1.0 在 bun 下 spawn 语义损坏**：能装、能加载 N-API addon，但 `spawn` 的子进程提前退出、stdout 非 TTY、`resize` 抛 `ioctl EBADF`（同 addon 在 Node v24 正常）。**别在 bun 用 node-pty**——用 Bun 内置 `Bun.Terminal`（`new Bun.Terminal({cols,rows,data(t,bytes){}})` + `Bun.spawn([...],{terminal})`）。

2. **`Bun.Terminal.resize()` 不给子进程投递 SIGWINCH、子进程 `process.stdout.rows` 不刷新**（亲手实测）：resize 伪终端 24→30 后，子进程 `process.on("SIGWINCH")` **got=0**、`process.stdout.rows` **始终读 24**（INIT/AFTER/FINAL 全 24）。故 driver 里的真 `TerminalUi.getRows()` 恒返回旧值 → `region.render` 的 `geometryChanged` resize 分支**从不执行** → 任何「resize 重锚」测试都是**恒绿假测**（红样本删源码也不 FAIL）。曾被「稳定 6/6 绿」误导——实为 resize 从没生效（呼应 `verifying-authoritative-claims`「通过不自证」）。**后果**：PTY 测能覆盖滚动/备用屏/退出还原/切视图，但**测不了 resize 重锚**（降 backlog，见 `docs/todo/deferred-backlog.md`）。

3. **`@xterm/headless` 的 `terminal.resize()` reflow 丢 scrollback 行**（时好时坏）：作观察器时**别 resize xterm**，用一个**固定的大观察窗口**（rows 传足够大值）让子进程前后输出都落同一稳定网格。读 buffer 三前提固定：`allowProposedApi:true`、等 `write(data,cb)` 的 cb、遍历 `0..buffer.active.length-1`（含 scrollback）。

> PTY 整屏测试的通用方法论（正样本红绿对照、连跑证时序确定性、pyte/xterm 网格解释）见 user-level skill `pty-terminal-ui-testing`；本节是它在 Bun.Terminal 上的落地限制。

## 通用手法

- 任何「Bun 能跑 Node 挂 / 两 runtime 分歧」怀疑：写最小 `bun -e` / node 探针**两 runtime 各跑一遍**实测（放 `exp/`），别信「bun test 绿」——它单跑 Bun 掩盖 Node 分歧。见 skill `empirical-verification`、`verifying-authoritative-claims`。
- 依赖选型 bun-first：外部库须两 runtime 原生可跑，见 ADR `docs/decisions/2026-07-05-dependency-selection-bun-first.md`。
