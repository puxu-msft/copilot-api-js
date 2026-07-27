# P0 — 基线与守卫

> **前置**：无（DAG 根）。**产出**：三条独立 oracle 的 harness + 现有 anchor 套件的红绿基线，后续每相位复用。
> **为什么先做**：本改造的失败模式是**静默重排**（R1），typecheck 绿 + 单测绿都不足以发现。必须先有能咬住 wire 全序的 oracle，才允许动 index 记账。

## Files

- New: `exp/inter-block-anchor-allocator/README.md`（探针归属说明）
- New: `exp/inter-block-anchor-allocator/byte-equivalence.sh`（O-6 短请求 SHA 基线，隔离端口）
- New: `exp/inter-block-anchor-allocator/deterministic-hook.ts`（O-6 用的确定性上游 hook）
- New: `tests/helpers/wire-index-oracle.ts`（O-1/O-2 共享断言原语）
- Modify: 无 `src/` 改动（本相位纯新增测试基础设施）

## Interfaces

- Produces: `assertMonotonicWireIndices(frames: ReadonlyArray<ClientFrame>): void`（O-1）、`assertMaxOneBlockOpen(frames): void`（O-2）、`wireShape(frames): Array<string>`（形如 `["message_start","anchor_start@0","delta@0","anchor_stop@0","real_start@1",...]`，供 O-3 精确比对）
- Consumes: 既有 `tests/helpers/fake-clock.ts`、`tests/e2e-client/harness/{spawn-proxy,drive-claude-cli}.ts`

---

## Task 0.0：worktree 与并发对齐

- [ ] 起隔离 worktree：`git worktree add .worktrees/anchor-alloc -b feat/inter-block-anchor-allocator master`
- [ ] **核实 `fix/client-proxy-keepalive-300s` 的合并状态**。本计划的 P5 依赖该分支的 `contentDeadlineMs` / `injectContentScaffold` / `contentAnchorInjected` 机制（`delivery/{session,types}.ts`、`client-sink.ts`、`handler-v4.ts`、`AnchorState.contentAnchorInjected`）。若尚未合并 master：
  - 优先等其合并（按项目 `docs-merge-before-execute` 纪律，该分支的文档应已先合）；
  - 若必须先行，则从该分支起 worktree 而非 master，并在此处记录实际 base commit。
  - **这是一个 gating 事实，不是可跳过的核实**：P5 的每个 task 都写在「按需升级已存在」的前提上。
- [ ] 核实并发 peer：`git worktree list` + 各分支 `git log --oneline master..<branch> -- src/lib/pipeline src/lib/anthropic` 看谁在动同一批文件；有重叠则记入本文件，实施期按行级共存处理。
- [ ] **提交** → `docs(plan): record allocator plan base commit and concurrent peers`

## Task 0.1：O-6 字节等价基线脚本

> 基线值 `8691db71ca3b692468ae91dfc2df108871c8f5f684acc73f3832975d60f2a6a0` / 1675 bytes 来自 GPT 代码审的独立重跑（`stream_keepalive_escalate_sec` 0 与 200 两侧同值）。本 task 把一次性验证**固化为可重跑脚本**——后续每相位收口都要跑它。

- [ ] **Step 1**：写 `exp/inter-block-anchor-allocator/deterministic-hook.ts`——一个 upstream hook，产出固定的短响应（message_start + 单 text 块 + message_delta + message_stop，无静默），保证字节确定。
- [ ] **Step 2**：写 `byte-equivalence.sh`——在**自选非 4141 端口**（如 42061）起测试服务器（`bun run start --port 42061`，config 指向该 hook），`curl -N` 抓完整 SSE 到文件，`sha256sum` + `wc -c` 输出，脚本末尾**按 PID 精确 kill 自己启动的实例**（绝不 `pkill`/`killall`）。
- [ ] **Step 3**：跑一次，与基线值对照。
  - **若不匹配**：先查是否因 master 已前进（该基线在 `fix/client-proxy-keepalive-300s` 上测的）。此时**重新捕获基线并在本文件记录新值 + 捕获时的 commit**，不要为对上旧值扭曲配置。基线的作用是「改造前后不变」，不是「与三天前的某次跑一致」。
- [ ] **Step 4**：`README.md` 记录跑法 + 当前基线值 + 捕获 commit。
- [ ] **提交** → `test(anchor): add reproducible byte-equivalence baseline probe`

## Task 0.2：O-1 / O-2 producer 全序 harness

> 复用 `tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` 已有的 gated-upstream + mock codec + FakeClock 骨架（那是本仓库唯一的真 producer wire-oracle），把其中的断言抽成可复用原语。**但注意**：该文件用 `makeSseSink`（raw sink）。本 harness 必须**同时**支持 raw sink 与 `makeDeliverySseSink`（生产路径）两种注入，因为 P6 揭示的心跳缺陷只在后者可见。

- [ ] **Step 1: 写失败测试** —— 抽 `tests/helpers/wire-index-oracle.ts`，并用一个**故意错误的**帧序列证明断言会红：

```ts
// tests/helpers/wire-index-oracle.unit.test.ts —— 正样本对照：证明检查确实触达目标
test("assertMonotonicWireIndices rejects a duplicated index", () => {
  const bad = [startFrame(0), stopFrame(0), startFrame(0)] // real@0, anchor@0 —— 本轮 blocker 的形状
  expect(() => assertMonotonicWireIndices(bad)).toThrow()
})
test("assertMaxOneBlockOpen rejects the coexist shape", () => {
  const bad = [startFrame(0), startFrame(1)] // 两块并存 open
  expect(() => assertMaxOneBlockOpen(bad)).toThrow()
})
test("both accept the current (pre-change) sequential shape", () => {
  const ok = [startFrame(0), stopFrame(0), startFrame(1), stopFrame(1)]
  expect(() => assertMonotonicWireIndices(ok)).not.toThrow()
  expect(() => assertMaxOneBlockOpen(ok)).not.toThrow()
})
```

- [ ] **Step 2**：跑，红（原语还不存在）。
- [ ] **Step 3**：实现原语。`assertMonotonicWireIndices` 收集全部 `content_block_start` 的 index，断言等于 `[0..n-1]`；`assertMaxOneBlockOpen` 逐帧维护 openSet 断言峰值为 1；`wireShape` 输出可读的类型@index 序列（anchor 帧按 `synthetic` 标记区分）。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5**：把原语接进一个**新的** producer 测试 `tests/pipeline/wire-frontier-producer.it.test.ts`，用**当前**（未改造）代码跑 pre-content anchor + 双真实块场景，断言现状通过 O-1/O-2（现状是 `anchor@0 → real@1 → real@2`，本就合规）。这条是**改造前的绿基线**，后续每相位都要保持绿。
- [ ] **提交** → `test(anchor): add reusable wire-index producer oracles`

## Task 0.3：现有 anchor 套件红绿基线

- [ ] **Step 1**：跑全部 52 个 touch anchor 的测试文件，记录 pass/fail 数与文件清单：

```bash
bun test $(rg -ln "anchor" tests/ | tr '\n' ' ')
```

- [ ] **Step 2**：把结果（总数 + 任何既有失败）写进本文件的「基线」小节。**既有失败必须当场修或明确归因**（项目 `dont-ignore-existing-errors`），不得带着红进入后续相位——否则后面无法区分「我打红的」与「本来就红的」。
- [ ] **Step 3**：单独标出**逐字节 golden** 与**结构断言**两类文件（改造会按设计打红它们，需要重捕/改写而非「修」）：
  - 逐字节 golden：`tests/pipeline/buffered-anchor-golden.it.test.ts`、`tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts`、`tests/anthropic/direct-stream-golden-phase4.http.test.ts`
  - 结构断言：`tests/pipeline/anchor-multiblock-lifecycle.it.test.ts`、`tests/pipeline/retreat-anchor-collision.it.test.ts`、`tests/pipeline/live-reconcile-collision.it.test.ts`、`tests/anthropic/live-post-commit-anchor-closeoff.http.test.ts`、`tests/anthropic/keepalive-*.test.ts`
- [ ] **提交** → `docs(plan): record anchor suite red-green baseline`

## P0 收口

- [ ] `bun run typecheck` + `bun run test:fast` 绿。
- [ ] 三条 oracle 各自可独立跑通并记录在 README。
- [ ] 基线小节已填（下方）。

## 基线（实施期填写）

| 项 | 值 | 捕获时间 / commit |
|---|---|---|
| base commit | _待填_ | |
| anchor 套件 | _待填_ pass / _待填_ fail | |
| 短请求 SHA-256 | _待填_ | |
| 短请求字节数 | _待填_ | |
| `fix/client-proxy-keepalive-300s` 合并状态 | _待填_ | |
