---
name: project-state-to-foundation-handover
description: state+state-defaults 降为 foundation 叶子（第三次领域剥离，文档定稿三轮评审通过、代码未动工）——接手先读 HANDOVER
metadata:
  type: project
---

**monorepo 拆分 Phase 4 的第三次剥离**（前两次 = token 2026-07-23、telemetry 2026-07-27，均 landed）。**2026-07-28 状态：文档定稿并经三轮异模型对抗评审通过，代码零改动。**

权威入口 **[docs/plan/2026-07-28-state-to-foundation/HANDOVER.md](../plan/2026-07-28-state-to-foundation/HANDOVER.md)**，此处只留触发指针：

- **范围已由用户逐条裁定**（HANDOVER §2）：state + state-defaults 进 foundation（前提只依赖内置）、简单 setter 留在 state、寄居的 models 逻辑与 4 个 `resolve*` 回各自域、state 本身不需要测试。
- **⚠️ spec `2026-07-22` §2.1 白纸黑字写着本任务「走不通」**——那是 2026-07-22 的前提，S1–S5 拆的正是那个前提。对账在 HANDOVER §2.5，DESIGN/backlog/spec 三处已加 supersede 注记。**别只读 spec 就下结论。**
- **承重发现**：把两个 refusal 字符串常量挪进零依赖叶子，实测 **70 环/63 成员 → 30/43**（组合 separator 后仍是 30/43，别预期更低）。
- **§3.7「foundation 准入清单」是全文最重要的一节**：两文件的**完整出边** AST 枚举 + 每条边由哪一步消除。缺它 S6 会在投入 5 个提交后必红。
- **§5 有 4 条待用户裁决的分叉**，其中 `~/lib/token/types` 是包分层反转（token 已依赖 foundation），会挡住 S6。

**这一轮沉淀的两条方法论**（价值超出本任务）：[[methodology-new-oracle-discriminating-power-is-experimental]]、以及「**问题换了，答案就得重新算一遍**」——同一个毛病我在两轮评审里犯了三次（削环结论当叶子化前提 / 「同一单元一起走」被复用到「foundation 内部有没有环」/ 见前一条）。

Related: [[methodology-domain-peel-execution-techniques]]（前两次剥离的执行技巧）、[[feedback-verify-deferred-task-not-already-landed-before-designing]]（接手第一条命令是查 peer）。
