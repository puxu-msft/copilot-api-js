
## 发现 1（阻断级）：HANDOVER.md / KICKOFF.md 本身未合入 master，接手方按文档指示走会找不到它们

- 核验：`git cat-file -e master:docs/plan/2026-08-08-header-deadline-stage2-3/HANDOVER.md` → `fatal: ... exists on disk, but not in 'master'`；`KICKOFF.md` 同样。
- `git merge-base --is-ancestor f0cb1f1e(当前tip) d1011fe7(声称的master)` → 失败（tip 不是 master 祖先，两者已分叉/tip 领先未合并）。
- 对照：阶段 1 代码终点 `bea1dfa3` **确实**是 master 祖先（`--is-ancestor` 成功）——阶段 1 代码已合并的断言为真；但**记录这件事的 HANDOVER/KICKOFF 文档提交本身**（`f0cb1f1e` 及其父 `30dfa68a/1af8f17a/9daad677`）还停留在 `worktree-nghttp2-header-deadline` 分支上，未 `--ff-only` 进 master。
- **接手方会做的错误动作**：KICKOFF 第 15 行明确要求「开新隔离 worktree，别复用该树」。若接手方遵照这条、从 `master` 建新 worktree，master 树里**根本没有** `docs/plan/2026-08-08-header-deadline-stage2-3/` 目录——HANDOVER 和 KICKOFF 都不存在。接手方要么误以为交接文档丢失/需要重新调查全部硬事实，要么必须先反向定位到这个未合并分支才能拿到文档，这与「先读 HANDOVER」的第一步指令直接矛盾。这不是"路径小错"，是**交接产物自身的可达性缺陷**：读者能看到本文档（因为我们此刻就在这条分支的 worktree 里），但下一个理性遵照 KICKOFF 指示行动的会话看不到。

## 发现 2（Major）：T1 的证伪方法未经验证——现有 `package-boundaries.unit.test.ts` 不检测「core 里另抄一份同名类型」

- HANDOVER T1 与 KICKOFF「第一步动作」都写：「证伪方式：在 core 里另抄一份同名类型，边界守卫必须变红」，验收判据引用 `tests/architecture/package-boundaries.unit.test.ts`。
- 核验：通读该文件全部 5 个 `describe` 块（`state unit`/`workspace packages`/`package import boundaries`/`delivery owner`/`stream-error outcomes`），其 import-boundary 检测器（`foundationHasForbiddenImport`、`tokenHasForbiddenImport`、`telemetryForbiddenSpecifiers`）**只扫描 import specifier 方向**（core/`~/`/sibling package 是否被 foundation/token/telemetry 引入），**没有任何逻辑检查 core 是否定义了与 foundation 同名的类型**。`rg '重复定义|duplicate.*type|同名.*type|shadowed'` 在整个 `tests/architecture/` 下零命中。
- **接手方会做的错误动作**：接手方会按 HANDOVER 写的证伪步骤，在 core 里手写一份 `TransportTerminationEvidence` 同名类型，观察 `package-boundaries.unit.test.ts` 是否变红——**它不会变红**（该 guard 不检测这件事），接手方会因此误判「T1 的边界保护不够、有缺陷」或反过来误判「我漏配了什么」，浪费时间排查一个根本不存在于该测试文件里的机制；更坏的是如果侥幸没去实测直接采信 HANDOVER 的断言，会把一个**未经验证的假阳性防护**当成已确认的门禁写进下一份文档，继续误传。

## 结论

1. **KICKOFF 与 HANDOVER 数字/口径对照**：master `d1011fe7`、阶段 1 代码终点 `bea1dfa3`、`test:backend=7279/30/0`、spec §3.2/§3.3/§5.2/§5.3/§6 引用位置，两份文档内部**一致**，且逐条对照 spec 原文行号后**引用准确**（§3.2=79行「事实与策略分离」、§3.3=103行「Evidence 追加与归因」、§5.2=176行「阶段2产物」、§5.3=210行「阶段3」、§6=235行「测试夹具与实证纪律」）。未发现两份文档互相矛盾之处。
2. **接手方能否只读这两份就动手**：**不能**。发现1 意味着按文档指示的标准路径（从 master 开新树）会在第一步就拿不到这两份文件；发现2 意味着即使拿到文档，第一步动作里写明的证伪方法本身需要重新调查/修正才能真正跑通。两者都不是「文档措辞问题」，而是会让接手方停下来回头问人，或重新做 HANDOVER 本应替其做完的调查。
