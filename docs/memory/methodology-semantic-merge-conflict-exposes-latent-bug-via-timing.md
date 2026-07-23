---
name: methodology-semantic-merge-conflict-exposes-latent-bug-via-timing
description: "并发合并里「两边各自正确、合并却坏」的语义冲突——静态代码逐字节等于一侧却行为不同,根因常是运行时数据/时序,须 instrument 探针定位而非死盯 diff;且合并会暴露对方 timing 侥幸遮住的潜伏 bug"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 94958083-ca97-4758-b68a-d16d4e08a2e0
  modified: 2026-07-19T05:29:05.711Z
---

并发合并（isolated worktree 把高频推进的 master 合回分支）里最坑的不是机械冲突（冲突标记 diff3 就能解），而是**语义冲突：两侧各自单独测都绿、合并结果却坏**。踩坑实例（History V2 removal 合并 master 的 compact-storage）：合并后 `chat-completions-v4 double-track` / `reactive-retry-leg` 两个 history 测试挂在 `upstreamRequest.messages` / 失败 attempt `rawBody` 为 undefined。

**关键教训**：

1. **静态 diff 逐字节等于一侧 ≠ 行为相同**。我反复 `diff <(git show master:projection.ts) projection.ts` 确认 projection 投影代码与 master 逐字节一致,却仍失败——因为**根因在运行时数据/时序,不在这个文件的静态代码**。死盯 diff 会陷入「代码明明一样为什么坏」的死循环。**破法：instrument 探针**（临时往 projection/test 里塞 `console.error(JSON.stringify(...))`,`process.env.XDBG` gate,跑完 `cp backup 还原`）打印真实运行时值——一次就看清 `requestMeta`/`requestBody`/`requestProjection.messages` 各是什么,立刻定位到「responses 格式 payload 存 `input` 非 `messages`」。

2. **合并暴露对方 timing 侥幸遮住的潜伏 bug**。根因是 peer 的 compact-storage 故意把 metadata 做 lean（`messageCount` 而非完整 `messages`，靠内容寻址 payload 去重），projection 从 payload 读回——但 payload-read 只处理 `messages` 形状、漏了 responses 的 `input` 形状。**master 自己的测试通过纯属侥幸**：`getHistory` 在 async drain 持久化之前返回 in-flight entry（有完整 messages）。**证法**：在纯 master 上 `await drainV3Writer()` 强制持久化后再读 → 同样失败,证明是 master pre-existing bug、非合并引入。合并只是把读取时序移到了已持久化 record 从而暴露它。

3. **判「谁引入」必在纯父分支各自复现**。别信「我改的文件 diff 干净所以不是我」——用独立 worktree checkout 纯 base/master 跑失败测试。相同失败=pre-existing;只在合并态失败=语义冲突需修。这也适用 review 的绝对断言（reviewer 说「pre-existing」我仍在纯 `a387a6da` 亲验）。

4. **修法：补全对方设计而非回退**。设计分叉（我 richest-data-flow 全存 vs peer lean+payload-read）表面对立,但深挖 peer 意图（CAS 去重合理）后,正确解是**在 projection 补全 payload-read**（`messages ?? input`、rawBody fallback 到 error payload），既保 peer 去重、又完成其设计、修其 bug——route-variant-to-existing-outcome。不是二选一。

5. **`test:backend` 口径 ≠ 全量 `bun test`**。本项目 `test:backend = bun test .unit.test .it.test .http.test`,**显式排除 `.e2e.test.ts`**。声称「0 fail」须标口径;全量跑才含 e2e。

**Why**: 并发高频合并是本仓库常态（十几个 peer worktree 同改 history/V3）,语义冲突比机械冲突隐蔽得多、且能揭示对方潜伏缺陷。
**How to apply**: 合并后测试挂而 diff 干净 → 立刻 instrument 探针看运行时值,别死盯 diff;判归属去纯父分支复现;修法优先补全对方设计。相关 [[methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit]]、[[feedback-richest-data-flow-store-complete-no-pruning]]、[[git-commit-pathspec-commits-worktree-not-index]]。
