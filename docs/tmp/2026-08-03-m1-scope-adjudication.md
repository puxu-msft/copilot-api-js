# M1 close 权威范围裁决

> 范围：只裁决 `(a)/(b)/(c)`、三处 close-before-real 的可落地性，以及是否存在更优第四案。仓库代码与计划均只读核验；本文件是用户明确要求的唯一写入。

## 裁决摘要

**裁决：选择 (c)。** 它是三案中唯一同时让 `openAnchorIndex` 保持 owner 私有、又让 owner 从 M1 起成为真正关闭权威的方案。没有发现阻止三处 close-before-real 在 M1 迁移的代码障碍，但修订计划对 live 腿的“同一 serializer FIFO”表述需加一个限定：M1 必须让装饰器直接拿 raw `inner` 对应的 delivery port 调 `closeOpenAnchor`，随后真实帧仍经 `inner.write` 入同一 owner serializer；不能从装饰后的 sink 反查 owner，也不能继续先产出 stop 再由 legacy `writeAnchor` 写出。没有比 (c) 更好的第四案；存在一个可行的第四形状是把 `close-before-real + real start` 立即合成 owner 原子命令，但这实质上把 M4 的 allocation/remap transaction 也提前到 M1，改变既定相位边界，不优于当前“关闭先统一、M4 再融合事务”的方案。

## 1. 三案裁决

### (c) 正确

当前 owner 的关闭幂等只认 `GenerationWireState.openAnchorIndex`：`closeOpenAnchor` 在 `src/lib/pipeline/delivery/session.ts:394-407` 先以 `openAnchorIndex === undefined` 返回 `"none"`，成功写 stop 后才清空它。相反，三个 legacy close-before-real 写点只置 `anchorState.anchorClosed = true` 并直接写 stop：buffered flush 在 `src/lib/pipeline/driver.ts:1239-1244`，retreat live 写穿在 `src/lib/pipeline/driver.ts:1317-1321`，live reconcile 的判定／造帧在 `src/lib/anthropic/live-reconcile.ts:129-140`、实际写出在 `:167-174`。它们都不可能让 owner 看见“已关”；而架构守卫已经把 `openAnchorIndex` 的生产访问限制在 delivery owner，见 `tests/architecture/anchor-remap-single-authority.unit.test.ts:190-201`。因此，只迁 10 个终局调用者、保留这三处 legacy 写者，确实会留下 owner 与 legacy 两套关闭事实源。

(c) 把同一 generation 的全部关闭命令统一收口到 `closeOpenAnchor`，使“是否仍有 open anchor”只有 `openAnchorIndex` 一个裁决点；随后 M2/M3/M4 只迁 real block 的 allocation/remap，不再改变关闭权威。这与既定目标“owner 外不得直接写 anchor stop、不得读写 `openAnchorIndex`”同向，而不是迁移期例外。

### (b) 不成立

(b) 要求 legacy 调用者在写 stop 后清 `openAnchorIndex`，直接打破上述 owner 私有边界。即使把这次写入列入临时 allowlist，它仍会形成两个可以独立改变关闭状态的写者：owner 的 `closeOpenAnchor` 与三个 legacy 站点。它修掉的是本次重复字节，却保留了造成重复字节的分布式权威；用户给出的否决理由成立。

### (a) 不成立

(a) 的完整守卫 `injected && anchorBlockOpen && !anchorClosed` 会让 legacy `anchorClosed` 决定是否允许调用 owner。只要镜像漂移为 `true`，owner 即使仍持有 `openAnchorIndex` 也不会获知关闭请求；幂等裁决仍在 owner 外。owner 自己已经有精确的 no-op 分支 `openAnchorIndex === undefined → "none"`（`session.ts:399`），再以 legacy guard 截断命令既重复又引入更弱的前置权威。用户给出的否决理由成立。

需要区分：为避免在 `anchorHooks` 缺失时无法构造格式帧而保留“能否构造 stop”的格式门是合理的；保留 `anchorClosed` 作为“是否应调用 owner”的幂等门则不是。前者是能力前置条件，后者会与 owner 抢关闭权威。

阐明一个边界：(c) 并不要求 M1 删除所有 legacy 字段。`anchorBlockOpen` 仍可暂时表达“历史上曾保留 anchor index，后续 real block 仍需 shift”，`anchorClosed` 也可作为迁移镜像供尚未迁完的纯判定读取；但它们不得再决定或执行 stop 写出。修订计划在 `docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:143-177` 已按这个边界拆开“关闭写出”与“纯判定／remap bridge”。

## 2. 三个 close-before-real 站点的落地核验

### 2.1 都能调用 owner，但 port 的取得方式不同

- **buffered flush 站点 11**：`runResponseBufferedSink` 已在函数入口把 `allocationPort` 解析为 `opts.wireAllocationPort ?? getDownstreamDeliverySession(sink)?.allocationPort`（`src/lib/pipeline/driver.ts:1090-1101`）。`flushBufferedFrames` 是同一函数内闭包（`:1216-1221`），可直接捕获该 port。因此 `driver.ts:1239-1244` 能改调 `closeOpenAnchor(anchor.stopFrame(index), "before-real")`。
- **retreat live 写穿站点 13**：它与上述站点处于同一个 `runResponseBufferedSink` 作用域（`driver.ts:1280-1322`），同样能直接捕获 `allocationPort`，无接线障碍。
- **live-reconcile 站点 12**：装饰器收到的 `inner` 是 raw delivery client sink；`makeDeliverySseSink` 返回 `delivery.clientSink`（`src/lib/pipeline/client-sink.ts:485-515`），而 session 正以该对象为 WeakMap key 注册（`src/lib/pipeline/delivery/session.ts:510-513`）。handler 也明确先保留 raw `sink`，再仅把 `liveReconcilingSink(sink, ...)` 传给 driver（`src/routes/messages/handler-v4.ts:1374-1376`、`:1678-1681`）。所以 `makeReconcilingSink` 可从 `inner` 取得 owner port；不能从新建的 wrapper sink 反查，因为 wrapper 没有注册。

结论：三处都能调 owner。修订计划 `plan-3-remap-sites.md:150` 的可达性结论成立；实施说明应把 live 腿的“由 raw `inner` 取 port”写成承重细节，避免误用 wrapper。

### 2.2 `"before-real"` 确实不停心跳

`closeOpenAnchor` 只在 `mode === "terminal"` 时调用 `closeHeartbeat()`（`src/lib/pipeline/delivery/session.ts:394-401`）；`"before-real"` 路径跳过该调用。成功关闭只写 stop、清 `openAnchorIndex`、增加计数（`:401-409`），没有改 `heartbeatSuspended` 或 `heartbeatStopped`。因此该模式不会永久停止后续真实块期间的 heartbeat。

这里还需保留现有上层 suspend/resume 语义：buffered boundary／retreat flush 目前在调用 `flushBufferedFrames` 前 `suspendHeartbeat()`，后 `resumeHeartbeat()`（`src/lib/pipeline/driver.ts:1348-1351`、`:1372-1405`）；M1 把内部 stop 写出改成 owner command，不应删除外层这层“整个 flush 不插 heartbeat”的保护。`"before-real"` 本身不永久 stop，返回后 resume 仍会重臂。

### 2.3 buffered flush 与 retreat 的 stop→real 顺序由同一 FIFO 保证

serializer 实现是单 Promise chain：每次 `enqueue` 以 `chain.then(operation)` 接到队尾，并用 catch 只恢复后续可运行性，不改变提交顺序（`src/lib/pipeline/delivery/serializer.ts:10-17`）。owner 的 `closeOpenAnchor` 本身在该 serializer 上 enqueue（`session.ts:394-419`）；raw delivery sink 的普通 `write` 最终也调用同一 session 的 `write`，后者 enqueue 到同一 serializer（`session.ts:120-131`、`:449-457`）。

站点 11/13 的调用是顺序 `await closeOpenAnchor(...)` 后 `await sink.write(real)`：buffered flush 为 `driver.ts:1247-1269`，retreat 为 `:1317-1321`。改迁后，第一个 await 既保证 close operation 完成，也保证随后 real write 才提交到同一 queue。因此两处都有严格的 stop→real 顺序；即使 heartbeat 恰好在两次 enqueue 之间排队，也只能落在 stop 之后、real 之前，不会颠倒二者。buffered flush 外层 suspend 又进一步排除了该插入。

这验证的是**顺序**，不是“同一个 transaction”。M1 的目标只是先统一关闭权威；M4 才把 live close + allocation/remapped start 融为单一 owner transaction。两者不要混写。

### 2.4 live 装饰器改迁后顺序仍正确，但必须改变写法

当前 live 装饰器先让纯函数返回 `[stopFrame, remappedReal]`，再分别 `await inner.writeAnchor(frames[0])` 与 `await inner.write(frames[i])`（`src/lib/anthropic/live-reconcile.ts:167-175`）。两次调用当前已通过同一个 raw delivery session serializer，因此 wire 顺序是 stop 后 real。

M1 迁移后，正确形状是：纯函数仍可暂时保留“本帧是否触发关闭”的 legacy 判定与 `anchorClosed` 镜像置位，但装饰器不能再把 `frames[0]` 交给 `inner.writeAnchor`，否则实际 stop 仍是 owner API 外的 legacy 写出。装饰器应在该判定命中时：

1. 从 raw `inner` 取得 allocation port；
2. `await port.closeOpenAnchor((index, envelope) => envelope.anchor(hooks.stopFrame(index)), "before-real")`；
3. narrow `OwnerResult`；成功后再 `await inner.write(remappedReal)`，失败则按计划规定传播／终止，不得继续真实 start。

这样 close 与 real 仍按同一 serializer 的 FIFO 严格排列。并且 stop 的 index 来自 owner 的 `openAnchorIndex`，不再硬编码 `0`，合成 provenance 仍由 `envelope.anchor(...)` 保留。修订计划在 `plan-3-remap-sites.md:209-215` 已规定站点 12 的 owner failure 向 pump 传播，在 `:314-320` 已规定实际 stop 写出交 owner，方向正确。

**限定结论**：`docs/tmp/2026-08-03-m1-investigation-dispositions.md:37` 与 `plan-3-remap-sites.md:150` 的“排序由同一 serializer FIFO 保证”总体成立，但不是自动成立；只有采用上述 owner-port 写法才成立。若装饰器错误地对 wrapper sink 查 session，port 会缺失；若 pure transform 仍返回 stop 并由 `writeAnchor` 写，(c) 则未真正落地。

### 2.5 发现两项非结构性阻断、但 M1 必须同时修正的落地陷阱

**陷阱 A：`closeOpenAnchor` 当前没有更新 heartbeat 的 last-write 时钟。** legacy close 经 `clientSink.writeAnchor` 进入通用 `write()`，成功后会更新 `lastWriteAtMonotonic`（`src/lib/pipeline/delivery/session.ts:120-130`、`:454-457`）；owner `closeOpenAnchor` 成功后只清 `openAnchorIndex` 与 `writeCount++`，没有更新该时钟（`:401-409`）。M1 将 stop 写出从前者迁到后者后，如果不补齐，会让实际刚写出的 stop 不算一次 forward activity，heartbeat 可能按旧时钟过早排队。`"before-real"` 不停 heartbeat 这个结论仍成立，但行为等价性不成立。M1 应让成功 close 与其它 owner wire write 一样更新 `lastWriteAtMonotonic = monotonicNow()`；这是关闭 API 完整接管写出的必要组成，不是改选 (a)/(b)。

**陷阱 B：live pure transform 不能在 owner close 成功前抢先把 mirror 置为已关。** 当前 `reconcileLiveFrame` 在 I/O 前同步执行 `state.anchorClosed = true`（`src/lib/anthropic/live-reconcile.ts:129-140`），装饰器随后才写 stop。修订计划一方面说 M1–M3 保留该“关闭判定与置位”（`plan-3-remap-sites.md:166-175`），另一方面又冻结了 owner close 失败时 legacy 状态“不变”、仅成功路径由 owner mirror 置 `anchorClosed = true`（同文件 `:282-295`）。若只把装饰器的写出替换为 owner call，client-gone／wire error 前 mirror 已被纯函数改成 true，与 owner 仍持有的 `openAnchorIndex` 分岔，违反计划自己的转移表。

M1 的健康修法不是回退到 (a)，而是让 live transform 只产出“本帧触发 close-before-real”的**意图**，不预先提交 `anchorClosed`；装饰器把意图交给 owner，owner 成功或返回 `"none"` 后由 owner 的窄 mirror 收敛状态，失败保持原值并按既定错误路径退出。更简单的等价形状是：对 start／error／terminator 触发帧无条件请求 owner close，由 owner 的 `"none"` 分支做幂等，live 层不再读取／写入 `anchorClosed`。这仍不提前迁 real allocation/remap，只是彻底落实 M1 的关闭权威。

所以，对问题“有没有落地障碍”的精确回答是：**没有迫使放弃 (c) 或提前迁三腿 allocation/remap 的结构障碍；但当前修订稿漏了上述两项 M1 同步修正，按原文字面直接实施会产生 heartbeat 计时回归与 live mirror 预提交分岔。**

## 3. 第四案

我审查到的唯一实质性第四形状是：新增 owner 原子操作，把“若有 open anchor 则 close + 分配 real block + 写 remapped start”放入一次 serializer operation。它会比 M1 的两个 FIFO operation 更强，既保证顺序又保证不可插入；计划本身已为 live S3 在 M4 冻结了这个终态（`plan-3-remap-sites.md:337-383`、`:441-457`）。

但它不比 (c) 更适合作为本次修法：

1. 它仍然以“全部关闭者进入 owner”为前提，本质上是 (c) 的强化版，不是替代关闭权威的第四原则。
2. 若在 M1 全面采用，就必须同时提前三腿的 real allocation、mapping、remap 与 provenance 接线；否则只有 live 腿提前，三个腿的相位形状反而不一致。这等于合并 M1 与 M2–M4 的职责，而不是更干净地修复双写。
3. 现有两阶段安排有明确终态：M1 统一 close authority；M2/M3/M4 逐腿迁 allocation/remap；M4 再把 live close + start 融成同一 transaction。只要 M1 修掉上节两项陷阱，每一阶段的权威边界都清楚。

其余可能形状均退化为前三案：owner 读取 legacy 状态是 (a)；legacy 回写 owner frontier 是 (b)；另建共享 close registry 只是增加第三个事实源，比三案更差。

**最终裁决：无更优第四案；维持 (c)，但把 2.5 的两项同步修正写进 M1 实施依据。**

## 证据索引

- owner close 幂等与 heartbeat mode：`src/lib/pipeline/delivery/session.ts:394-419`
- owner 通用 write 的 heartbeat 时钟更新：`src/lib/pipeline/delivery/session.ts:120-130`
- serializer FIFO：`src/lib/pipeline/delivery/serializer.ts:10-17`
- buffered flush／retreat close-before-real：`src/lib/pipeline/driver.ts:1216-1270`、`:1280-1322`
- buffered owner port 作用域：`src/lib/pipeline/driver.ts:1090-1101`
- live 判定与装饰器两次写：`src/lib/anthropic/live-reconcile.ts:107-142`、`:164-178`
- raw sink 到 delivery session 的注册：`src/lib/pipeline/client-sink.ts:485-515`、`src/lib/pipeline/delivery/session.ts:510-513`
- handler 的 raw sink／wrapper 接线：`src/routes/messages/handler-v4.ts:1374-1376`、`:1678-1681`
- owner-private frontier 守卫：`tests/architecture/anchor-remap-single-authority.unit.test.ts:181-201`
- 修订计划的裁决与迁移步骤：`docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:121-177`、`:278-324`
