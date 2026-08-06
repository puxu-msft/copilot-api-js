# M1 调查结论修订复核

## 评审范围

仅复核上一轮 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/tmp/2026-08-03-m1-investigation-review-gpt.md` 的 Blocker-1、Major-1～6、Minor-1～3，依据逐条处置及修订后的 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md`。除修复自身引入的缺陷外，不扩展新议题。

## 已读取／执行的证据

- 原始发现、逐条处置、修订计划及相关生产代码。被审树 provenance：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc`，HEAD `9dc2e1da6bdf50495fb964f3f7d692f656a65f55`。
- 对 `src/` 全量搜索 `anchorBlockOpen`／`anchorClosed` 的显式赋值与对象初始化，并逐点对照 M1 后／M4 后／M5 后 allowlist。
- Major-3 的 scratch mutation 与 `bun run typecheck` 证据见对应条目。

## 逐条裁决

### Blocker-1：已解决

修订计划已补齐第 13 个关闭站点，并将 13 个关闭者的关闭动作全部提前到 M1：`plan-3-remap-sites.md:121-150`；M1 在同一 commit 删除 owner 外全部 legacy anchor-stop 写出：`:278-280`。

独立赋值点搜索在当前源码命中：`keepalive-anchor.ts:261`、`:330/:335`，`live-reconcile.ts:138`，`driver.ts:1186/:1241/:1318`；对象初始化另命中 `handler-v4.ts:1127-1128` 与 `driver.ts:1165-1166`。逐阶段对照如下：

- **M1 后**：`keepalive-anchor.ts:261` 与 `driver.ts:1186/:1241/:1318` 四个 legacy close 写点随 13 关闭者迁移删除；owner 新增 `anchorClosed=false/true` 两个写点；injector 保留 `anchorBlockOpen` publish/restore；`live-reconcile.ts:138` 保留关闭判定赋值。因此恰为 owner + injector + live-reconcile，符合 `plan-3:169-177`。对象初始化不是运行期字段迁移写者，不与 allowlist 冲突。
- **M4 后**：`live-reconcile.ts:138` 随 S3 transaction 迁走，剩 owner + injector，符合 `plan-3:173-175`。
- **M5 后**：两个 legacy 字段及其 initializer／读写全部删除，归零，符合 `plan-3:175`。

原来的不可满足形态已经消失，没有只是把 driver 两个写点换名留到 M2/M3。计划还要求守卫按具名函数／AST owner 匹配并以 driver 临时赋值作正样本（`:177`、`:303`），可防宽文件 allowlist 假绿。

### Major-1：已解决

三处阶段描述已统一为 M1 后 owner + injector + live-reconcile、M4 后 owner + injector、M5 后归零：`plan-3-remap-sites.md:169-177`、`:303-304`、`:501`。不再存在“M4 后仅 owner”矛盾。

### Major-2：已解决

修订稿明确承认纯 (a) 可在 owner 的 enqueue 前同步外壳落地，C9 不禁止；不采纳理由改为保持 delivery 层 format-agnostic，避免引入 Anthropic prelude／latch 耦合：`plan-3-remap-sites.md:154-166`。错误的“不可能”论证已删除。

### Major-3：已解决

修订稿将三支 `OwnerResult`、对象字面量 `ownerFailure`、`ownerUnavailable` 三臂判别固定为 M1 同一 commit：`plan-3-remap-sites.md:216-237`。我在 `/tmp/copilot-api-js-ownerresult-review`（top-level 与 cwd 均经命令断言）按该做法实际修改 `types.ts` 与 `session.ts`；该 scratch 的基线 HEAD `5b748b2d1b7dc769cb0a45bb9f82047ad8b0d9a2` 与被审树相比，这两份源码无差异。真实输出：

```text
/tmp/copilot-api-js-ownerresult-review
/tmp/copilot-api-js-ownerresult-review
5b748b2d1b7dc769cb0a45bb9f82047ad8b0d9a2
$ tsc
```

`bun run typecheck` exit 0。构造法不是仅靠推理可编译。

### Major-4：已解决

修订稿不再把 `FeatureKind` 当作 History 载体；它要求在 `PipelineInfo` 增加独立结构化槽位、在 `RequestContext` 增加专用 merge 方法，并以 settle 后 History round-trip 验收：`plan-3-remap-sites.md:239-255`、`:271-276`。这与现有 `recordMaxTokensTruncation` → `mergedPipelineInfo()` → `entry.pipelineInfo` 路径相符（`src/lib/context/types.ts:522-526`、`src/lib/context/request.ts:1982-1989`）。

### Major-5：已解决

`OwnerOperation` 已冻结为六值 union，公共 classifier、owner recorder 与持久 detail 均禁止任意 string，并要求穷尽映射：`plan-3-remap-sites.md:257-269`。

### Major-6：已解决

记录点已下沉 owner 的 commit-aware catch，同时覆盖 returned `client-gone, committed:true` 与 thrown non-client `DeliveryOwnerError`，并冻结 `cause: "client-gone" | "wire-error"`：`plan-3-remap-sites.md:239-255`。settle 后两腿都要由独立 History oracle 读回：`:271-276`。

### Minor-1：已解决

“唯一记录一次”不再依赖 translator 调用纪律；每次 owner operation 的 post-commit failure 在产生点记录，translator 不记录：`plan-3-remap-sites.md:253-255`。

### Minor-2：已解决

修订稿明确禁止 `owner-failure.ts` import driver、handler、`ResponseOutcome`、`RequestEnvelope` 与 context concrete implementation，并要求新增 package-boundary／AST 守卫及实跑 cycle ratchet：`plan-3-remap-sites.md:179-181`。

### Minor-3：已解决

无 owner 情形已收窄为只承诺 client wire 字节等价，明确不承诺 legacy state 与 `sink.close` side effect 等价：`plan-3-remap-sites.md:205-207`。

