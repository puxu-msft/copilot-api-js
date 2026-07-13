---
name: reference-picocolors-collapses-to-identity-in-bun-test
description: bun test 下 pc.isColorSupported===false 使 picocolors 全部塌缩成恒等函数，配色断言自证；改测 color-fn 引用相等 + FORCE_COLOR 子进程
metadata: 
  node_type: memory
  type: reference
  originSessionId: 51ce97e2-5fa8-4d1e-b795-9d95afd9134d
---

在 bun test 进程内，`picocolors` 的 `isColorSupported === false`（非 TTY），此时不仅 `pc.dim(s)` / `pc.yellow(s)` / `pc.red(s)` **全部塌缩为恒等函数**（返回原串 `s`），而且更微妙一层——**所有单色函数塌缩成同一个 `String` 引用**：实测 `pc.white === pc.yellow === pc.red === pc.dim === String` 全 `=== true`。后果分两层：① `expect(fn(x)).toBe(pc.red("x"))` 形式的**配色断言退化成纯文本断言**；② 连 `expect(colorFn).toBe(pc.white)` 形式的**引用相等断言也退化成 `.toBe(String)`**——单色档之间无法区分、抓不到 always-red 变异。verification 簇「通过性断言不自证」在**终端配色**域的高发陷阱，与 [[feedback-pass-null-clean-not-self-validating]] 同构。

**实证**：TUI 请求历史行的 `cacheHitColor`（≥80 dim/≥40 黄/≥20 红/<20 粗红）与 `durationColor`（≤20s 白/≤60s 黄/≤180s 红/>180s 粗红）两个阈值配色函数，用 `pc.dim("↻80%")` 等构造期望的单测有 30 条，把两函数体**同时变异成无条件 `return pc.red`** 后 **30/30 照过**（reviewer 变异测试抓到）。二次修复时误以为「单色档 `.toBe(pc.white)` 引用相等能抓」，实测证伪：color-off 下 `pc.white===pc.red===String`，该断言 in-process 恒真。（配色演进踩了两坑：① duration ≤60s 档曾用 `dim(yellow)`，终端把 `dim` 渲染成灰、色相被压反而更不显眼，severity 倒挂——`dim` 只该用在最不重要端；② 改 magenta 后与 log 行的 model 名 `pc.magenta` **撞色**。最终两色阶统一共享 `黄→红→粗红` 升阶、只在最不告警端各异（cache 良好 dim / duration 快 white）。）

**正确测法（真抓回归，分工明确）**：
- **单色档权威交给 FORCE_COLOR 子进程集成测试**（in-process 无法区分单色档）：`Bun.spawnSync(["bun","-e",script],{env:{...process.env,FORCE_COLOR:"3"}})` 子进程渲染真源码（非 mock），对**每一档**断言确切 SGR 字节（dim `\e[2m…\e[22m`、white `\e[37m…\e[39m`、yellow `\e[33m…\e[39m`、red `\e[31m…\e[39m`、bold-red `\e[1m\e[31m…\e[39m\e[22m`）。注意 bold-red 字节**包含**平红片段作子串，「非平红」不能用 `.not.toContain(red)`，靠正向 `.toContain(boldRed)` 反证（退化平红丢头部 `\e[1m` 使正向 fail）。
- **补边界值 case 闭合 off-by-one**：集成测试须打到每个阈值两侧（`durationMs: 180_000`（含 red）/ `180_001`（bold-red）、cache 恰好 80/40/20%），否则 `<=180_000`→`<180_000` 之类边界变异用代表值（45s/120s/200s）两侧都抓不到。实测该 case 精确抓住此边界变异。
- **组合档 in-process 用排除法**（唯一 env-无关的 in-process 信号）：`bold(red)` 这类每次新建的闭包 `!== String`，`expect(cacheHitColor(19)).not.toBe(pc.dim/yellow/red)`（duration 同法 `durationColor(180_001)`）钉住「路由到组合分支、未塌缩成单色」；always-red 变异使其返回 `String` → fail。注意：**只有含组合档的函数**才有此 in-process 信号——纯单色档函数（若无 bold-red 之类组合）其覆盖**完全**靠 FORCE_COLOR 集成测试。
- **变异自证**：改被测函数为错色/错边界，确认新测 fail（本例：无条件 red → 13 fail；`<=180_000`→`<180_000` 边界 → 1 fail；bold-red→平 red → 3 fail；还原 → 0 fail）。

活范例：`tests/tui/log-line-color.integration.test.ts`（FORCE_COLOR 全档 + 边界 SGR，权威）+ `tests/observability/format.unit.test.ts`（组合档 `.not.toBe` in-process 路由守卫）。同样陷阱适用任何 picocolors/chalk 着色的纯函数单测。**Related**: [[feedback-pass-null-clean-not-self-validating]]、skill `empirical-verification`。
