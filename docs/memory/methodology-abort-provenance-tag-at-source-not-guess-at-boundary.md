---
name: methodology-abort-provenance-tag-at-source-not-guess-at-boundary
description: 中止的成因必须由取消方打标签、随错误对象传到边界；边界 fall-through 猜原因会在日志/History/客户端三处一致地撒谎
metadata: 
  node_type: memory
  type: project
  originSessionId: f2760de9-33a3-4ce4-8dc8-5c4cc9319da8
  modified: 2026-07-28T12:28:26.322Z
---

**取消（abort）的成因是产生点才知道的信息，必须打在错误对象上一路带到边界；边界不能用 fall-through 猜。** 猜的代价不是「信息少一点」，而是**三处一致地撒谎**（日志、History、客户端 error body 说同一个假原因），于是事后取证只能靠 `durationMs` 和配置值对表——本项目 skill 里那张「三类中止共用一条字面量、靠时长猜」的表就是这么长出来的。

2026-07-28 copilot-api-js 实例：`http2-client.ts` 的 `abortError()` 无条件合成新 `Error("The operation was aborted.")`，**丢掉 `signal.reason`**；取消方（`ctx.cancel(reason)`、reaper、shutdown Step 3）手上有 reason 却 `abort()` 空手调用。于是 `forwardError` 只能「是 AbortError 且 client signal 未 abort → 就说是上游 header 超时 504」——一条 **609ms** 的请求被报成 **900s** 超时。

**Why:** `AbortSignal.any` 把**首个中止源的 reason 对象原样透传**（Bun 实测），所以 provenance 本来就能免费传到传输层——是传输层主动扔掉的。判据「进程是否在关机中」这类**时间性**标志也不能替代**因果**证据：drain 窗口内被 reaper/deadline 取消的请求会被冒充成关机。

**How to apply:**
- 产生点：`controller.abort(taggedError)`，用 Symbol tag（`packages/foundation/src/error/{transport,cancellation}-reason.ts`，沿 `cause` 链读）而非字符串匹配。新增 tag 值时让消费端的 `_never` 穷尽守卫**编译期**逼出站点。
- 传输层：`abortError(signal)` —— `signal.reason instanceof Error` 就原样返回。**preflight（进 fetch 前已 aborted）与 mid-wait 是两个分支，mutation 要分别验**，漏掉 preflight 会让「早到的 header timeout」丢掉 `TimeoutError` 身份。
- 边界：写成**有序 precedence**（各臂不互斥：client 可以在关机期断开、header 超时可以在拆池时开火），每臂要**正向证据**；没证据的兜底臂**给一个 `unknown-abort` 之类的诚实值，别默认挑一个具体原因**——「剩下只可能是超时了」这种推理正是谎报的来源，而一条 `unknown-abort` 出现在野外本身就是「哪条路径还没接线」的线索。
- **接线要按 `传输 × 阶段` 的矩阵逐格审，别只修你手里那格**：我第一轮只修了 h2 的 pre-header + 两个边界，异模型复审用探针抓出还有三格在丢——① `guardSseIterable`（post-header，对 lifecycle signal 一律抛 reaper，害得 mid-stream 的 deadline 在**所有**流式端点被说成 reaper）② Responses 上游 WS 的握手/请求取消/first-event 超时三处重建 Error ③ legacy client 还留着时间判据。**「pre-header 修好了」不能外推成「都修好了」**，文档更不能这么写。
- 中间层想保留自己的 message（「死在哪一层」也是信息）时，**把 reason 挂 `cause` 而不是替换**——provenance 读取器都走 cause 链，两边都保住；但要注意 `error.name` 不走 cause 链，需要身份的（`TimeoutError`）必须原样透传。
- 别只修一个边界：本项目默认 `stream_commit_after_sec=180`，**post-commit 才是主路径**。
- 权威：`docs/plan/2026-07-28-shutdown-h2-teardown-and-abort-provenance.md`、skill `debugging-claude-client-connection` 的证据表。Related: [[methodology-lying-variable-name-dual-source-value]]、[[feedback-fix-all-comparison-sites]]、[[methodology-shutdown-step1-stop-new-vs-kill-inflight]]
