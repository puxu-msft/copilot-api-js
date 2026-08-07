# Task 8 progress：in-memory ordered GOAWAY ledger

## 基线与状态

- BASE：`1d24d9bf14d36a0e3f53b200695b49a424d33191`。
- `git merge-base --is-ancestor 1d24d9bf HEAD` 已于开工时返回 exit 0，无需 fast-forward。
- 当前 checkpoint 仅完成前置核对、规格阅读和执行清单；`tests/transport/http2-goaway-ledger.unit.test.ts` 尚不存在，因此按恢复指令未运行测试、未写生产 primitive。
- 下一 RED checkpoint 的首个具体测试：创建 ledger 后取得一个 dispatch lease，在无 event／无 violation 时 `freezeAtTerminal()` 必须返回 Task 7 `GoawaySnapshot` 的 ordinary zero-event 形状与 `operationLease: null`；测试应首先因 `~/lib/transport/http2-goaway-ledger` 模块不存在而 RED。
- 工作树内报告 `.superpowers/sdd/task-8-report.md` 已创建并记录相同基线，但该 worktree-local 报告不纳入本 progress-only commit。

## 已完成

- 阅读 Task 8 brief、readiness、spec §5.3～§5.5、Task 7 唯一 schema `src/lib/transport/http2-observation-types.ts` 与计划 Task 8。
- 确认边界：只新增 `src/lib/transport/http2-goaway-ledger.ts` 与 `tests/transport/http2-goaway-ledger.unit.test.ts`；不改 production wiring 或 Task 7 schema。
- 确认核心合同：单一 refcount；append 成功发布才消费 evidence；duplicate freeze／release fail loud；first violation reason wins；same digest 不合并 ordered events；zero-event 三态严格。

## 未提交文件及在途意图

- `.superpowers/sdd/task-8-report.md`：worktree-local 实施证据报告，后续逐步补充 RED／GREEN、mutation、验证、ownership proof、结构怪味与三方向反思。
- 当前没有未提交产品源码或测试文件；本 checkpoint 只更新此 progress 文件。

## 剩余项

1. 先新增 `tests/transport/http2-goaway-ledger.unit.test.ts`，覆盖 ordered append、三态 freeze、first-reason-wins、ownership 与 duplicate fail-loud，并运行 targeted test 确认因模块缺失而 RED。
2. 新增 `src/lib/transport/http2-goaway-ledger.ts`，只导入 Task 7 serializable schema 与 `DispatchHandle`，实现 registry／session owner／dispatch lease／operation lease 的单一 refcount。
3. 跑 targeted GREEN、typecheck、lint；随后分别做 fan-out、zero-event violation drop、close-owner early byte loss、duplicate release mutation controls。
4. 完成报告、自审与最终精确 pathspec `feat: add in-memory ordered GOAWAY ledger` commit。
5. 把 Task 7 Minor receiver mutation记录为 Task 10／11 gate；本 Task 不改 AST guard。

## 已作废路子

- 不复制 Task 7 的 serializable union／generic source／result。
- 不复用 raw manager 或 h2 creation lease 的 duplicate-release 幂等语义。
- 不在 GOAWAY append 时向每个 dispatch fan-out snapshot。
- 不因 session owner close 提前销毁仍被 dispatch／operation lease 引用的 evidence bytes。
- 不在本 Task 接入 `http2-client`、scheduler、RequestContext、terminal bus、writer 或 production session wiring。
