# Upstream Hook v3 命名迁移 + client.inbound 实施计划

> **实施状态（2026-07-14）**：本 plan 现为大 RFC [2026-07-14-symmetric-four-point-hooks.md](../rfc/2026-07-14-symmetric-four-point-hooks.md) 的 **Phase 0（golden 预捕）+ Phase 1（命名迁移）** 详细版。**注意**：本 plan 的 Task 2（client.inbound）与 Task 3（剥块 helper）已被 RFC 升级——client.inbound 的真 client-native 依赖 RFC Phase 2/3（四格式 async 入站处理下沉 S1b），故 Task 2/3 **不在 Phase 0/1 执行**、须待 RFC Phase 3 后按 RFC Phase 4/5 重做（本 plan 的 Task 2/3 保留作参考、但 client.inbound 落点与四格式假设以 RFC 为准）。**只有 Task 0（golden）+ Task 1（纯命名迁移）是 Phase 0/1 的即可执行部分**。
> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 task 执行。步骤用 `- [ ]` 复选框追踪。
> **权威 spec**：[docs/spec/2026-07-12-upstream-hook-middleware.md](../spec/2026-07-12-upstream-hook-middleware.md)（v3，§12 迁移面为本计划之源）；**上位 RFC**：[docs/rfc/2026-07-14-symmetric-four-point-hooks.md](../rfc/2026-07-14-symmetric-four-point-hooks.md)（对称四点 + 统一翻译进 driver，本 plan 是其 Phase 0/1）。

**Goal**：把 **已上线 master（`118a9c33`）的** hook 机制从扁平三挂载点 `onRequest`/`onExchange`/`rewriteUpstreamFrame` 破坏性重命名为二维分组 `export const hooks = { client:{inbound}, upstream:{inbound,outbound}, exchange }`，并新增 client-native、pre-translate 的 `client.inbound` 挂载点（带 driver 强制防御性 body snapshot）+ 四格式剥块 helper。

**Architecture**：机制无任何使用方（内部工具、无向后兼容负担），故破坏性全量迁移、不留双轨。`UpstreamHook` 接口从 3 个扁平可选字段改为嵌套分组；hook 文件从 `export const onRequest/...` 改为 `export const hooks = {...}`；loader 从「pick 扁平具名 export」改为「读 `mod.hooks` 对象、遍历嵌套叶子」；driver 3 处 wire 改读嵌套 + 新增 client.inbound wire。`client.outbound` 仅 spec/文档预留、**不进类型、不建挂载点**（against-YAGNI）。

**Tech Stack**：TypeScript（strict）、Bun（`bun test`、`bun run typecheck`）、bun:sqlite（history）、Zod（config）。

## Global Constraints

- **无向后兼容负担**：破坏性重命名可全量迁移、不留旧名别名、不留双轨（spec 状态行）。
- **commit invariants（large-refactor 纪律）**：每 commit 终态 `bun run typecheck` 绿、**无半迁移态**——改 `UpstreamHook` 接口就在同一 commit 改所有 wire 点 + loader + 测试 fixture（TS 接口字段重命名会即刻打爆所有消费方，故 rename 必须原子）。
- **passthrough 字节等价不变量**：hook 未配置时 driver 输出必须跨迁移逐字节等价（Phase 0 预捕获 golden 作 oracle）。
- **provenance 硬化非依赖自律**：`client.inbound` 的客户端原样轨不污染，由 driver 强制防御性 body snapshot 保证（spec §3.5 决策 1），非依赖 codec 的 structuredClone 自律。
- **不碰无关命中**：ui-v4 `LiveDock`/`ShadcnLiveDock` 的 `onRequestsList`、`tui-retry-n-lines*.md` 的 `onRequestRetry` 与本机制无关（spec §12）。
- **显式 pathspec commit**：并发会话共存，`git add -- <精确路径>` / `git commit -- <精确路径>`（项目 CLAUDE.md）。
- **测试隔离**：不碰 4141 主服务器；hook 测试用 `setUpstreamHookForTests` DI 注入，不写真实 $HOME。

---

## 文件结构（迁移触点，源自 spec §12）

**真功能触点（改逻辑/接口）**：
- `src/lib/pipeline/hooks/types.ts` — `UpstreamHook` 接口嵌套化 + `UpstreamHookState.exports` 语义（叶子路径）。
- `src/lib/pipeline/hooks/loader.ts` — `HOOK_POINTS` → 叶子路径 + `mod.hooks` 对象遍历校验 + `setUpstreamHookForTests` 叶子枚举。
- `src/lib/pipeline/driver.ts` — 3 处 rename wire + 新增 `client.inbound` wire + 防御性 snapshot。
- `src/lib/pipeline/hooks/origin.ts` — 注释旧名（功能码不改）。
- `src/lib/pipeline/hooks/{index.ts,toolkit.ts,README.md}` — barrel/toolkit 注释 + README 承重警告改新名 + 新 helper。
- `src/routes/hooks/route.ts` — reload 回执 `exports` 叶子路径。
- 注释-only：`src/lib/pipeline/{frame-origin.ts,client-sink.ts}`、`src/lib/history/types.ts`。

**测试触点**：`tests/pipeline/hooks/*.test.ts`、`tests/pipeline/hooks/fixtures/valid-hook.ts`、`tests/routes/hooks.http.test.ts`、`tests/e2e-client/harness/cli-refusal-hook.ts`。

**文档触点**：ADR、DESIGN.md、deferred-backlog.md、skill `upstream-hook-mocking`、memory stub、旧 plan 文件夹 README 指针。

---

## Task 0：预捕获 passthrough golden（迁移前锁 byte-等价 oracle）

**Files:**
- Test: `tests/pipeline/hooks/driver-passthrough-golden.it.test.ts`（已存在，评估其是否已覆盖「hook 未配置=直通字节等价」；不足则补）

**Interfaces:**
- Produces：一个在**当前 master 代码**上运行、锁定「hook 未配置时 driver passthrough 输出」的 golden fixture，供 Phase 1-2 迁移后重放比对。

- [ ] **Step 1**：读现有 `tests/pipeline/hooks/driver-passthrough-golden.it.test.ts`，确认它断言的是「`getUpstreamHook()` 为 undefined 时，driver 对代表性输入（Anthropic 流式 + 非流式各一）的输出逐帧等价于无 hook 基线」。若它只测「有 hook 但直通」而非「无 hook」，补一个 `describe("no hook configured")`。
- [ ] **Step 2**：在**迁移前**跑 `bun test tests/pipeline/hooks/driver-passthrough-golden.it.test.ts`，Expected：PASS（作为迁移后回归基线）。
- [ ] **Step 3**：Commit（若有补测）
```bash
git add -- tests/pipeline/hooks/driver-passthrough-golden.it.test.ts
git commit -m "test(hooks): pin passthrough byte-equivalence golden before v3 migration"
```

---

## Task 1：`UpstreamHook` 接口嵌套化 + loader 遍历 + driver 3 处 rename wire（原子迁移）

> **原子性**：TS 接口字段重命名会即刻打爆所有消费方（driver wire + loader + 测试 fixture），故本 task 的 types/loader/driver/route/测试改动**必须在能编译的最小闭包内一起完成**——中途 `bun run typecheck` 允许红，但 task 结束的 commit 必须绿（commit invariant）。

**Files:**
- Modify: `src/lib/pipeline/hooks/types.ts`
- Modify: `src/lib/pipeline/hooks/loader.ts:35`（`HOOK_POINTS`）+ `:31-33`（`setUpstreamHookForTests`）+ `:50-55`（exports 过滤/组装）
- Modify: `src/lib/pipeline/driver.ts:257`（onRequest）、`:397`（onExchange）、`:549-550`（rewriteUpstreamFrame）
- Modify: `src/routes/hooks/route.ts`（exports 回执语义）
- Modify: `src/lib/pipeline/hooks/{index.ts,origin.ts,toolkit.ts}`（注释旧名）+ `src/lib/pipeline/{frame-origin.ts,client-sink.ts}`、`src/lib/history/types.ts`（注释旧名）
- Modify: `tests/pipeline/hooks/fixtures/valid-hook.ts`、`tests/pipeline/hooks/*.test.ts`、`tests/routes/hooks.http.test.ts`、`tests/e2e-client/harness/cli-refusal-hook.ts`、`tests/e2e-client/anthropic-cli.e2e.test.ts`（fixture/断言改新导出形状；**评审 MEDIUM 补漏**：`anthropic-cli.e2e.test.ts:56` 的 `expect(loaded.exports).toContain("onExchange")` → `toContain("exchange")`，否则 Step 9 残留 grep 会绊在这个漏改文件上）

**Interfaces:**
- Produces：
```ts
// types.ts — 嵌套分组接口（client.outbound 不入类型：预留、不建挂载点）
export interface UpstreamHook {
  client?: { inbound?: (env: RequestEnvelope) => RequestEnvelope | undefined }
  upstream?: {
    inbound?: (frame: UpstreamFrame, env: RequestEnvelope) => UpstreamFrame | undefined  // 旧 rewriteUpstreamFrame
    outbound?: (env: RequestEnvelope) => RequestEnvelope | undefined                      // 旧 onRequest
  }
  exchange?: (wire: PreparedRequest, env: RequestEnvelope, next: () => Promise<UpstreamStream>) => Promise<UpstreamStream>  // 旧 onExchange
}
// loader.ts — 叶子路径
const HOOK_POINTS = ["client.inbound", "upstream.inbound", "upstream.outbound", "exchange"] as const
```
- 迁移映射：`onRequest`→`upstream.outbound`、`onExchange`→`exchange`、`rewriteUpstreamFrame`→`upstream.inbound`。

- [ ] **Step 1（测试先行）**：改 `tests/pipeline/hooks/fixtures/valid-hook.ts` 与 `tests/pipeline/hooks/loader.unit.test.ts`，把 fixture 导出从 `export const onExchange = ...` 改为 `export const hooks = { exchange: ... }`，断言 loader 读 `mod.hooks` 后 `exports` 为叶子路径 `["exchange"]`（及多叶子用例 `["client.inbound","upstream.inbound","exchange"]`）。
- [ ] **Step 2**：跑 `bun test tests/pipeline/hooks/loader.unit.test.ts`，Expected：FAIL（loader 仍读扁平具名 export、`mod.hooks` undefined）。
- [ ] **Step 3**：改 `types.ts` 为上述嵌套接口；改 `loader.ts`：`HOOK_POINTS` 为叶子路径，`loadUpstreamHook` 从 `mod.hooks`（须为对象）按叶子路径 `path.split(".")` 逐层取函数、组装嵌套 `UpstreamHook`、`exports` 收集命中的叶子路径；`setUpstreamHookForTests` 的 `exports` 用叶子路径枚举（遍历嵌套 + `exchange`）。空导出错误信息列 `HOOK_POINTS`。
- [ ] **Step 4**：改 `driver.ts` 3 处 wire：`hook?.onRequest`→`hook?.upstream?.outbound`、`hook?.onExchange`→`hook?.exchange`、`hook?.rewriteUpstreamFrame`→`hook?.upstream?.inbound`（含调用点与相邻注释里的旧名）。
- [ ] **Step 5**：改 `route.ts` 的 reload/GET 回执 `exports` 描述与示例为叶子路径；改 `index.ts`/`origin.ts`/`toolkit.ts` + `frame-origin.ts`/`client-sink.ts`/`history/types.ts` 注释里的旧名为新名。
- [ ] **Step 6**：改其余 hook 测试与 e2e harness（`driver-hookpoints.unit`、`driver-provenance.unit`、`reactive-retry-leg.it`、`reload-and-l2.it`、`replay.it`、`hooks.http`、`cli-refusal-hook.ts`、`anthropic-cli.e2e.test.ts:56`）的 hook 导出/断言为新形状。**MEDIUM 警示**：`cli-refusal-hook.ts:12-18` 自述一条 data-URL 加载器陷阱（源码含字面 `{`/`}`/`"` 曾让 `Bun.Transpiler` data-URL 加载丢具名导出，故它刻意避花括号 + data 用 base64）。改成 `export const hooks = { exchange: ... }` 会重新引入花括号——迁移后**必须对改写后的实际文件跑一次最小 data-URL 加载探针或 gated e2e**，确认具名 `hooks` 导出未消失（评审实测倾向陷阱已过时，但按 empirical-verification 不假设、实测确认；若复现则保留 base64 技巧 / 调整包装）。
- [ ] **Step 7**：`bun run typecheck`，Expected：绿（无残留旧名消费方）。
- [ ] **Step 8**：`bun test tests/pipeline/hooks/ tests/routes/hooks.http.test.ts`，Expected：全 PASS；再跑 Task 0 的 golden，Expected：PASS（passthrough 字节等价跨迁移不变）。
- [ ] **Step 9**：全仓审残留 `grep -rnE '\bonRequest\b|\bonExchange\b|\brewriteUpstreamFrame\b' src/ tests/ | grep -vE 'onRequestsList|onRequestRetry'`，Expected：本机制零残留（仅剩无关命中）。**注**：行号锚点（本计划标的 driver.ts :257/:397/:549 等）迁移期间已漂移，一律 grep 定位、不信数字（评审 LOW）。
- [ ] **Step 10**：Commit
```bash
git add -- src/lib/pipeline/hooks/ src/lib/pipeline/driver.ts src/routes/hooks/route.ts src/lib/pipeline/frame-origin.ts src/lib/pipeline/client-sink.ts src/lib/history/types.ts tests/pipeline/hooks/ tests/routes/hooks.http.test.ts tests/e2e-client/harness/cli-refusal-hook.ts tests/e2e-client/anthropic-cli.e2e.test.ts
git commit -m "refactor(hooks)!: migrate flat mount points to nested hooks.{client,upstream}.{inbound,outbound}+exchange"
```

---

## Task 2：新增 `client.inbound` 挂载点 + driver 防御性 body snapshot

**Files:**
- Modify: `src/lib/pipeline/hooks/types.ts`（`client.inbound` 已在 Task 1 接口中；确认）
- Modify: `src/lib/pipeline/driver.ts`（S1 parse 后、`resolveRouteDecision`/translate 前，约当前 :232 之前）
- Test: `tests/pipeline/hooks/client-inbound.unit.test.ts`（新建）

**Interfaces:**
- Consumes：Task 1 的嵌套 `UpstreamHook.client.inbound`、`getUpstreamHook()`、driver 现成的容错 `snapshotBody`（`driver.ts` 约 :296，try/catch 包 structuredClone、不可克隆回退原值）。
- Produces：driver 在 S2 translate 前调用 `hook?.client?.inbound`；调用前用 `snapshotBody` 对传入 hook 的 env 做**防御性 body snapshot**（defense-in-depth，spec §3.5——真 codec 已 clone `orig.payload`，故此 snapshot 不修当前 bug，而是防未来非-clone codec + 落实不可变返回）。

> **evidence（评审已核实）**：四 codec 的 `orig.payload` 均 `structuredClone` 独立于 `env.body`，故 `clientRequest.body` 结构性安全、hook 原地改碰不到它。**测试不能拿 `clientRequest.body` 当 snapshot 的 oracle**（对 snapshot 盲，删 snapshot 也不变红）——须直测「hook 收到的 env.body 与 driver 继续用的 parsed.body 引用独立」。

- [ ] **Step 1（测试先行，直测 snapshot 机制 + wire 发散）**：新建 `tests/pipeline/hooks/client-inbound.unit.test.ts`：
```ts
// (a) 直测防御性 snapshot：hook 收到的 env.body 必须是与 driver 继续使用的 parsed.body 独立的克隆
it("client.inbound receives a defensive body clone, not the driver's continuing env", async () => {
  let seenBody: unknown
  setUpstreamHookForTests({ client: { inbound: (env) => { seenBody = env.body; (env.body as any).messages?.splice(0,1); return undefined } } })
  const { driverParsedBody } = await runDriverCapturingParsed(/* Anthropic 请求含首条 system 块 */)
  expect(seenBody).not.toBe(driverParsedBody)                 // 引用不等（是克隆）
  expect(driverParsedBody.messages).toHaveLength(ORIGINAL_LEN) // 原地 splice 未穿透到下游 parsed（返回 undefined → fallback 原 env）
})
// (b) wire 发散 + 客户端轨保真：不可变返回删块，朝上游 wire 少了该块、clientRequest.body 仍是原样
it("client.inbound immutable-return strip reaches upstream wire but preserves client track", async () => {
  setUpstreamHookForTests({ client: { inbound: (env) => stripFirstSystemBlock(env) } })
  const { wireBody, historyEntry } = await runDriverOnce(/* Anthropic 请求含首条 system 块 */)
  expect(wireBody.messages).not.toContainSystemBlock()        // 上游收到删块后
  expect(historyEntry.clientRequest.body).toEqual(ORIGINAL_CLIENT_PAYLOAD) // 客户端轨仍原样（两轨发散）
})
```
- [ ] **Step 2**：跑该测试，Expected：FAIL（driver 尚无 `client.inbound` wire——(a) 的 `seenBody` 是 undefined / hook 未被调用；(b) 的 wireBody 未删块）。
- [ ] **Step 3**：在 `driver.ts` 的 `deps.codec.parse(raw)` 之后、`resolveRouteDecision` 之前插入，**并把下游全部 `parsed` 消费点改用返回值**（评审 MEDIUM：漏改任一处 typecheck 不报错但 hook 改写被静默吞掉）：
```ts
// Hook point: client.inbound — one-shot client-native rewrite BEFORE translate/sanitize.
// Defensive body snapshot (spec §3.5): give the hook a clone-backed env so an in-place mutation
// can't穿透 downstream; on undefined return, keep the ORIGINAL parsed (immutable-return semantics).
const inbound = getUpstreamHook()?.client?.inbound
const parsedForHook = inbound ? (inbound(parsed.with({ body: snapshotBody(parsed.body) })) ?? parsed) : parsed
// 下游全部改用 parsedForHook（枚举，勿漏）：
//   resolveRouteDecision(deps, parsedForHook)
//   parsedForHook.with({ targetEndpoint })
//   （parsedForHook.ctx.setRouteInfo — ctx 与 parsed 共享，改不改名等价）
```
   写码时 grep 定位 driver 里 `parse` 之后到 `runRewriteIn` 之前所有读 `parsed` 的点（当前约 `resolveRouteDecision(deps, parsed)`、`parsed.with({targetEndpoint})`），逐一改为 `parsedForHook`。
- [ ] **Step 4**：跑 `bun test tests/pipeline/hooks/client-inbound.unit.test.ts`，Expected：PASS。**删去 `snapshotBody(...)` 改成直传 `parsed`（即 `inbound(parsed) ?? parsed`）重跑**，Expected：(a) 的引用-独立断言变 FAIL（证明 snapshot 真的承重、非装饰）——确认后复原。
- [ ] **Step 5**：`bun run typecheck` 绿 + 重跑 Task 0 golden（无 hook 时 client.inbound 分支惰性跳过、字节等价不变）Expected：PASS。
- [ ] **Step 6**：Commit
```bash
git add -- src/lib/pipeline/driver.ts src/lib/pipeline/hooks/types.ts tests/pipeline/hooks/client-inbound.unit.test.ts
git commit -m "feat(hooks): add client.inbound mount point with driver-enforced defensive body snapshot"
```

---

## Task 3：四格式剥块 helper（`stripMessageBlock`/`mapClientMessages`）+ 剥 TodoWrite 示例

**Files:**
- Create: `src/lib/pipeline/hooks/client-rewrite.ts`（四格式 accessor + helper）
- Modify: `src/lib/pipeline/hooks/{index.ts,toolkit.ts}`（barrel 导出新 helper）
- Modify: `src/lib/pipeline/hooks/README.md`（补 client.inbound 生产用途 + 承重警告更新）
- Create: `exp/strip-todowrite-hook.ts`（首个生产示例 hook）
- Test: `tests/pipeline/hooks/client-rewrite.unit.test.ts`（新建，四格式各一）

**Interfaces:**
- Consumes：`env.clientFormat`（`"anthropic"|"openai-cc"|"openai-responses"|"gemini"`）、各形状 body、Anthropic `system-messages.ts` 不变量 primitive。
- Produces：
```ts
export function mapClientMessages(env: RequestEnvelope, fn: (msg, ctx) => Msg | null): RequestEnvelope  // null=删；不可变返回新 env
export function stripMessageBlock(env: RequestEnvelope, predicate: (block, role, pos) => boolean): RequestEnvelope
```
- **真相域三形状（评审 HIGH-1，已核实）**：client.inbound 处 `env.body` 只有三种形状——anthropic messages / **CC messages（`openai-cc` 与 `gemini` 共用**，gemini 已在 route 层翻成 CC）/ responses input+instructions。**只需三个 accessor**，gemini 分派到 CC accessor。

- [ ] **Step 1（测试先行，三真相域 + 不变量 oracle）**：新建 `tests/pipeline/hooks/client-rewrite.unit.test.ts`：① anthropic：删首条 `role:system` TodoWrite 块 → 结果仍 starts-with-user、tool 配对不破；② openai-cc：删 `role:system` → 空-messages 保护；③ **gemini：断言 `env.clientFormat==="gemini"` 时 `env.body` 是 CC messages[]（非 contents），走 CC accessor 删 `role:system` 块**——这条测试同时钉住 HIGH-1 的形状事实（若未来 gemini 不再 route 层翻译，此断言会红、提示 accessor 需改）；④ openai-responses：删对应 `input` item / 改 `instructions`（**形状异构**）。每个断言删后 body 合法 + 独立 oracle（各格式 codec/翻译不报错）。
- [ ] **Step 2**：跑，Expected：FAIL（helper 未实现）。
- [ ] **Step 3**：实现 `client-rewrite.ts`：按 `env.clientFormat` 分派到**三个** accessor——`anthropic`（复用 `system-messages.ts`）、`cc`（`openai-cc` + `gemini` 共用，messages[] 上删块 + 空-messages 保护）、`responses`（`input`/`instructions`）；均**不可变返回**新 env。
- [ ] **Step 4**：跑，Expected：PASS（三真相域 / 四客户端格式）。
- [ ] **Step 5**：写 `exp/strip-todowrite-hook.ts`：`export const hooks = { client: { inbound: (env) => stripMessageBlock(env, (b,role,pos) => role==="system" && /The TodoWrite tool hasn't been used/.test(text(b))) } }`；barrel 导出 helper；README 补 client.inbound 用法 + 更新承重警告（新增「client.inbound 不可变返回 + 四格式差异」）。
- [ ] **Step 6**：`bun run typecheck` 绿 + `bun test tests/pipeline/hooks/`，Expected：全 PASS。
- [ ] **Step 7**：Commit
```bash
git add -- src/lib/pipeline/hooks/client-rewrite.ts src/lib/pipeline/hooks/index.ts src/lib/pipeline/hooks/toolkit.ts src/lib/pipeline/hooks/README.md exp/strip-todowrite-hook.ts tests/pipeline/hooks/client-rewrite.unit.test.ts
git commit -m "feat(hooks): add four-format client-message rewrite helpers + strip-TodoWrite example hook"
```

---

## Task 4：文档同步（ADR / DESIGN / deferred-backlog / skill / memory / 旧 plan 指针）

**Files:**
- Modify: `docs/decisions/2026-07-12-driver-orchestrated-upstream-hooks.md`（补 v3 命名重构 + 「编程 hook 取代 config+regex」+ `client.inbound` + 防御性 snapshot 决策）
- Modify: `docs/DESIGN.md`（活的架构现状 hook 行：三挂载点 → 四挂载点新命名 + client.inbound）
- Modify: `docs/todo/deferred-backlog.md`（旧名→新名；`hook-rewrite` 覆盖缺口节旧名更新；补 `client.outbound` 预留节 + **补 `gemini 原生 contents 改写需 route 层挂载点` 节**——含语义：gemini 在 route 层早于 driver 翻成 CC，故 client.inbound 只能改 CC 形状；若需改原生 contents 须另设 route 层挂载点，记「若做需改什么」）
- Modify: `.claude/skills/upstream-hook-mocking/SKILL.md`（用法示例改 `export const hooks` 形状 + 补 client.inbound 生产用途）
- Modify: `docs/memory/project-upstream-hook-middleware.md`（stub 更新为 v3 迁移已落地）
- Modify: `docs/plan/2026-07-12-upstream-hook-middleware/README.md`（头部加指针「命名已于 v3 2026-07-14 迁移，最新形状见 spec §3.2/§12」——历史 plan 不重写）

**Interfaces:** Consumes：迁移后代码为 ground truth。Produces：doc-vs-code 一致。

- [ ] **Step 1**：逐文件按上表更新（新命名、client.inbound、防御性 snapshot、config+regex not-adopted 理由指向 spec §11.1）。
- [ ] **Step 2**：跨文档 grep 验证一致：`grep -rnE '\bonRequest\b|\bonExchange\b|\brewriteUpstreamFrame\b' docs/ .claude/skills/ | grep -v onRequestRetry`，Expected：仅剩 spec §12/§11 与历史 plan 文件夹的「旧名」标注（刻意保留）。
- [ ] **Step 3**：Commit
```bash
git add -- docs/decisions/2026-07-12-driver-orchestrated-upstream-hooks.md docs/DESIGN.md docs/todo/deferred-backlog.md .claude/skills/upstream-hook-mocking/SKILL.md docs/memory/project-upstream-hook-middleware.md docs/plan/2026-07-12-upstream-hook-middleware/README.md
git commit -m "docs(hooks): sync ADR/DESIGN/backlog/skill/memory to v3 nested naming + client.inbound"
```

---

## Task 5：收尾 — verifier 穷尽旧名审计 + 合并态 golden 复验

**Files:** 无新增；跨仓验证。

- [ ] **Step 1**：`bun run typecheck` + `bun run lint:all`（去 cache）+ `bun test tests/pipeline/hooks/ tests/routes/hooks.http.test.ts`，Expected：全绿。
- [ ] **Step 2**：派 verifier subagent 做 exhaustive 旧名迁移审计（评审建议）：全仓 grep `onRequest|onExchange|rewriteUpstreamFrame` 逐一判定 = 无关命中 / 刻意历史标注 / 漏改（漏改则回补）。显式裁判轴：本机制零残留旧名（排除 spec §12 映射表、历史 plan、无关命中）。
- [ ] **Step 3**：重跑 Task 0 passthrough golden + 一次真实/mock e2e（`tests/e2e-client/anthropic-cli.e2e.test.ts` 若含 hook）确认迁移未改行为。
- [ ] **Step 4**：session-closeout（plan 头部加实施状态注解、memory 维护、细粒度已提交）。

---

## Self-Review（spec 覆盖对照）

- spec §12 真功能触点 → Task 1（rename）+ Task 2（client.inbound）✓
- spec §3.5 防御性 snapshot → Task 2 Step 3-4（含删 snapshot 该测变红的证伪）✓
- spec §4.1 三真相域（anthropic / CC〔含 gemini〕/ responses 异构）→ Task 3 三 accessor + 四客户端格式各测 ✓（评审 HIGH-1 修正：gemini 走 CC accessor）
- spec §3.4 已实施不变量 → 不改动，Task 1 仅迁移其命名/注释 ✓
- spec §12 文档触点 + commit invariants + verifier 审计 → Task 4 + Task 5 ✓
- passthrough 字节等价 → Task 0 预捕获 + Task 1/2 重放 ✓
- `client.outbound` 预留不建挂载点 → 不入 types（Task 1 接口注释说明）、deferred-backlog 记（Task 4）✓
- gemini 原生 contents 改写需 route 层挂载点 → deferred-backlog 记（Task 4，评审 HIGH-1）✓
