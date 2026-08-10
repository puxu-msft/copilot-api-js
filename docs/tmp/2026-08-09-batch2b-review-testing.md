# Batch 2b 测试可信度评审（testing 视角）——专找假绿

- **锚点**：HEAD `389cec95`，范围 `git diff baef58b3..HEAD -- tests/`。评审期间 HEAD 从 `a49f278b` 前进到 `389cec95`，本文所有实测均在 `389cec95` 上复跑。
- **裁判轴**：长远正确 + 完整；不因改动大扣分。唯一问题是**绿是不是廉价的绿**。
- **取证环境**：`/tmp/b2b-mutation-tree`（worktree 只读拷贝 + 主树 `node_modules` 软链），变异全部在副本上跑；**worktree 内除本文件外未做任何修改**。基线对照树 `/tmp/b2b-base-tree`（`git archive baef58b3`）。
- **方法（沿用派活方给的范式）**：对每份新测试构造「实现坏掉但它照绿」的场景，能构造出来就是缺口；构造不出来则如实列出试过的反例方向。
- **状态**：本轮先交**第 1 个缺口**，按要求边查边落盘。

---

## 缺口 1

### [blocker] `tests/history/worker/event-loop-isolation.it.test.ts` —— 真 Worker 臂没有正控：**Worker 根本没阻塞时，整份文件照绿**

**坏实现**：注入的 500ms 同步阻塞**从未在 Worker 线程里执行**（`workerData` 通道断了 / 键名改了 / fixture 入口被换掉）。

**为什么会照绿**：阻塞量是通过 `workerData` 传进 Worker 的，而缺失值会被**静默吞掉**，不会报错。

`tests/history/worker/fixtures/blocking-backend-worker.ts` 末两行：

```ts
const fixture = workerData as BlockingBackendFixture
installHistoryWorkerMessageLoop(parentPort, withSynchronousBlock(createHistoryWorkerBackend(), fixture.blockMs))
```

`tests/history/worker/fixtures/blocking-backend.ts` 的 `busyWaitMs`：

```ts
const until = Date.now() + ms
while (Date.now() < until) { /* spin */ }
```

`ms` 为 `undefined` 时 `until` 是 `NaN`，`Date.now() < NaN` 恒假，**循环一次都不进**。于是「真 Worker 阻塞了 500ms 而主线程仍然响应」与「Worker 压根没阻塞、主线程当然响应」这两个世界，本文件的判据分不出来。

**实测（变异 E，HEAD `389cec95`，副本树）**：把 fixture 改成读一个不存在的键（`(workerData as X | undefined)?.blockMsTypo`，等价于通道断了），单跑该文件：

```
基线            1 pass 0 fail
MUT-E（Worker 臂零阻塞）  1 pass 0 fail
```

**为什么现有的控制拦不住它**：

- 负控（`expect(inProcess.stall).toBeGreaterThanOrEqual(BLOCK_MS * 0.8)`，`:118`）只证明 **in-process 臂**能冻结、metronome 不瞎；它对 Worker 臂里那份注入是否生效**一无所知**——两臂虽然共用 `withSynchronousBlock`，但**注入参数走的是两条不同的通道**（in-process 直接闭包传参，Worker 走 `workerData` 序列化），断掉的恰恰是后者。
- `expect(inProcess.stall).toBeGreaterThan(worker.stall * 2)`（`:122`）在 `worker.stall ≈ 0` 时**更容易**成立，方向与拦截相反。
- `expect(outcome).toBe("persisted")`（`:103`）只证明「有活干过」，不证明「那活是慢的」。
- 这与派活方已证实的那条 e2e 教训是**同一形态**：断言集合里的每一条在坏实现下都有别的成立理由，缺的是「被测的那件事确实发生过」这一条正控。

**修法**：给 Worker 臂补一条对称的正控——测 `driveOneOperation` 的**总耗时**（Worker 侧真实花掉的时间），断言 `≥ BLOCK_MS * 2 * 0.8`（两个注入点：`initialize` + `persist`），与既有的 `worker.stall < BLOCK_MS * 0.5` 并置。两者同时成立才等于「活确实很慢，但慢在别的线程」。另把 `blockMs` 的缺省从「隐式 `NaN`」改成显式抛错（`busyWaitMs` 对非有限值 throw，或 fixture 入口校验 `workerData`），让通道断裂当场变红而不是变成零阻塞。
