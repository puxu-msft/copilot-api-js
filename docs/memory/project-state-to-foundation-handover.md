---
name: project-state-to-foundation-handover
description: state 降为 foundation 叶子已全部落地（S1–S7，第三次领域剥离）——留下的是「判据形状」教训，不是任务状态
metadata:
  type: project
---

**monorepo 拆分 Phase 4 的第三次剥离，2026-07-28 全部落地**（前两次 = token 2026-07-23、telemetry 2026-07-27）。现状 `packages/foundation/src/{state,state-defaults,state-vocabulary}.ts`，出边只有 `node:` 与相对路径。**全仓 madge 环 70/63 → 43/50、state 单元参与的环为 0**（43 与旧数不可直接比：扫描面同时扩到了全部 workspace 包，而扩面本身是 S6 的一部分——原扫描只看 `src/`，文件搬出 `src/` 会「因路径不匹配而消失」，那不是无环的证明）。

权威记录 **[docs/plan/2026-07-28-state-to-foundation/HANDOVER.md](../plan/2026-07-28-state-to-foundation/HANDOVER.md)**（每步的验收 oracle、变异实验、踩过的坑）。此处只留跨任务复用的教训：

- **计划漏掉的拓扑事实**：S2 原计划「把 8 个 models 符号整体搬出 state」不可执行——`state.ts` **自己**还在调其中两个（`setStateForTests` 调 `rebuildModelIndex`、`resetConfigManagedState` 调 `setDisabledModels`），无论留不留 re-export 都会重建那个两节点环。解法是把**触发点上移一层**（重新过滤改由 config 层 `applyConfigToState()` 结尾无条件调一次）。**搬符号前先查「原属主自己调不调它」，只查「谁 import 它」不够。**
- **`export … from` 不绑定本地名**——搬走符号后原文件若自用需另加 `import`。这一轮踩了两次。
- **零依赖叶子只解决「环」，不解决「包边界」**：S1 把常量挪到零 import 叶子，环 70→30，但那两条边仍是 `~/` 路径，foundation 的 allowlist 照拒。**「目标是叶子」与「没有跨包边」是两个判据，别用前者验收后者。**
- **derived 类型进不了零依赖叶子**：`(typeof ARR)[number]` 与 `z.infer<Schema>` 的派生跟不过去，正解是显式写出字面量联合 + 在仍持有运行时值的一侧加**受约束泛型**断言。→ [[methodology-new-oracle-discriminating-power-is-experimental]] 又添一例：`type X = [A extends B ? true : never]` 是**惰性**的（类型别名求值成 `never` 不报错），实测改 zod schema 照样绿；`AssertAssignable<A extends B, B>` 才咬得住。且**「变红了」≠「你的断言咬住了」**——要看错误行号是否落在断言本身。
- **结构类型的固有盲区**：给 zod object 加**可选**字段，任何可赋值性断言都看不见（两向都可赋值）。已写在断言旁边，别再期待它。
- **守卫误伤注释是判据形状错，不是注释错**：foundation 边界守卫是源码正则，被搬过去的一句「`existing import … from "~/lib/state"` consumers keep working」判成违规；分隔符守卫的 `includes("SEPARATOR_CARRIERS")` 被一句解释表名的注释打红。**两处都改成 AST，而不是把注释改成不敢提那个词。**
- **「问题换了，答案就得重新算一遍」**——上一轮评审里同型错误犯了三次，这一轮执行期又验证了一次：S2 的 oracle 写「state 对 models 只剩一条纯类型边」，S5 之后必须收紧成「零边」，留着旧形状会一直绿。

Related: [[methodology-domain-peel-execution-techniques]]（前两次剥离的执行技巧）、[[methodology-relocate-invariant-when-guard-cannot-keep-up]]（守卫追不上就换判据形状/位置）、[[feedback-pass-null-clean-not-self-validating]]（本轮「foundation 零环」也是先植入合成环、证明扩面后的 oracle 真看得见 `packages/` 才敢信）。
