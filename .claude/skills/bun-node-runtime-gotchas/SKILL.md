---
name: bun-node-runtime-gotchas
description: 当 copilot-api-js 在 Bun/Node 双运行时下遇到「stdlib/Web 标准行为诡异」时使用——undici.Response≠globalThis.Response（instanceof 跨 realm 假失败、Bun 下恰好相等掩盖 Node bug）、new Headers 对异大小写同名键逗号拼接非覆盖（头合并畸形双 Bearer）、bun:sqlite `.get()` 返 null 而 node:sqlite 返 undefined、触发器写入被计入 `.run().changes`。凡「Bun 能跑 Node 挂」或「两 runtime 行为分歧」的排查。
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

## 通用手法

- 任何「Bun 能跑 Node 挂 / 两 runtime 分歧」怀疑：写最小 `bun -e` / node 探针**两 runtime 各跑一遍**实测（放 `exp/`），别信「bun test 绿」——它单跑 Bun 掩盖 Node 分歧。见 skill `empirical-verification`、`verifying-authoritative-claims`。
- 依赖选型 bun-first：外部库须两 runtime 原生可跑，见 ADR `docs/decisions/2026-07-05-dependency-selection-bun-first.md`。
