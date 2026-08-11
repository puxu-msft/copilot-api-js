---
name: owned-singleton-lifecycle
description: 当在 copilot-api-js 里新增、替换或重置一个**持有资源**的 module-global 单例（Worker/timer/socket/DB handle/订阅/后台循环）时使用——尤其是给它写 `reset*ForTests`、或诊断「旧资源跨测试存活」类症状：`Cannot use closed database`、zombie worker、timer 在测试结束后还在 fire、旧 cleanup 把**新**实例清掉、`await shutdown()` 期间装进来的 replacement 被无条件抹掉。纯值缓存（没有需要释放的资源）不适用本 skill——那走 `test-isolation` 的 state 快照/还原即可。
---

# 持有资源的单例：生命周期合同

一个 module-global 单例只要**持有需要显式释放的东西**（Worker、interval/timeout、socket、DB handle、事件订阅、后台循环），它的 reset 就不再是「把指针置空」。指针置空只解除了引用，**资源还活着**——它会继续 fire、继续持有文件句柄、继续往一个已经没人读的 sink 里写。

## 先判：本 skill 适不适用

| 单例持有的东西 | 归属 |
|---|---|
| 纯值 / 派生缓存（重算即可） | skill `test-isolation` 的 state 快照与还原就够了，**不要**给它套 async 生命周期 |
| Worker / timer / socket / DB handle / 订阅 / 后台循环 | 本 skill |

判据不是「它是不是单例」，而是**「丢掉这个引用之后，有没有东西还在跑或还占着句柄」**。答案是「有」，才进本 skill。

## 三个角色别混为一谈

同一个 `reset*ForTests` 里常常同时藏着三件事，混着写就会写出下面的坑：

- **injector setter** —— 把一个替身塞进去（`setXForTests(value)`）。它**不关**旧值——但这不是「旧值不用管」，而是**责任必须落到某个地方**：`registry = value` 会让 owner 永久失去旧实例的引用，之后再 reset 也只看得到 replacement，旧资源就此泄漏。

  **按强度排序的三种做法，优先取前面的**：
  1. **非空即抛** —— slot 已有实例时直接抛，逼调用方先走 owner reset。**机制上真的挡得住**，且不需要任何并发推理。**「只能装进空 slot / 旧值已处置的 slot」这条前置只属于这一档（以及第 3 档）**，它跟第 2 档的目标是矛盾的——第 2 档存在的意义就是安全地替换非空 slot。
  2. **owner 级 async `replace(next)`** —— 目标是安全替换非空 slot。**「写在同一个函数里」不会让它原子**：只要中间有 `await`，别的访问就能插进来。

     ⚠️ **而且要协调的不只是并发的 `replace`——普通 getter、setter、lazy-init 全都要参加同一套协议**，否则中间态会漏出去：`await current.dispose()` 期间 `current` 还挂在 registry 上，一个普通 getter 就能拿到一个**正在关闭 / 已关闭**的实例，而「最终只剩一个活实例」那条测试**看不见这个中间态**。

     两条路线，各自要覆盖到哪：
     - **互斥**：一把 async mutex，**必须包住对 registry 的所有读写**（含 getter 与 lazy-init），不能只包 `replace`；线性化点在临界区内。
     - **claim + compare-and-install**：**先原子地把 slot 标成 `closing`（或换成一个 replacement promise）**，再 `await dispose()`；这样 getter 要么等这个 promise、要么明确失败，拿不到将死的实例。dispose 完成后再 compare-and-install。**CAS 失败时的行为必须一并规定**：保持 winner 不动、**不再安装 `next`**、由本次调用**负责 dispose `next`**，并用返回值或异常**明确告诉调用方「这次没装上」**——不写这一条，落败的那个 `next` 就是新的泄漏源（本来要防的竞态原样搬到了另一边）。
  3. **返回被顶掉的值** —— **这只是辅助接缝，不是保证**：JS/TS 调用方可以无声忽略返回值（`setX(replacement)` 连接都不接），拿到了也可以不 dispose。选它就必须**另外证明**调用方确实 `await` 了 dispose。

  无论选哪种，**最终 oracle 都是同一个**：这场替换里**所有落败的实例（旧的、或没装上的新的）持有的资源都可观测地停了**。
- **registry pointer** —— 那个 module-level 变量本身。它只是个引用。
- **resource owner** —— 谁**负责关掉**旧资源。这才是 async 的那一层。

`src/lib/history/worker/registry.ts` 是本仓最近的一个对照，**但它只是 compare-and-clear 与角色分离的示例，不是完整正例**：`setHistoryPersistenceRuntimeForTests`（`:58-60`）是纯 injector，无条件覆盖、既不抛也不返还被顶掉的值（**上面三种做法一种都没用，安全性全靠调用方纪律**）；`resetHistoryPersistenceRuntimeForTests`（`:63-68`）是 owner reset，`await current.shutdown()` 之后 compare-and-clear。**它的失败策略恰恰是下面点名的「最糟组合」**——`shutdown()` reject 时异常直接抛出而引用仍挂着旧的死实例。照抄它的 compare-and-clear，**别照抄它的 setter 与失败处理**。

**两个函数并存不是冗余**，它们是两个不同的角色。

## 典型顺序

```
capture current            ← 先把当前实例抓在手里，之后一切都针对这个 current
  ↓
stop producer（若适用）     ← 先封住「还会产生新工作」的入口：timer、订阅、accept 循环
  ↓
drain（若适用）             ← 让已领取的工作跑完；哪些算「已领取」必须显式定义
  ↓
await dispose / shutdown   ← 真正释放资源；这里是 async 的原因
  ↓
compare-and-clear          ← if (registry === current) registry = undefined
```

**最后一步是整段的要害。** `await` 期间别人可能已经装进来一个新实例；无条件 `registry = undefined` 会把那个 replacement 一起抹掉，而且**不报错**——下一个使用者拿到 `undefined`，去 lazy-init 一个新的，症状表现为「我明明设过它」。

**失败策略必须显式写出来。** `shutdown()` 抛了怎么办？三种都可以，但必须选一种并写下理由：吞掉并继续清（保证不卡住后续测试）、抛出去（让失败可见）、或先清引用再抛。**别让它默认落到「抛出去、引用还挂着旧的死实例」**——那是三者里最糟的组合。

## 常见错误（每条都真实发生过或被评审拦下过）

1. **reset 只写 `runtime = undefined`** —— 资源泄漏。Worker 还在、timer 还在 fire、DB 还开着。下一个测试撞 `Cannot use closed database` 或看到不属于它的写入。
2. **`await old.shutdown()` 之后无条件 clear** —— 抹掉 await 窗口里装进来的 replacement。**修法就是 compare-and-clear，没有别的。**
3. **fixture 里并发 reset** —— 一组 resetter 并行 `Promise.all` 跑，而它们之间有顺序依赖（先停 producer 再关 DB）。**串行 await，并把顺序依赖显式写出来**；依赖关系只存在于某人脑子里，等于不存在。
4. **reset 不幂等** —— 重复调用时第二次对着已关闭的实例再 `shutdown()` 一次。`if (!current) return` 这类早退是必需的，不是防御性冗余。
5. **把 injector 当 owner 用** —— `setXForTests(undefined)` 被当成「重置」，于是资源永远不被关。这两件事必须是两个函数（见上面的三角色）。
6. **往非空 slot 里直接 inject** —— 第 5 条的镜像：旧实例**还没被处置**就被指针覆盖掉，owner 从此够不到它。**资源泄漏且无声**——后续任何 reset 都只作用于 replacement。
7. **旧 cleanup 清掉新实例** —— 第 2 条的一般形态：任何「先捕获、后释放」的路径都要在释放那一刻**重新确认自己释放的还是当初那个**。

## 判据（写给使用者在自己任务里执行，两个方向都要）

一条 reset 要算写对了，**正反两向各至少一条**：

- **正向 · 真的释放了**：reset 之后，被持有的资源确实停了——不是「引用没了」，是**可观测的停止**：timer 不再 fire、worker 不再响应、DB handle 已关、订阅收不到后续事件。**断言引用为 `undefined` 证明不了这一条。**
- **反向 · await 窗口里的 replacement 被保住**：在 `shutdown()` 里插一个可控的暂停点，暂停期间装进一个新实例，恢复后断言**新实例仍在**。这条不写，第 2 类错误就永远无人拦。
- **失败路径**：`dispose` reject 时的行为符合你显式选的那条策略，而不是「碰巧」。
- **替换非空 slot 不泄漏**：往一个**已持有实例**的 slot 里替换之后，**oracle 只有一个——这场替换里所有落败实例（旧的、或没装上的那个新的）持有的资源都可观测地停了**（timer 不再 fire、worker 不再响应、handle 已关）。「setter 返回了旧值」**不算**通过：返回引用只是把能力交出去，调用方完全可以忽略它或拿到后不 dispose。走 `replace` 路线的还要**单独测两件事**：① 并发——dispose 期间插入第二个 replace，断言最终只有一个实例活着、另外两个都停了；② **中间态不外泄**——dispose 进行到一半时调普通 getter，断言它**拿不到那个将死的实例**（等待、或明确失败），而不是拿到一个已关闭的 handle。第二条正是「只剩一个活实例」看不见的那一格。
- **幂等**：连调两次 reset 不抛、不重复关。

**别用「测试全绿」代替这四条**——一个只置空指针的 reset 在绝大多数套件里都是绿的，代价推迟到某个不相关的测试文件里以 `Cannot use closed database` 的形态爆出来。

## 与相邻 skill 的分工

- **`test-isolation`** —— 隔离基建（`useIsolatedRuntime` / `RESETTERS` 登记 / sandbox preload / config 与 state 两轴）。新增 module-global 单例**必须**登记 `RESETTERS`，那条规则在那边。
- **`debugging-test-pollution`** —— 已经出现「单跑绿、全套件红」时怎么定位污染者。
- **`persistence-async-invariants`** —— 持久化路径 sync→async 的不变量、settle 点与快照冻结。关机期的 producer seal / drain 分工见 skill `process-lifecycle-shutdown`（Step 1 停的是「新增工作」而不是「在途请求正在用的资源」——那条判据与本 skill 的 stop-producer / drain 是同一个道理的两个尺度）。

History registry 在本文只作**对照实例**，通用合同不绑定它的路径；换一个域（telemetry、archive、上游连接池）时照搬的是上面的顺序与判据，不是它的函数名。

## 自验：本 skill 需要实战检验的断言

以下断言写作时无法自证，只能靠**未来会话在正常使用中顺手观察**证伪。观察到一条就往 [`verification-log.md`](verification-log.md) 追加一行（记录协议以该文件为准）。**本 skill 的作者不能给自己投证实票。**

| # | 断言 | 证实长什么样 | 证伪长什么样 |
|---|---|---|---|
| V1 | 新增/修改资源型单例时它会自己浮现 | 未被点名就召回，且在写 reset **之前** | 写完 reset 才想起来；或只有被人点名才召回 |
| V2 | 「先判适不适用」那张表挡得住过度套用 | 纯值缓存的场景下明确判定不适用、走 `test-isolation` | 给一个没有资源的缓存套上了 async 生命周期 |
| V3 | compare-and-clear 这条被照做 | 新写的 owner reset 里出现了 `if (registry === current)` | 又写出无条件 clear |
| V4 | 反向判据（await 窗口 replacement）真的被验证 | 有一条测试在 `shutdown()` 中途装新实例并断言它幸存 | 只断言了「reset 后引用为 undefined」就收工 |
| V5 | 「替换非空 slot 不泄漏」这条被照做 | 用了非空即抛；或用了 `replace` 且**所有读写（含 getter 与 lazy-init）都参加同一协议**，并写明了线性化点与「CAS 失败时谁 dispose next、怎么通知调用方」 | 又写出对非空 slot 无条件覆盖；拿「setter 返回了旧值」当作已通过；或只把 `replace` 串行化而放任 getter 穿透 |
