---
name: feedback-act-comprehensively-commit-on-done
description: 完成一个任务阶段就主动提交；在自然范围内全面思考主动做完，别"说一句做一句"把明显该做的拆成一堆问题甩回用户
metadata:
  type: feedback
---

两条一起被用户纠正(本会话):
1. **完成即提交。** 每完成一个可独立成立的工作阶段就**主动 git commit**(本地提交 reversible、默认允许,见 [[feedback-git-staging-and-local-commit-default-allowed]] 与 CLAUDE.md 原则2),不必等用户开口、不必问"要我提交吗"。
2. **全面思考、主动做完,别"说一句做一句"。** 在已确认的自然范围内,把明显该做的事一次性做完——别限定在用户字面给出的那一句,也别把一堆显然正确的后续动作拆成"要不要我也做 X?"的问题甩回去。

**Why:** 我犯的错:合并完记忆后既不提交,又把"清理未索引文件""补两条轻度漏""neighbors 取舍"全列成问题等用户逐一拍板——这正是被动逐字执行(说一句做一句)。用户要的是 agent 在范围内全面推进,而非每步索权。

**How to apply:** 完成阶段 → 立即 commit。面对"还有一堆相关收尾"时:能自己判断、且非破坏性/非真 either-or 的 → 直接做(见 [[feedback-dont-stop-when-direction-clear]] 的判据);只有真正需要用户上下文的(不可逆、真抉择、信息不足)才留给用户,且按 [[feedback-give-user-decision-data-not-pitch]] 给数据而非裸问。呼应 [[feedback_no_unilateral_action]](范围歧义才先问)、[[feedback_never_stop_for_turn_length]]。
