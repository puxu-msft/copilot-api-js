---
name: feedback-slam-dunk-fixes-do-immediately
description: 无疑问/无取舍/无分叉的改进当场做，别以超范围/保守/独立项为名推迟或降级
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f7b1f96d-7fb1-44cf-9115-abc5818817f9
---

无疑问、只会更好、无取舍、无分叉的修复，**当场做**——不以「超出本轮范围 / 保守避免扩大 diff / 独立项留待以后 / 非本任务」为名推迟或在文档里降级为 backlog。判据是三条同时成立：① 结果只会更好（无回归风险）；② 无取舍（不牺牲任何东西换取它）；③ 无分叉（不需要在多方案间抉择、不依赖用户偏好）。三条全中就立即改。

**Why:** 用户明确要求记住。把 slam-dunk 改进 defer 掉是 over-narrowing scope——违反 `against-yagni-on-feature` 与 CLAUDE.md「用户没要求零改动时不自设约束」。它和 [[方向明确别停]]（user-rule `dont-stop-if-clear`，讲执行顺序不停问）角度不同：这条讲**修复决策本身**别反射式保守。

**How to apply:** 遇到一个改进点，先过三问「更好？无取舍？无分叉？」。全 yes → 当场做（顺手 typecheck/test/提交）。任一 no → 才停：有取舍/有分叉/依赖用户偏好 → 记 backlog 或 `AskUserQuestion`（摆量化选项）；有回归风险 → 先验证。**反面边界要同样守住**：有分叉的别硬当无分叉做。实例（本会话 2026-07-13 auto-truncate 死代码清理）——`message-tool-utils.ts` 的 `[AutoTruncate:Anthropic]` 日志前缀在 auto-truncate 删除后已错（该函数纯服务 sanitize 路径），我第一轮以「保守避免扩大范围」推迟了它 = 犯错；改前缀是无疑问/无取舍/无分叉（命名反映实际职责、无测试断言前缀），应当场做。**同时** `auto-truncate/engine.ts` 的同名前缀我正确地没碰——它是保留的 calibration engine，重命名属「calibration 是否整体脱离 auto-truncate 命名空间」的**有分叉**议题，我用 `AskUserQuestion` 摆了 3 个落点选项交用户拍板（选 `src/lib/models/calibration/`），随后才 `git mv` 重命名 + 全站 import 重写（master `07a8bf68`）——分叉项拍板后照样立即执行，「有分叉」只是要求先定方向、不是推迟。

**Related:** [[feedback-tier-subagent-review-skip-for-mechanical-micro-changes]]（同族：机械低风险改动别反射式加仪式）、CLAUDE.md `best-complete-solution`（命名反映实际职责）。
