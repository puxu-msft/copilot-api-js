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

- Produces: `assertMonotonicWireIndices(frames: ReadonlyArray<ClientFrame>): void`（O-1）、`assertBlockProtocolState(frames): void`（O-2 —— 完整块协议状态机，`maxOpen <= 1` 只是其一条子断言）、`wireShape(frames): Array<string>`（形如 `["message_start","anchor_start@0","delta@0","anchor_stop@0","real_start@1",...]`，供 O-3 精确比对）
- Consumes: 既有 `tests/helpers/fake-clock.ts`、`tests/e2e-client/harness/{spawn-proxy,drive-claude-cli}.ts`

---

## Task 0.0：worktree、并发对齐与**开工硬门**

> **round-2 major**：原本放在 P8 的「冻结 spec 状态同步」时序不可执行——它自己写着「必须在 plan 合并/开工之前闭合」，却排在实施末尾。**已前移到本 task 作为开工硬门**（P8.6 只保留「已实施」注解）。

### Step A：冻结 spec 的状态同步（**开工硬门，先于任何代码改动**）

矛盾：本 plan 与 kickoff 都称该 spec 是「冻结的唯一权威、用户已裁决选 A」，但 spec 文件头部仍写「设计候选，已按两轮异模型评审修订，**待用户裁决**」。执行者会同时读到两个相反状态，「冻结契约」只存在于计划自述、不在其权威来源中。

- [x] 更新 `docs/spec/2026-07-27-inter-block-keepalive-carrier.md` 的**状态行**：由「设计候选，待用户裁决」改为「**已裁决：采用方案 A**（用户 2026-07-27）；实施计划见 `docs/plan/2026-07-27-inter-block-anchor-allocator/`」，记录裁决日期。
- [x] 同步 §9「推荐与落地顺序」措辞，反映「A 已选定并进入实施」而非「推荐 A」。
- [x] **不改设计正文**（方案对比、证据、否决理由原样保留）——只同步「决策状态」这一个事实。
- [x] **提交** → `docs(spec): record that option A was selected and is now in implementation`

> 本 step 与 P8.4（ADR）不同：它记录的是**用户已做出的裁决**（有据可循），不是新决策，**不需要**再次征求同意。若执行时发现裁决范围与本 plan 表述有出入，**停下回报**。

### Step B：worktree 与并发对齐

- [x] 起隔离 worktree：本次 P6 独立交付按用户指定使用 `.worktrees/p6-heartbeat`、分支 `fix/heartbeat-lifecycle`、base `5c84a1e011e5d8b12ebde764ef0d8486b9952d6f`。
- [x] **核实 `fix/client-proxy-keepalive-300s` 的合并状态**：所需 delivery-session keepalive 机制已在本次 master base 中存在；旧分支 commit `dcaf72a6` 不作为 master 祖先单独出现，但 P6 计划点名的 `contentDeadlineMs` / `injectContentScaffold` / `contentAnchorInjected` 接口均可在 base 代码中核实。
- [x] 核实并发 peer：`git worktree list` 显示 7 个 worktree；其中 `feat/upstream-silence-recovery` 有尚未合并的 pipeline 改动，但不改本相位的 heartbeat sink 文件。其余活 worktree 未发现 `src/lib/pipeline` / `src/lib/anthropic` 的 master 后独有改动。
- [x] **提交** → `docs(plan): record allocator plan base commit and concurrent peers`（与本相位 P0 基线记录同一 plan 提交落地）

## Task 0.1：O-6 字节等价基线脚本

> **基线的合同层级（plan review minor 修订）**：历史值 `8691db71…2f6a0` / 1675 bytes 来自 GPT 代码审的独立重跑（`docs/todo/keepalive-300s-fix-review-gpt.md:98`，`escalate` 0/200 两侧同值）——**来源可追溯，但它是某个 commit + 请求 + hook + 配置 + SSE writer 的 characterization，不是跨 master 前进的永久需求**。故：
>
> - **权威基线 = 本 task 在实施 base 上捕获的 pre-change 字节**；P8 必须与之逐字节相同。
> - 历史 SHA 只作 **provenance / sanity check**。
> - **若捕获值与历史值不同**：不得直接换值了事，必须先证明 hook、请求、配置三者相同，再定位并**记录造成差异的 base change**（哪个 commit、改了什么）。差异无法解释时停下回报——那可能是别的回归。

- [x] **Step 1**：写 `exp/inter-block-anchor-allocator/deterministic-hook.ts`——一个 upstream hook，产出固定的短响应（message_start + 单 text 块 + message_delta + message_stop，无静默），保证字节确定。
- [x] **Step 2**：写 `byte-equivalence.sh`——在**自选非 4141 端口**（如 42061）起测试服务器（`bun run start --port 42061`，config 指向该 hook），`curl -N` 抓完整 SSE 到文件，`sha256sum` + `wc -c` 输出，脚本末尾**按 PID 精确 kill 自己启动的实例**（绝不 `pkill`/`killall`）。**保留捕获的字节文件本身**（不只是 hash），P8 用 `cmp` 逐字节对比。
- [x] **Step 3**：跑一次，记录为**权威 base 基线**；与历史值对照并按上面的规则处置差异。当前冻结 fixture 为 `24eda6b85d0ce17b955ce50aca27407d37f9a32a1de2e7a8318c6a2f55991e8b / 734 bytes`；历史值对应不同旧 fixture，不能作同输入逐字节比较，关系已记录在 oracle README。
- [x] **Step 4**：`README.md` 记录跑法 + base 基线值 + 捕获 commit + 与历史值的关系。
- [x] **提交** → `test(anchor): capture the pre-change byte baseline on the implementation base`

## Task 0.2：O-1 / O-2 producer 全序 harness

> 复用 `tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` 已有的 gated-upstream + mock codec + FakeClock 骨架（那是本仓库唯一的真 producer wire-oracle），把其中的断言抽成可复用原语。**但注意**：该文件用 `makeSseSink`（raw sink）。本 harness 必须**同时**支持 raw sink 与 `makeDeliverySseSink`（生产路径）两种注入，因为 P6 揭示的心跳缺陷只在后者可见。
>
> **O-2 已按 plan review major 升级**：原「维护 openSet 并断言峰值为 1」**过弱**——一个坏实现若把 `start@1` 正确 remap、却把同块的 delta/stop 留在 upstream `@0`，单块场景峰值仍是 1，但流末尾悬挂 `@1` 且 delta/stop 指向未 open 的 index，测试照样绿。故升级为完整**块协议状态机**。

- [x] **Step 1: 写失败测试** —— 抽 `tests/helpers/wire-index-oracle.ts`，并用**故意错误的**帧序列证明每条断言都会红（正样本对照：`pass-null-clean-not-self-validating`）：

```ts
// tests/helpers/wire-index-oracle.unit.test.ts
// ── O-1 ──
test("assertMonotonicWireIndices rejects a duplicated index", () => {
  expect(() => assertMonotonicWireIndices([startFrame(0), stopFrame(0), startFrame(0)])).toThrow()
})
test("assertMonotonicWireIndices rejects a gap in the sequence", () => {
  expect(() => assertMonotonicWireIndices([startFrame(0), stopFrame(0), startFrame(2)])).toThrow()
})

// ── O-2：四条子断言各有独立负样本 ──
test("rejects two blocks open at once", () => {
  expect(() => assertBlockProtocolState([startFrame(0), startFrame(1)])).toThrow()
})
test("rejects a delta referencing an index that is not the open block (orphan delta)", () => {
  expect(() => assertBlockProtocolState([startFrame(1), deltaFrame(0)])).toThrow()   // ← 原 maxOpen 断言放行
})
test("rejects a stop with the wrong index", () => {
  expect(() => assertBlockProtocolState([startFrame(1), stopFrame(0)])).toThrow()    // ← 原断言放行
})
test("rejects a dangling open block at end of stream", () => {
  expect(() => assertBlockProtocolState([startFrame(0)])).toThrow()                  // ← 原断言放行
})
test("rejects a duplicated stop", () => {
  expect(() => assertBlockProtocolState([startFrame(0), stopFrame(0), stopFrame(0)])).toThrow()
})

// ── 正向：当前（未改造）形状必须通过 ──
test("both accept the current sequential shape", () => {
  const ok = [startFrame(0), deltaFrame(0), stopFrame(0), startFrame(1), deltaFrame(1), stopFrame(1)]
  expect(() => assertMonotonicWireIndices(ok)).not.toThrow()
  expect(() => assertBlockProtocolState(ok)).not.toThrow()
})
```

- [x] **Step 2**：跑，红（原语还不存在；`Cannot find module './wire-index-oracle'`）。
- [x] **Step 3**：实现原语：
  - `assertMonotonicWireIndices`：收集全部 `content_block_start` 的 index，断言等于 `[0..n-1]`（无洞无重复）。
  - `assertBlockProtocolState`：逐帧跑状态机，断言 ① open 集合大小 <= 1；② 每个 delta/stop 的 index === 当前唯一 open 的 index；③ stop 后集合为空；④ 终局集合为空。**`maxOpen <= 1` 只是其中一条子断言，不是全部。**
  - `wireShape`：输出可读的类型@index 序列（anchor 帧按 `synthetic` 标记区分），供 O-3 精确比对。
- [x] **Step 4**：跑，绿（8 tests / 0 fail）。
- [x] **Step 5**：把原语接进既有唯一真 producer `tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` 的 pre-content anchor + 双真实块场景，断言现状通过 O-1/O-2。计划拟新建的 `wire-frontier-producer.it.test.ts` 会重复同一 harness，因此按“复用既有 producer”要求直接替换其过弱的 `maxOpen` 断言。
- [x] **提交** → `test(anchor): reusable wire-index and block-protocol-state producer oracles`

## Task 0.3：现有 anchor 套件红绿基线

- [x] **Step 1**：跑全部 touch anchor 的测试文件，记录 pass/fail 数与文件清单（当前 master 实际命中 51 文件）：

```bash
bun test $(rg -ln "anchor" tests/ | tr '\n' ' ')
```

- [x] **Step 2**：把结果（总数 + 任何既有失败）写进本文件的「基线」小节。首跑发现 gated coexist CLI e2e 仍使用退役 hook 接口并期待已被证伪的正向结论；迁到 `hooks.exchange` 后以真实 CLI 结果改成负向 characterization，复跑为 474 pass / 0 fail / 7 skip。
- [x] **Step 3**：单独标出**逐字节 golden** 与**结构断言**两类文件（改造会按设计打红它们，需要重捕/改写而非「修」）：
  - 逐字节 golden：`tests/pipeline/buffered-anchor-golden.it.test.ts`、`tests/anthropic/c0-live-anchored-direct-stream-golden.http.test.ts`、`tests/anthropic/direct-stream-golden-phase4.http.test.ts`
  - 结构断言：`tests/pipeline/anchor-multiblock-lifecycle.it.test.ts`、`tests/pipeline/retreat-anchor-collision.it.test.ts`、`tests/pipeline/live-reconcile-collision.it.test.ts`、`tests/anthropic/live-post-commit-anchor-closeoff.http.test.ts`、`tests/anthropic/keepalive-*.test.ts`
- [x] **提交** → `docs(plan): record anchor suite red-green baseline`（与 P0 oracle 基线记录同一语义单元提交）

## P0 收口

- [ ] `bun run typecheck` + `bun run test:fast` 绿。
- [ ] 三条 oracle 各自可独立跑通并记录在 README。
- [ ] 基线小节已填（下方）。

## 基线（实施期填写）

| 项 | 值 | 捕获时间 / commit |
|---|---|---|
| base commit | `5c84a1e011e5d8b12ebde764ef0d8486b9952d6f` | 2026-07-27 |
| anchor 套件 | 474 pass / 0 fail / 7 skip（481 tests，51 files） | 2026-07-27 / base + P0 test repairs |
| 短请求 SHA-256 | `24eda6b85d0ce17b955ce50aca27407d37f9a32a1de2e7a8318c6a2f55991e8b` | 2026-07-27 / base |
| 短请求字节数 | 734 | 2026-07-27 / base |
| `fix/client-proxy-keepalive-300s` 合并状态 | 所需机制已在 master base；旧分支 commit 不作为祖先单独出现 | 2026-07-27 / base |
