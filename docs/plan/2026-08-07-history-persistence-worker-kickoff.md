# Kickoff：History Persistence Worker 渐进实施

> 状态：Batch 0、1a、1b 已完成；Batch 1b 已于 2026-08-08 落地 `master@d3b4ac77`，其状态回填提交 `542007c9` 已由原文档 reviewer 逐条核验并判 0 blocker／major。允许按启动前硬门开始 Task 2a。`REVIEWED_PLAN_COMMIT=542007c9be26c16c9e1acf8378544979f7abdd6c`。该 SHA 是 reviewer 明确判定 0 blocker／major 的当前计划提交；plan blob 与该提交不一致时禁止实施。

请在独立 worktree 中从 Task 2a 继续执行 `docs/plan/2026-08-07-history-persistence-worker.md`，行为权威是 `docs/spec/2026-08-06-history-persistence-worker.md`。Batch 0、1a、1b 的完成事实与证据已冻结在计划状态行及 `docs/tmp/2026-08-08-history-worker-progress-impl-1b.md`，不得重复实施。

## 启动前硬门

1. 先读规格全文，再读实施计划的 Global Constraints、Execution Progress Contract、Task 2a；已完成的 Batch 0、1a、1b 只按需查证，不重复执行。
2. 从本文件状态行读取非空 `REVIEWED_PLAN_COMMIT=<sha>`，依次运行：

   ```bash
   REVIEWED_PLAN_COMMIT=<状态行固定值>
   git rev-parse --verify "$REVIEWED_PLAN_COMMIT^{commit}"
   git merge-base --is-ancestor "$REVIEWED_PLAN_COMMIT" master
   test "$(git show "$REVIEWED_PLAN_COMMIT:docs/plan/2026-08-07-history-persistence-worker.md" | git hash-object --stdin)" = "$(git show master:docs/plan/2026-08-07-history-persistence-worker.md | git hash-object --stdin)"
   ```

   三条都须成功。任一失败即禁止实施。然后用 `git log "$REVIEWED_PLAN_COMMIT"..master -- <paths>` 检查 peer 是否改过 History、config、context、shutdown、build 或 tests，受影响事实必须重验。
3. 创建独立 worktree，不在共享主树写实现，不停止 4141。
4. 在第一笔实现前创建并提交 `docs/tmp/2026-08-08-history-worker-progress-impl-2a.md`，frontmatter 的 `slug` 为 `impl-2a`、`base` 取执行会话起始 `master` SHA；每个实现 commit 同步更新该文件。已停止更新的 `impl-1`／`impl-1b`进度文件只作历史证据，不复用写入权。
5. 先只执行 Task 2a。Task 2a 通过测试、独立 review 和复审后立即 fast-forward 合入 `master`，再从最新 `master` 创建下一 batch worktree。不要攒到多个 batch 一起合。
6. Task 2a允许未接生产流程的自洽semantic Worker backend先合，但必须真实持久化、覆盖crash replay、已测试、无主线程singleton泄漏，并明确“不证明terminal subscriber已切换到Worker”。
7. 每个 mutation 在独立 worktree 内用冻结 exact patch 注入与反向恢复；不得与权威测试并发。

## 下一批动作

- 从Task 2a创建`backend.ts`、`restart-policy.ts`及semantic backend／crash replay／fatal state测试；复用现有protocol/runtime/Worker骨架，不重复实现Batch 0～1b。
- 第一条红灯：`bun test tests/history/worker/semantic-backend.it.test.ts` 应因semantic backend尚不存在而失败；测试必须用临时磁盘DB和独立readonly connection验证operation、summary、tracks及journal收敛，不能用假ACK代替持久化。
- 同一批覆盖before journal、after journal、mid transaction、after commit before ACK四个crash window，以及restart recovery fatal对未ACK、reservation、drain和后续enqueue的终结。
- Task 2a只证明未接生产的semantic Worker backend可真实持久化并从crash window收敛；不证明terminal subscriber已使用Worker，也不改变主线程legacy writer authority。

## 禁止事项

- 不把 `RequestContextManager.create()` 全局改 async；生产 admission 在模型 route／Responses WS operation 入口 await，并显式传 reservation。
- 不用 AsyncLocalStorage 隐式传 reservation。
- 不引入 writer pool、无界队列、主线程 fallback writer/read 双轨。
- 不用 `postMessage` 成功冒充 durability ACK。
- 不让中间 raw config revision ACK 放行 admission；只允许 latest desired revision 发布 descriptor。
- 不跨 restart 比较 worker-local raw generation token；artifact identity 是 `dbPath + storeId`。
- Batch 1b 必须同步接 shutdown Step 1 的 admission close 和全量 pending-durability overlay，不能推迟到 Batch 5。
- Batch 3b raw authority 切换必须 pause→旧 operation/lease drain→旧 handle close→Worker open/ACK→resume，任一时刻最多一个进程内 writer。
- Batch 6b 必须让 `runRequest()` 与 `inspectRequest()` 共用同一个 post-route、pre-`translateOut` async seam 预取 Responses fallback history；production、Responses WS 与 debug dry-run 都须显式注入 readonly Worker query client，禁止同步 SQLite fallback，也不能把同步 `translateOut/prepareWire` 偷改成返回 Promise。
- 不把 History search sidecar 的独立 readonly DB owner 误判为主服务违规；Batch 6a/6c 必须保留 search target/attestation/hydration 语义。
- 不运行会杀 4141 的 `kill`／`pkill`／`killall`；测试服务用动态端口或明确非 4141 端口并精确清理。

## 每批完成时

按计划该 task 的门禁执行，报告“证明什么／不证明什么”，独立 review 到 0 blocker／major，提交并立即 fast-forward 合主树。若本批失败，revert 本批回到上一已验收主树，不保留临时 feature flag 双轨。
