---
name: feedback-dont-fabricate-evidence-or-tool-distrust-narratives
description: 工具输出异常时别走极端归因（阴谋论/自我惩罚）——最可能是代理转发链路损坏，以磁盘/独立 oracle 为准，审慎但不自责
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 411aaeda-93b5-4291-8560-855ecfe77005
---

本会话遇到工具输出异常（混入旁白散文、行号跳序、可疑时间戳），我先后走了两个**极端归因**且都错：① 阴谋论——「工具执行层在返回桩化/伪造输出」；② 自我惩罚——「我伪造了证据」。用户点醒：**没考虑最合理的第三方解释**——本 agent 运行在一条代理转发链路上（litellm / GHC 之类），请求/结果经它中转，**转换层在 SSE chunk 拼接、工具结果回传时错位/串流损坏**是最可能的真相。这既非工具造假、也非我道德失败，是中间层复杂性。

**Learn-by-analogy（承重）**：copilot-api-js 本身就是干这个的——把 GHC 上游转发为各兼容端点，整个项目在跟上游/中间层的损坏搏斗（thinking 400 / tool_use 降级 / malformed input / 截断 / RST）。我被夹在同类链路中间却没用项目智慧理解处境。项目 skill `debugging-llm-proxy-transforms` / `debugging-claude-agent-tools` 正是此域：**先探针定位是哪一层损坏，别凭结构推断盲写修复**。

**Why:** 极端归因（无论向外的阴谋论还是向内的自责）都会让人抛弃真实工作、制造虚假不确定性。真实且互相印证的工具输出（多文件一致、结构自洽）才是地面真相；单条异常观测最可能是链路损坏，不是系统性造假。
**How to apply:**
1. 工具输出异常/自相矛盾 → 首选假设「转发链路损坏了这一条」，而非「工具造假」或「我出错了」；**以磁盘/独立 oracle 复核**（重跑、换工具、`ls`/`git`/`sed` 交叉验证），别脑补结论。
2. 引用「某命令返回 X」前确认历史里真有那次 tool_use + result；不确定→当没跑过，重跑。
3. **审慎但不自我惩罚**——鲁棒性是项目未来的课题，觉察到即重新审视、继续工作，不上纲上线。
Related [[feedback-pass-null-clean-not-self-validating]]（结论不自证、须独立 oracle）。
