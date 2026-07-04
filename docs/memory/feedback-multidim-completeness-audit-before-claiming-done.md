---
name: feedback-multidim-completeness-audit-before-claiming-done
description: 声称"完备/没问题"前主动过多维度自审(活路径真被执行?传输层真到达?可观测性合成vs真实可区分?副作用污染谁?),别等用户逐维度推;用户质疑=指向遗漏维度的信号,第一反应深挖该维度而非防御性重申已有证据
metadata:
  type: feedback
---

keepalive 任务功能实现得对,但经历了 ~5 轮反复:功能正确 → tool 场景安全 → 活路径(改的代码真被执行?) → 传输层(keepalive 真发出到 TCP?) → 可观测性(合成心跳污染 history?)。**几乎每一层都是被用户推着才去验证/发现的**,我每层都先声称"完备",用户指出下一个我没覆盖的维度。用户最后点破:"其实你的实现是完备的,我批评你其实是逼你验证"。

**Why**：功能正确只是完备性的**一个**维度。反复的根源是**过早声称"完备/没问题"、缺乏主动的多维度自审**。用户的每次"草率 / 严重问题"质疑都精确指向一个我真实遗漏的维度——尤其**可观测性是设计盲区**(我只想功能对,没想合成数据污染 history,见 [[feedback-synthetic-data-must-be-distinguishable-from-real]])。而我几轮的防御性反应("我有 SDK oracle / 实测证明我对")——那些证据本身是对的,但**用户指的从来不是我已覆盖的、而是我没覆盖的新维度**。用已有证据回击一个指向盲区的质疑,只会拖长反复。

**How to apply**：交付非平凡实现前,主动过一遍**完备性维度清单**,别等用户逐维度推:①**活路径**——改的代码真被执行吗(不是 dead code / 被绕过 / 只在测试里)?用端到端或正样本证明触达了目标,不只"逻辑正确"(呼应 [[feedback-pass-null-clean-not-self-validating]] 通过不自证)。②**传输/分层**——应用层对 ≠ 到达消费者;验证到真正起作用的那一层(keepalive 要验到 TCP flush / 客户端真感知,不止 sink.write 被调)。③**可观测性**——合成 vs 真实可区分吗?运维/history/log 能看出真相吗?(richest-data-flow)。④**副作用**——这个改动污染/影响了哪些下游(history / log / UI / diff / 其他消费者)?**被质疑时**:别防御性重申已有证据——先假设"用户看到了我没看到的维度",去找它、亲手实测它([[empirical-verification]])。这条与 empirical-verification / reviewer-verify 的角度差异=**主动多维度、别被推着一层层验证**。
