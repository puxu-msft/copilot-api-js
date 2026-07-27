# P3M（合并相位）—— 三腿分配 + remap × continuation frontier × anchor 生命周期

> **前置**：P1（allocator 归位）、**P2**（owner API + commit-point 语义）。**产出**：frontier 成为全链唯一权威，且 gap anchor 特性开门。
> **本文件是本合并相位的权威**：执行顺序、commit 序列与门由此规定；任务细节分列于 [plan-4-continuation-frontier.md](plan-4-continuation-frontier.md)（continuation）与 [plan-5-gap-anchor-lifecycle.md](plan-5-gap-anchor-lifecycle.md)（anchor 生命周期）。**三份文件属同一个相位**。
> **承重项 1 + 3 + 5 + 6**。live 腿必接（冻结设计 §4.2 列了 `live-reconcile.ts`，审查 F8 亦确认）。

## 为什么合并（round-3 blocker，用户 2026-07-27 拍板）

两轮尝试都证明「remap 记账」与「anchor 生命周期」在**测试可满足性**上不可分：

- **第一轮**：要求「真实 gap 静默驱动多 anchor」，但 gap anchor 在后一相位 → 造不出 offset>1，把 remap 改回硬编码 `1` 结果完全相同，mutation 不会红。
- **第二轮**：改用生产 owner API 落第二个 anchor，解决了「谁触发」，但**没解决「谁关闭」**——可重复的 `openAnchorIndex` 状态机仍在后一相位，第一个 anchor 关闭后旧的 `anchorClosed` 永久为 true，第二个 anchor 无法由生产 close-before-real 关掉 → **O-2 会先于 remap 失败**，拿不到可归因的红绿门；测试若手工写 stop，又替后一相位的承重实现干活，重新引入假绿。

**裁决：合并为一个相位。** 硬拆只会让红绿门失真。

**同时并入原 P4（continuation frontier）**——planner 判断，非范围变更：P4 撞车 oracle 的分支二（`anchor@0 → real@1 → gap-anchor@2 → real@3` + 续写腿）同样需要多-anchor 能力，与上述两项属同一条依赖链；留在链外会重蹈「门不可满足」。分支一（零 anchor 续写腿）不需要多 anchor，仍可在序列早期完成。

## 测试如何取得多-anchor 前置状态（沿用第二轮的分层，已被 reviewer 确认成立）

测试**不等 heartbeat**，直接调 **P2 的生产** owner API `allocateAndWriteAnchor` 落 anchor——那正是 M6 之后 heartbeat 要调的同一入口，经同一 serializer、真写到 sink。**真实块的分配与 remap 一律由生产代码完成，测试一行不碰**。

```text
anchor@0（测试经 owner API 落）→ real@1（上游0，生产分配）
anchor@2（测试经 owner API 落）→ real@3（上游1，生产分配）→ offset = 2
```

| 关注点 | 处置 |
|---|---|
| 是否像「手工推进 allocator」那样替实现干活？ | **不是**。被测动作 = 真实块的**分配 + remap**，100% 生产路径；测试只提供 anchor 这个前置 wire 状态。driver 漏调分配或 remap 读错 mapping，照红。 |
| 算不算测试后门？ | **不算**。它是生产 owner API，heartbeat 走的就是它；差别只在**谁触发**，不在**走哪条路径**。既有架构守卫已足够。 |
| 「谁触发 anchor」谁证明？ | **M6 的 O-3**：heartbeat 在真实 gap 静默下确实调同一 owner。M2–M4 证「给定 anchor 在 wire 上，三腿记账正确」，M6 证「anchor 会在该出现时出现」，合起来无缺口。 |
| anchor 绕 buffer 会不会与 driver buffer 冲突？ | **不会**（reviewer 独立确认）：owner operation 与 driver flush 共享 serializer，调用发生在 boundary flush 之后、下一块到来之前时 buffer 为空。 |
| 第二个 anchor 谁关闭？ | **M1 已把可重复的 open/close 状态机前移进 owner**——这正是第二轮缺的那块。生产 close-before-real 因此能正确关闭每一个 anchor。 |

## 原子 commit 序列（**每个 commit 的终态不变量与可满足的门**）

> ### 半坏窗口为空的证明（承重论证）
>
> 本相位内「某腿已迁 frontier」与「某腿仍算 +1」两种状态**在生产上数值等价**，只要生产**尚未开出第二个 anchor**：
>
> - 开门前，同一 generation 至多一个 pre-content anchor，故任一真实块的 `mapping.wireIndex − mapping.upstreamIndex ∈ {0, 1}`；
> - 未迁移腿走 **M1 引入的 bridge 判据**（`anchorsOpened() > 0 ? +1 : +0`），已迁移腿走 frontier mapping；
> - 两者**逐块相等**（bridge 的等价性证明见下方「M1 的迁移 bridge」，含 `enveloped_ping` 分支）。差异**只在 ≥2 个 anchor 时显现**，而生产开出第二个 anchor 的唯一途径是 **M6 打开心跳门**。
>
> 故 M2–M5 期间即便三腿迁移进度不一，**生产 wire 逐字节不变**（O-6 每个 commit 都跑作为该等价性的实证）。多-anchor 状态只存在于测试进程内，不是可交付的生产行为。
>
> **本序列唯一的硬序约束：M6 必须晚于 M2–M4 全部完成。** 违反它才会产生真正的半坏窗口（生产已开多 anchor 而某腿仍算 +1）。

| # | commit | 内容 | 终态不变量 | 可满足的门 |
|---|---|---|---|---|
| **M1** | `feat(delivery): repeatable anchor lifecycle and close authority in the wire owner` | ① `openAnchorIndex` 状态机 + `closeOpenAnchor` API 落在 owner；② **8 个 handler close 站点 + driver 2 处**迁到 owner close（逐站点见下方迁移表）；③ **只新增不删**旧字段 —— `anchorBlockOpen`/`anchorClosed` 保留，由 owner 在 open/close 时**一并维护**（迁移期双写）；④ 未迁移腿（S2/S3）改用 **bridge 判据** | **可编译、行为等价**：旧字段仍在且被 owner 同步维护，旧分支照常工作；生产行为零变化（心跳门未动，仍只开 ≤1 anchor） | owner 单元测试（连续两轮 open/close、close 幂等、终局 exactly-once）+ 8+2 站点各自的 close 路径回归 + **O-6 字节等价**（证零行为变化） |
| **M2** | `refactor(driver): allocate and remap buffered-flush blocks via the frontier owner` | S1（`driver.ts:1185`）分配 + remap | S1 走 frontier；S2/S3 走 bridge（数值等价，见上方证明）；**S1 的 bridge 已删** | Task 3.1 的 offset≥2 测试（M1 已使第二 anchor 能被生产正确关闭）；S1 两维 mutation 均红；O-1/O-2/O-6 |
| **M3** | `refactor(driver): allocate and remap retreat write-through blocks via the frontier owner` | S2（`driver.ts:1242`） | S2 走 frontier；**S2 的 bridge 已删**；S3 仍走 bridge | Task 3.2 + S2 两维 mutation；O-1/O-2/O-6 |
| **M4** | `refactor(live-reconcile): allocate, close off and remap live blocks in one wire transaction` | S3（装饰器 + envelope factory，见「S3 专节」） | **三腿全部走 frontier**；`rg "remap\(.*, 1\)" src/` 与 **bridge 判据均零命中** | Task 3.3 + S3 两维 mutation + 「transaction 内不可插入」断言；O-1/O-2/O-6 |
| **M5** | `fix(continuation): retire the dual offsets and the legacy anchor state fields` | plan-4 Task 4.1/4.2/4.3：退役双偏移、接 `beginLeg(kind, source)`；**并删除 M1 保留的 `anchorBlockOpen`/`anchorClosed`**（此时已无消费者） | `continuationOffset`/`wireDeliveredBlocks`/`anchorBlockOpen`/`anchorClosed` **全部零残留** | 4.1 **两条**撞车 oracle（分支二此时可满足）+ 两个 positive control + `beginLeg` 两格 mutation |
| **M6** | `feat(keepalive): allow gap anchors after the first committed block` | plan-5 Task 5.1/5.3：per-gap latch + gap injector + **删 `semanticBlockCount===0` 门**（特性开门） | 生产可开多 anchor——**此时三腿已全部走 frontier**，故无半坏 | O-3 精确形状 + 加回门的 mutation + 架构守卫 mutation（裸 `allocateAnchor` 必红） |
| **M7** | `test(anchor): cover the continuation-leg × gap-anchor integration seam` | plan-5 Task 5.4 交叉缝 | 交叉行为被锁 | O-9 交叉 mutation 矩阵（同一测试对两侧 mutation 以**不同可辨识原因**失败）+ 两条单侧 control |
| **M8** | `test(anchor): multi-gap coverage and shipped-default byte equivalence` | plan-5 Task 5.5/5.6 | 默认配置零 anchor、字节等价 | 多 gap × 混合块类型（含 tool_use 不被推迟）；O-6 |

### M1 的迁移 bridge（**round-4 blocker：原方案「M1 删字段」会让 M2–M4 期间无法编译**）

审查坐实：M1 若立刻删 `anchorBlockOpen`/`anchorClosed`，尚未迁移的 S2/S3 会**当场编译红**——它们直接读这些字段（`driver.ts:1240,1244`；`live-reconcile.ts:126,129,138`）。而「为了编译顺手改 S2/S3」等于提前做 M3/M4；改成 `openAnchorIndex !== undefined` 又**数值不等价**（pre-content anchor 关闭后该值为 undefined，但真实块仍须整体 +1——`openAnchorIndex` 表示「当前 open」，不表示「历史保留的 wire shift」）。原「半坏窗口为空」的证明假设旧分支还能工作，而 M1 恰好抽走了它读的状态。

**修法：M1 只新增不删 + 未迁移腿用 bridge 判据。**

1. **旧字段保留到 M5**：`anchorBlockOpen`/`anchorClosed` 在 M1 **不删**，改由 owner 在 open/close 时**一并维护**（迁移期双写）。旧分支照常读、照常工作 → **每步都能编译**。
2. **未迁移腿的 bridge 判据**：

   ```ts
   // 迁移期专用（M1 引入，随每腿迁移逐条删除，M4 后全仓零命中）
   const shift = wireState.allocator.anchorsOpened() > 0 ? 1 : 0
   outFrame = shift > 0 ? anchor.remap(frame, shift) : frame
   ```

   **等价性证明**：开门前（M6 之前）同一 generation 至多一个 anchor，故 `anchorsOpened() ∈ {0,1}`。
   - `anchorsOpened()===1` ⟺ 曾开过 pre-content anchor ⟺ 旧门 `injected && anchorBlockOpen` 为真 → 两者都给 `+1`；
   - `anchorsOpened()===0` ⟺ 从未开 anchor → 旧门为假 → 两者都给 `+0`；
   - `enveloped_ping` 模式：只注入 message_start envelope、**不开 anchor 块**，故 `anchorsOpened()===0` 且旧门的 `anchorBlockOpen` 为 false → 两者都给 `+0`（**这条最易漏，已核实**：`keepalive-anchor.ts` 的 envelope injector 置 `injected` 但不置 `anchorBlockOpen`）。

   三种情形逐块相等 → bridge 与旧门**行为等价**，M2–M4 期间生产 wire 逐字节不变（O-6 每 commit 实证）。
3. **逐腿删除**：每迁完一腿立刻删该腿 bridge；**M4 收口后全仓 bridge 零命中**（`rg -n "anchorsOpened\(\) > 0" src/` 为空），旧字段随 M5 一并退役。
4. **架构守卫**：bridge 判据只允许出现在**尚未迁移**的站点；M4 之后出现任何 bridge 命中即 fail。

#### 迁移期双写的精确状态转移表（**round-5 major：双写是经典分岔源，必须写死**）

M1–M4 期间 owner 是 legacy 字段的**唯一写者**；下表规定每个 owner 操作**结束后**四个状态的取值。任何偏离即 bug，不留解释空间。

| owner 操作 | `openAnchorIndex` | `anchorBlockOpen` | `anchorClosed` | `injected` |
|---|---|---|---|---|
| 初始（generation 开始） | `undefined` | `false` | `false` | `false` |
| `allocateAndWriteAnchor` **成功**（pre-content 或 gap） | `= 分配的 index` | `true` | **`false`**（重新武装——旧语义是一次性，多 anchor 下每次开新 anchor 都要复位） | `true` |
| `allocateAndWriteAnchor` **失败**（pre-commit） | 不变 | 不变 | 不变 | 不变 |
| `allocateAndWriteAnchor` **失败**（post-commit） | `undefined`（该 anchor 不再可关） | `true`（历史 shift 已产生，**不得回退**） | `true` | `true` |
| `closeOpenAnchor` 返回 `"closed"` | `undefined` | **`true`**（**关键**：它表示「历史上保留过 wire shift」，**关闭后仍为 true**——这正是 bridge 等价性依赖的那一位） | `true` | 不变 |
| `closeOpenAnchor` 返回 `"none"` | `undefined`（本就是） | 不变 | 不变 | 不变 |
| `closeOpenAnchor` 返回 `"write-error"` | `undefined` | 不变（`true`） | `true` | 不变 |
| `withAllocatedRealBlock` / `beginLeg`（任何结果） | 不变 | 不变 | 不变 | 不变 |

**三条承重解读**（写出来防实施期误解）：

- **`anchorBlockOpen` 在 close 后保持 `true`**——它的旧语义就是「index 0 已被保留」（`types.ts:444` 原注释：*stays TRUE for the whole stream once set*），**不是**「当前有 open block」。若 close 时把它置 false，S2/S3 的旧门会在 pre-content anchor 关闭后突然算 `+0`，与 bridge 的 `+1` 分岔——**这正是「anchor 已关闭但历史 shift 仍为 1」那个窗口**。
- **`anchorClosed` 每次开新 anchor 时复位 `false`**：旧代码用它做一次性守卫，多 anchor 下必须每轮重新武装，否则第二个 anchor 的 close 被短路（这正是 round-3 blocker 的成因）。M1–M4 期间生产只开 ≤1 anchor，故该复位在生产上不可观测，但**测试经 owner API 落第二个 anchor 时会走到**，必须正确。
- **post-commit 失败不回退 `anchorBlockOpen`**：与 C9 档 ② 一致——字节已出，历史 shift 是既成事实。

- [ ] **守卫（round-5 major）**：`legacy 字段唯一写者`——`src/` 下对 `anchorBlockOpen` / `anchorClosed` 的**赋值**（`=` 左侧）有且仅出现在 delivery owner 一处；其余站点**只读**。带**正样本对照**：故意在 driver 里加一处赋值，守卫必须转红。
- [ ] **转移表 oracle**：逐行驱动 owner 操作，断言四个状态的取值与上表**逐格相同**（含两种失败路径）。这是 bridge 等价性的直接支撑，不能只靠 O-6 间接证明。

> **为何不选「M1+M2–M4 合成一个原子 commit」**（reviewer 给的另一条路）：那会把三腿迁移 + 状态机 + 8 站点 close 迁移压进单个 commit，diff 巨大且**失去逐腿 mutation 的可归因性**（6 格矩阵要能指出是哪一腿漏了）。bridge 方案保住每步可编译 + 每步门可满足 + 逐腿可归因，代价只是一段生命周期明确、有守卫、M4 即清零的迁移期代码。

### M1 的逐站点 close 迁移（**round-4 blocker：owner close API 缺失 + 站点迁移无具名步骤**）

reviewer 核实（planner 复核确认）：**所有 close 调用点都在 sink 构造之后**——两条 stream 路径都先 `makeAnchoredSseSink`，随后闭包/pump 内才调用。故 port 可达性**不是问题**（我上轮的担忧未坐实），真正缺的是 owner 的 close API（已在 P2 冻结 `closeOpenAnchor`）与逐站点迁移步骤。

| # | 站点 | 现状 | M1 改法 |
|---|---|---|---|
| 1 | `handler-v4.ts:667` | pre-response 错误终局前 `closeAnchorIfOpen` | `getDownstreamDeliverySession(sink)` 取 port → `closeOpenAnchor(buildStop, "terminal")` |
| 2–8 | `handler-v4.ts:1352 / 1450 / 1477 / 1530 / 1633 / 1671 / 1715` | pump 的 7 个终端分支 | 同上（**逐个改，不合并**——每个分支的前置条件不同，合并会掩盖某条路径漏改） |
| 9 | `driver.ts:1361` | driver 终端 close | driver 直接持 port（无需经 sink 查） → `closeOpenAnchor(_, "terminal")` |
| 10 | `driver.ts:1515` | 失败返回前 close | 同上 |
| 11 | `driver.ts:1162-1182` `closeAnchorBeforeReal` | flush 内 per-frame close | `closeOpenAnchor(_, "before-real")`（M2 随 S1 迁移时接） |

**要点**：
- `"terminal"` 模式与 **P6 的永久 heartbeat stop 合成一个 owner command**——否则 stop 帧与新 tick 可能交错。
- **exactly-once 由 API 保证**：第二个调用者见 `openAnchorIndex === undefined` 得 `"none"`。这取代了原先跨站点共享 `anchorClosed` 的手工幂等。
- **架构守卫**：生产代码**不得**在 owner 外读写 `openAnchorIndex` 或直接写 anchor stop 帧（带正样本对照）。

**若某 commit 的门实测不可满足**（例如 M2 的 offset≥2 场景仍拿不到红），**停下回报**——那意味着仍有未识别的依赖，**不得**靠手工补状态硬凑绿。

## 三腿的「分配 + remap」矩阵

原方案只枚举 remap、**漏了 allocate**（round-1 major）：`mapping` 只有在开块时被创建才能供后续 delta/stop 查，仅把硬编码 `1` 换成 resolver **不会自动创建 mapping**，S2/S3 会读到缺失或旧 mapping。故每条腿都必须具名回答三个问题：
| 腿 | start 帧谁分配？ | delta / stop 如何查 mapping？ | 如何保证同一块不重复分配？ |
|---|---|---|---|
| **S1** driver buffered flush（`driver.ts:1185`） | flush 循环内 `anchor.isContentBlockStart(frame)` 为真时经 owner API `withAllocatedRealBlock(upstreamIndex, …)` | 非 start 帧**经 owner `writeBlockFrame(leg, upstreamIndex, frame)`**（owner 内按**显式 leg** 查 mapping → remap → 写 → stop 成功后释放）；调用方不碰 registry、也不依赖 owner 记「当前腿」 | 一个 upstream 块只有一个 start 帧；重复分配会被 3.4 维度 B 的 mutation 咬住 |
| **S2** driver retreat（`driver.ts:1242`） | retreat 写穿循环内同样在 start 帧上调 owner API（**原 plan 漏此步**） | 同 S1（**retreat 不换 leg**，故 buffered 阶段登记的 mapping 照常可查 —— C10 ④） | 同 S1；retreat 前已 flush 的块**不得**再分配（buffer 已清空，结构上不会重入——**须有测试**） |
| **S3** live-reconcile（`live-reconcile.ts:141`） | 装饰器 `makeReconcilingSink` 经 `getDownstreamDeliverySession(inner)` 取 port，在**一个 transaction** 内完成「close-off stop + 分配 + remapped start」（见下方 S3 专节） | 同 S1 | live 腿逐帧透传，一个块一个 start |

### S3 专节（**round-2 major：原方案站不住，已重做**）

原方案写「`reconcileLiveFrame` 是纯函数 → 分配归装饰器」，方向对但**与冻结的 owner API 形状不兼容**。planner 复核了三条代码事实：

1. **port 可达**（reviewer 结论成立）：`makeDeliverySseSink` 返回 `delivery.clientSink`，`deliveryBySink` 正以它为 key（`session.ts:262`）；而 `makeReconcilingSink(inner, …)` 的 `inner` **就是**这个原 delivery sink（`handler-v4.ts:1206-1207`）。故装饰器可经 `getDownstreamDeliverySession(inner)` 拿到 session。**不需要**让 wrapped sink 再注册一次。
2. **真正的冲突在 provenance**：`reconcileLiveFrame` 对首个真实 start 返回**两帧** `[stopFrame, remapped]`（`live-reconcile.ts:139-141`），且装饰器靠**位置**区分它们——`frames[0]` 走 `writeAnchor`（打 `synthetic:"anchor"`），其余走 `write`（不打标）（`:171-174`）。而原 `allocateAndWriteRealBlock(upstreamIndex, build)` 的 `build` 只返回 `ReadonlyArray<ClientFrame>`，**丢失 provenance**，owner 无从知道哪帧该走哪个底层 port。
3. **拆成两次写会破坏原子性**：若装饰器先单独写 stop 再调 port 写 start，就是**两个 serializer operation**，heartbeat 可插进中间——正是 C5 要消灭的形状。（注：今天的装饰器确实是两次 `await`，但今天没有分配动作，所以只是顺序问题；引入分配后它就成了 TOCTOU。）

**API 形状**（P2「Interfaces」是权威定义，此处摘要其对 S3 的意义）：

```ts
withAllocatedRealBlock(
  upstreamIndex: number,
  build: (ctx: { mapping: WireBlockMapping; envelope: WireEnvelopeFactory }) => ReadonlyArray<WireWriteSpec>,
): Promise<WireBlockMapping | undefined>
```

**round-3 major 修正——callback 不返回 `DeliveryFrame`，返回 owner 定义的窄 write spec**：

planner 独立核实：`DeliveryFrame`（= `ClientFrameEnvelope`）必填 `sequence` / `observedAtMonotonic` / `provenance`（`frame-envelope.ts:22-26`）。`createClientFrameEnvelope` 虽是公开导出、**类型上**可构造，但真实构造逻辑 `makeEnvelope` / `asDeliveryFrame` 都是 `delivery/session.ts` **私有**（`:229-247`），且装饰器既没有 candidate/dispatch id，也不持有 delivery 的 `monotonicNow`。若让装饰器自填 `sequence: 0` / `candidateId: "legacy"`，虽能跑通，却把 **provenance 与序号的铸造责任放错层**，违反 richest-data-flow（owner 才拥有时钟与信封路由）。

故 callback 只提供**内容 + 语义分类**，信封由 owner 铸造：

```ts
/** What the caller wants written; the owner mints the envelope (sequence / clock / provenance). */
export type WireWriteSpec =
  | { readonly kind: "real"; readonly frame: ClientFrame }
  | { readonly kind: "anchor"; readonly frame: ClientFrame }        // synthetic close-off / open
  | { readonly kind: "keepalive"; readonly frame: ClientFrame }

/** Optional sugar handed to the callback so call sites read declaratively. */
export interface WireEnvelopeFactory {
  real(frame: ClientFrame): WireWriteSpec
  anchor(frame: ClientFrame): WireWriteSpec
  keepalive(frame: ClientFrame): WireWriteSpec
}
```

owner 按 `kind` 路由到既有的 `write` / `writeAnchor` / `writeKeepalive`（`session.ts:257-278` 的 `writeToSink` 已是这个形状），**并在内部补齐 `sequence`、`observedAtMonotonic`、`provenance`**。于是：

- S1/S2 的 callback 返回 `[envelope.real(remappedStart)]`；
- S3 返回 `[envelope.anchor(stopFrame), envelope.real(remappedStart)]`——**一个 transaction、正确 marker、不靠数组位置猜**；
- gap injector（M6）返回 `[envelope.anchor(start), envelope.keepalive(delta)]`。

**三腿与 injector 共用同一 owner API，无特例分支。** 装饰器不再伪造任何 metadata。

> **S3 已无「拿不到就停」的退路**：port 可达性与信封铸造责任都已定型，S3 是冻结必做范围。

## 三个站点（master 精确行号）

| # | 站点 | 当前代码 | 触发条件 |
|---|---|---|---|
| S1 | driver buffered flush | `driver.ts:1185` `let outFrame = injected && anchor && anchorBlockOpen ? anchor.remap(frame, 1) : frame` | 每次 boundary/terminal flush 的每一帧 |
| S2 | driver retreat 分支 | `driver.ts:1242` `await sink.write(anchorState.injected && anchor && anchorState.anchorBlockOpen ? anchor.remap(toWrite, 1) : toWrite)` | buffer cap 超限后的 live 写穿 |
| S3 | live-reconcile | `live-reconcile.ts:141` `out.push(hooks.remap(frame, 1))` | live 路径（非 buffered）的每一真实帧 |

三处都是硬编码 `1`。C4：这个 `1` 与 `continuationOffset` 两个独立偏移都要被 frontier 取代（continuation 侧在 P4）。

## Files

- Modify: `src/lib/pipeline/driver.ts`（S1 + S2）
- Modify: `src/lib/anthropic/live-reconcile.ts`（S3）
- Modify: `src/lib/pipeline/types.ts`（若 `ReconcileHooks` 需要携 allocator 访问）
- Test: 改写 `tests/pipeline/retreat-anchor-collision.it.test.ts`、`tests/pipeline/live-reconcile-collision.it.test.ts`、`tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` 的 index 断言；新 `tests/pipeline/remap-sites-mutation.it.test.ts`

---

## Task 3.1：S1 driver buffered flush（分配 + remap）

> **测试纪律（两轮 review 综合）**：被测动作 = **真实块的分配 + remap**，必须 100% 由生产路径完成——**禁止**手工推进 allocator（那会让测试准备替实现干活，生产漏分配照样绿）。但 anchor 这个**前置 wire 状态**由测试经 **P2 的生产 owner API** `allocateAndWriteAnchor` 落下（理由与防假绿论证见本文件头部「round-2 blocker」小节）——**不是**等 heartbeat，因为 gap anchor 要到 P5 才开放，等它会造成红绿门不可满足。

- [ ] **Step 1: 写失败测试** —— offset >= 2 的场景，真实块全由生产路径分配 + remap

```ts
// tests/pipeline/remap-sites-mutation.it.test.ts
test("S1 buffered flush allocates and remaps real blocks itself at frontier offset >= 2", async () => {
  // 前置（测试经生产 owner API 落 anchor，不碰 allocator 内部）：
  //   await port.allocateAndWriteAnchor(...)         → anchor@0
  //   驱动上游真实块（上游 index 0）                  → 生产分配 wire@1
  //   await port.allocateAndWriteAnchor(...)         → anchor@2
  //   驱动上游真实块（上游 index 1）                  → 生产分配 wire@3   ← offset 2
  assertMonotonicWireIndices(frames)   // 硬编码 +1 会让第二块落已被占用的 wire@2 → 红
  assertBlockProtocolState(frames)
  // 前置断言：两个 anchor 确实在 wire 上（证明场景真的建立起来了）
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——start 帧经 owner API `withAllocatedRealBlock`；非 start 帧走 `resolveRemappedFrame`。
- [ ] **Step 4**：跑，绿；`anchor-multiblock-lifecycle.it.test.ts` 预期仍绿（pre-content-only 场景 offset 仍是 1）。
- [ ] **Step 5: 提交** → `refactor(driver): allocate and remap buffered-flush blocks via the frontier owner`

## Task 3.2：S2 driver retreat 分支（分配 + remap）

> retreat 是「buffer cap 超限 → 放弃缓冲 → 剩余帧 live 写穿」。它的 anchor 语义已由 `retreat-anchor-collision.it.test.ts` 锁住（避免双 message_start + index 撞车）。

- [ ] **Step 1: 写失败测试**：retreat 发生在 **gap anchor 已开过一次之后**，断言写穿的真实块 index 走 frontier；**并断言 retreat 前已 flush 的块没有被二次分配**（frontier 无跳号）。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——start 帧经 owner API 分配（**原 plan 漏此步**），其余帧走 `resolveRemappedFrame`。
- [ ] **Step 4**：跑，绿 + `retreat-anchor-collision.it.test.ts` 回归。若该文件的断言写死了 `+1`，**改写为 frontier 断言（非删除）**。
- [ ] **Step 5: 提交** → `refactor(driver): allocate and remap retreat write-through blocks via the frontier owner`

## Task 3.3：S3 live-reconcile（设计正文漏、审查补）

> **为什么 live 腿仍要接**：块级 buffered 是既定终态，但 ① 迁移期 live 仍是当前生产默认（`protectStreamingGeneration: false`）；② retreat 之后的续流走 live 写穿；③ 留一个算 `+1` 的站点就是 C4 的反例，未来必然被误读。项目「无向后兼容负担 / 不留双轨包袱」。

- [ ] **Step 1: 写失败测试**（**用生产 delivery sink，非 raw sink**）：live 路径下 offset >= 2 的场景（anchor 经 owner API 落，真实块由生产路径分配 + remap），断言：
  - `assertMonotonicWireIndices` + `assertBlockProtocolState`（delta/stop 必须落在同一 wire index，orphan delta 会被咬住）；
  - **close-off stop 带 `synthetic:"anchor"` 标记**，remapped start **不带**标记（C7；这是本 task 最容易在重构中丢的东西）；
  - close-off 与 real start **在同一个 serializer transaction 内**——用一个在两帧之间尝试插入 keepalive 的探针证明它插不进去。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——
  - **取 port**：装饰器经 `getDownstreamDeliverySession(inner)` 拿 session 的 allocation port。`inner` 就是原 delivery sink（`handler-v4.ts:1206-1207` → `makeDeliverySseSink` 返回的 `delivery.clientSink`，正是 `deliveryBySink` 的 key，`session.ts:262`），故可达。
  - **一个 transaction 出两帧**：装饰器在见到真实 `content_block_start` 时调 `withAllocatedRealBlock(upstreamIndex, ({ remap }) => [...])`，callback 返回**带 provenance 的 `DeliveryFrame`**：需要 close-off 时返回 `[anchorStop(synthetic:"anchor"), remap(start)(真实)]`，否则只返回 `[remap(start)]`。owner 按 provenance 路由到 `writeAnchor` / `write`，**不再靠数组位置猜**。
  - **`reconcileLiveFrame` 保持纯函数**：它继续负责「要不要 close-off」+ remap 变换，只是 remap 改用绑定到本块 mapping 的 `resolveRemappedFrame`；**副作用（分配 + 写）全在装饰器的 transaction 内**。
  - **非 start 帧**（delta/stop/终止符）仍走装饰器的普通 write 路径，remap 按该块 mapping 查。
  - **注意 `hooks` 是 `ReconcileHooks` 不是 `AnchorHooks`**：核实两者 `remap` 签名一致后直接复用；若不一致，扩 `ReconcileHooks` 而非在 live 侧另写判断逻辑（单一权威）。
- [ ] **Step 4**：跑，绿 + `live-reconcile-collision.it.test.ts` / `live-post-commit-anchor-closeoff.http.test.ts` 回归（结构断言按需改写）。
- [ ] **Step 5**：mutation——把两帧拆成两次独立写（今天的形状），确认「transaction 内不可插入」的断言转红。
- [ ] **Step 6: 提交** → `refactor(live-reconcile): allocate, close off and remap live blocks in one wire transaction`

## Task 3.4：退役 P1 的桥接断言 + **双维** mutation 矩阵

- [ ] **Step 1**：把 P1 的 `anchor-allocator-bridge.it.test.ts` 从「offset 恒等于固定 1」改写为「offset 等于 frontier 记账值」（**改写非删除**，它现在锁的是 C4）。
- [ ] **Step 2**：建 **6 格** mutation 矩阵——三条腿 × 两个维度（plan review major：只 mutate remap 不足以证明分配已接线）：
  - **维度 A（remap）**：把该站点的 `resolveRemappedFrame` 改回硬编码 `anchor.remap(frame, 1)`。
  - **维度 B（allocate）**：**删除**该站点的 `withAllocatedRealBlock` 调用（保留 remap）。这一维专门咬「mapping 从未被创建」的漏接线——原 plan 完全没有它。
  - 每格逐一确认**至少一条测试转红**，并记录是哪条。某格不打红 → 该维度无覆盖，补测试，不得跳过（`plan 红绿预测可能错、执行期真跑验证`）。
- [ ] **Step 3**：把矩阵结果写进本文件下方表。
- [ ] **提交** → `test(anchor): 6-cell mutation matrix over allocation and remap on all three legs`

## Task 3.5：golden 重捕

- [ ] **Step 1**：先跑 O-1/O-2 确认新 wire 结构正确（**顺序不可颠倒**——先证结构对，再改 golden）。
- [ ] **Step 2**：重捕 `tests/pipeline/buffered-anchor-golden.it.test.ts` 与受影响的 `c0-live-anchored-direct-stream-golden.http.test.ts`。
  - **预期**：pre-content-only 场景**不应有字节变化**（allocator 在该场景算出的 offset 就是 1）。**若这两个 golden 意外变红，那是回归信号而非预期重捕**——停下查根因，不要重捕。
- [ ] **Step 3**：重捕（如确有预期变化）单独一个 commit，与实现 commit 分离，让 diff 可审。
- [ ] **提交** → `test(anchor): re-capture goldens for the frontier wire`（仅在确有预期变化时）

## mutation 矩阵（实施期填写；**6 格**）

| 站点 | 维度 A：remap 改回硬编码 `1` | 维度 B：删除 allocate 调用 |
|---|---|---|
| S1 driver flush | _待填：转红的测试_ | _待填_ |
| S2 driver retreat | _待填_ | _待填_ |
| S3 live-reconcile | _待填_ | _待填_ |

## M2–M4 收口（三腿迁移；相位总收口见下）

- [ ] `typecheck` + `test:fast` 绿；anchor 全套件与基线对账（每处差异归因为「预期改写」或「回归已修」）。
- [ ] O-1/O-2 绿；O-6 字节等价**仍等于 P0 捕获的 base 基线**（本相位对无-anchor **主腿**请求应零字节变化）。
- [ ] `rg -n "remap\(.*, 1\)" src/` 零命中。
- [ ] **6 格 mutation 矩阵填满**，无空格（空格 = 该维度无覆盖）。

## P3M 相位总收口

- [ ] M1–M8 **八个 commit 全部落地**，每个终态 typecheck + `test:fast` 绿，且其「可满足的门」实测通过（非推理认定）。
- [ ] O-1 / O-2 / O-3 / O-6 / O-9 绿。
- [ ] **零残留 grep 全绿**：`remap\(.*, 1\)` / `continuationOffset` / `wireDeliveredBlocks` / `anchorBlockOpen` / `anchorClosed` / **迁移期 bridge 判据**（`anchorsOpened\(\) > 0`）在 `src/` 均零命中。
- [ ] **close 权威唯一**：生产代码在 owner 外无任何 anchor stop 写出、无 `openAnchorIndex` 读写（架构守卫 + 正样本对照）。
- [ ] **mapping registry 唯一访问者**：owner 外无任何 mapping 读写；三腿的非-start 帧全部经 `writeBlockFrame`（架构守卫 + 正样本对照）。
- [ ] **provenance 真实**：History generation 轨中 **primary / recovery / continuation** 三腿的真实块各带真实 candidateId/dispatchId（主腿 ≠ 续写腿），`"legacy"` 仅出现在既有兼容 helper 一处；无活跃 leg 时分配/写块被拒绝。
- [ ] **跨腿 mapping 隔离**：`writeBlockFrame` 按**显式 leg** 解析；改回 ambient 当前腿的 mutation 必须转红。
- [ ] **legacy 字段唯一写者**（M1–M4 期间）：`anchorBlockOpen`/`anchorClosed` 的赋值只出现在 owner；转移表逐格 oracle 绿。
- [ ] 6 格 mutation 矩阵 + 交叉 mutation 矩阵**填满无空格**。
- [ ] anchor 全套件与 P0 基线对账完毕（每处差异归因为「预期改写」或「回归已修」）。
- [ ] **硬序约束已遵守**：M6 的开门 commit 晚于 M2–M4。

