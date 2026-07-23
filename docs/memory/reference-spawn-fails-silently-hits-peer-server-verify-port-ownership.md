---
name: reference-spawn-fails-silently-hits-peer-server-verify-port-ownership
description: 起隔离测试服务器端口被 peer 占用时 launcher 静默失败、请求打到 peer 的 mock 服务器上、health 仍绿，须先验端口归属再信数据
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2d448603-e703-4917-9c68-76e079e8823b
---

live-GHC 探针起隔离测试服务器时，若目标端口已被**另一个并发会话**的服务器占用，我的 launcher 会静默失败（server.log 里 `Failed to start server on port <N>. Is the port already in use?`，但 stdout health check 仍返回 `healthy`——那是 peer 的实例在应答），我的请求于是全打在 **peer 的服务器**上。踩坑实况：4142 上是 peer 2.5h 前起的 `bun run src/main.ts start --port 4142 --ghc-api-base-url https://localhost:8799`——`--ghc-api-base-url` 指向**本地 mock**、不是真 GHC，我的「真实计费探针」静默变 mock，ping 洪流/卡死其实是那个 mock 的行为，前几轮 probe 数据**全作废**。

**Why:** 这是 skill `live-ghc-e2e-verification` 头号盲点 `live=旧码` 的一个变体——`live=peer 的 mock 服务器`。health 绿 + 请求能路由 + History 有 entry 全都不能证明「打的是我的新码 + 真 GHC」，因为一个**别人的**working 实例正在同端口应答。concurrent-sessions 行级共存纪律下，同机常有多个 peer 测试服务器占着高位端口。

**How to apply:** 起隔离服务器**紧接着**必做三验，任一不过就换端口重起，绝不拿数据当真：① `grep -iE 'port .* in use|Failed to start' "$TESTDATA/server.log"` 确认我的 launcher 真绑上了、没因端口占用失败；② `ss -tlnp | grep ':<port>'` 拿到**真正监听的 PID**，比对它是不是我刚 spawn 的那个（父子进程树里 `cat server.pid` 是 launcher、`ss` 给的才是真监听子进程）；③ dump 一条 History 上游轨确认**无** `synthetic:"hook-mock"` 且 `attempts[].upstreamRequest` 打的是真 GHC base url（非 localhost mock）。spawn 前先 `for p in <候选端口>; do ss -tlnp|grep -q ":$p " && echo busy||echo free; done` 挑确认空闲的端口。清理只精确杀自己 PID（[[git-commit-pathspec-commits-worktree-not-index]] 同源的「只动自己的」纪律），**绝不**碰 peer 的端口/PID。关联 [[feedback-pass-null-clean-not-self-validating]]：health 绿是「声音权威」、不自证真码真上游。
