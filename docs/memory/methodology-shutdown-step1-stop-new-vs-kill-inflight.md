---
name: methodology-shutdown-step1-stop-new-vs-kill-inflight
description: 关机 Step 1 的「停止后台服务」若拆掉在途请求正在用的资源，就是用 Step 1 撕毁 Step 2 的 drain 承诺；判据是 stop-new 还是 kill-inflight
metadata: 
  node_type: memory
  type: project
  originSessionId: f2760de9-33a3-4ce4-8dc8-5c4cc9319da8
  modified: 2026-07-28T12:28:01.104Z
---

**分阶段关机里，Step 1「停后台服务」的每一项都要过一道判据：它停的是「新增工作」，还是「在途请求正在用的资源」？** 后者会让 Step 2/3 承诺的 drain 变成空话——请求在 Step 1 就死了，根本活不到被 drain。

2026-07-28 实例（copilot-api-js，History `req_1785234916721_3573`）：`gracefulShutdown` Step 1 调 `closeHttp2Sessions()` → `poolEpoch++` → 所有**正在建 session** 的在途请求当场抛 abort。已建流的不受影响（`session.close()` 是 graceful GOAWAY），所以症状很隐蔽：**同一时刻的兄弟请求活得好好的**（一条早 76ms 起的请求继续跑了 7.5s 成功），只有还在 TLS 握手的那条 539ms 猝死。而 `maxConcurrentStreamsPerSession=1` 意味着「只要有并发，每条新请求都在这个窗口里」——常态，不是边缘。

**Why:** 同一文件里就有正确对照——上游 WS 在 Step 1 只 `stopNew()`、`closeAll()` 留到 Step 4/finalize。**这种同族不对称本身就是最好的红旗**：同一类资源，一个做了 stop-new/close-all 拆分，另一个直接 close-all，多半是后者错。

**How to apply:**
- 逐项问「这个 stop 会不会让一条**已被接纳**的在途请求失败？」会 → 挪到 Step 4/finalize（保留幂等的第二次调用，覆盖自然 drain 跳过 Step 4 的路径）。
- 取证套路：History 里找**同一时刻的兄弟请求**——它们成功而这条失败，就排除了全局 teardown，指向「只杀某个特定生命周期阶段」的机制。再用 `新进程启动时刻 - incident 时刻 ≈ gracefulWait + abortWait + finalize` 确认那真是一次完整关机。
- 邻居仍未查证（见 `docs/todo/deferred-backlog.md`）：`stopRefresh()`、`peekUpstreamWsManager()?.stopNew()`。
- 权威：[docs/lifecycle.md](../lifecycle.md) Step 1 注 + `docs/plan/2026-07-28-shutdown-h2-teardown-and-abort-provenance.md`。Related: [[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth]]
