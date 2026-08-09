---
name: reference-bun-test-eager-rejects-assertion-hangs-file
description: bun test 1.3.14 里对「尚未 reject 的 promise」提前建立 expect(...).rejects 断言会挂死整个测试文件、零输出
metadata: 
  node_type: memory
  type: reference
  originSessionId: b33d0633-a456-430b-af0b-a17c07796f7c
  modified: 2026-08-09T03:18:49.558Z
---

`bun test` v1.3.14：若在 promise **还没 reject** 的时刻就建立 `expect(pending).rejects.toThrow(...)`（拿到断言 promise 先存着，稍后才触发 reject，最后再 `await` 它），**整个测试文件挂死**。

诊断上最费时间的是它的症状形态：

- 输出**只有** `bun test v1.3.14 (...)` 一行，一个 `(pass)`/`(fail)` 都不打；
- bun 的**每用例 5s 超时不会触发**，进程一直挂到外层 `timeout` 杀掉；
- `-t <过滤>` 也救不了——只要匹配到那条用例就挂；用一个匹配不到任何用例的 `-t` 反而能正常跑完并打印覆盖率，**这正是区分「文件加载期挂」与「用例执行期挂」的判据**；
- 同一段逻辑在 `bun <script>.ts` 里直接跑完全正常，所以它不是产品代码的死循环。

两行探针即可复现：

```ts
test("eager rejects assertion on a later-rejected promise", async () => {
  let reject!: (error: Error) => void
  const pending = new Promise<void>((_r, r) => { reject = r })
  const assertion = expect(pending).rejects.toThrow(/boom/)   // ← 此刻 pending 尚未 reject
  reject(new Error("boom"))
  await assertion
})
```

**写法**：需要「先让 promise 处于 pending、做别的断言、再触发 reject」时，用 `.then(onFulfilled, onRejected)` 自己捕获，最后断言捕获到的错误：

```ts
let waiterError: unknown
const waiting = pendingPromise.then(
  () => { throw new Error("<明确说出不该 fulfil 的原因>") },
  (error: unknown) => { waiterError = error },
)
/* …触发 reject 的动作，以及中途要做的断言… */
await waiting
expect((waiterError as Error).message).toMatch(/boom/)
```

这个形态在「先让 waiter 排队、再触发某个终态转移、然后断言 waiter 被拒绝」的时序测试里天然出现（2026-08-09 History Worker Batch 2a 的 admission waiter 用例即由此挂死）。

## 变异对照里的同族形态：被测缺陷让 promise 永不 settle

上面讲的是「promise 稍后会 reject」。还有一种更隐蔽的：**promise 永远不 settle**——用 `expect(pending).rejects` 断言某守卫会拒绝，而**变异掉那个守卫之后**该调用不再拒绝、转而永久挂起。

- **显式 per-test 超时也拦不住**：实测 `}, 10_000)` 无效，整个文件仍挂到外层 `timeout` 杀掉（Batch 2a 的 start-after-fatal 用例，连挂两次、两次都留下未回滚的变异 patch）。
- **后果不只是慢**：它让这条判据的**变异对照拿不到可用的红**——挂起既不是绿也不是红，跑变异的人只看到「超时被杀」，分不清是守卫没了还是机器慢。
- **写法**：把 promise **race 一个短定时器**，把「永不 settle」翻译成普通断言失败：

```ts
const settled = await Promise.race([
  doThing().then(() => "resolved", (error: unknown) => `rejected: ${(error as Error).message}`),
  new Promise<string>((resolve) => {
    const handle = setTimeout(() => resolve("never settled"), 1000)
    handle.unref?.()   // 别让这个定时器把进程钉住
  }),
])
expect(settled).toMatch(/^rejected: .*<期望的原因>/)
```

改完同一变异 **1 秒内变红**。**判据**：写「断言某 promise 会 reject」的用例前先问——*如果被测的守卫没了，这个 promise 还会 settle 吗？* 答不出「会」，就用 race，别用 `.rejects`。

**Related:** [[reference-bun-test-parallel-breaks-single-process-superlinear-degradation]]、[[reference-elapsed-time-test-inject-clock-seam-not-setsystemtime]]（同属「bun test harness 与真实时序交互」的坑）、[[methodology-new-test-red-and-green-both-overclaim]]（新测试的红绿各自能推出什么）。
