---
name: feedback-verify-doc-vs-code-direction-before-acting
description: 文档与代码不一致时,动手改/提交前先用 git 确证方向——陈旧/未实现/代码缺陷三者后果完全相反(改文档 vs 掩盖缺口 vs 固化 bug 成规范);提交或改动非自己创建的内容须逐条核,局部正确≠整体有效,方向赌对≠验证过。定向工具+处置见 skill verifying-authoritative-claims
metadata:
  type: feedback
---

文档与代码对不上时，改/提交前**先用 git 确证 discrepancy 方向**（三种后果相反）：① **陈旧**（代码演进/特性删，文档没跟）→ 改文档配代码 ② **未实现**（文档是 spec/意图，代码没做）→ 删文档行会**掩盖缺口**，该建代码/留待办 ③ **代码缺陷**（文档对、代码退化）→ 改文档迁就会**把 bug 固化成"规范"**。

**Why（本会话连犯两错）：** (a) 把自己没写、几个月前的 `docs/shutdown.md` 整体提交只验两点就当全文准确；(b) 发现 3 处不一致直接"改文档配代码"，**假设**陈旧没验方向。事后 `git log -S` 才证 3 处确实陈旧（`memory-pressure.ts` df840b5 加/7561a7b 删；WS-close 设计性移 Phase 4；consumers.ts→bus/sinks）——但**方向赌对≠验证过**，用户连戳两次。

**How to apply:** 定向工具 `git log -S "<符号>" -- <path>`（最近一次 + 还是 −）、`git log --oneline -- <file>`（文档多久没动）、grep 全树确认符号现存；**方向定了才改**。提交非自己创建的内容逐条核对当前代码，"部分准确"绝不外推"整体准确"，宁可先 surface 不擅自提交。陈旧文档加注解（删除 commit/日期）移入 `docs/archive/`，不简单删行。通用定向手法与处置见 skill skill `verifying-authoritative-claims`；同 [[feedback-pass-null-clean-not-self-validating]]（局部正确不自证整体）。
