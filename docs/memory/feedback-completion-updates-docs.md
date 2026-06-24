---
name: feedback-completion-updates-docs
description: 完成纪律——任务收尾不只删过时 pending 记忆,还要把已落地机制同步进常驻活文档;且"doc-sync 完成"本身是个通过性结论,必须靠跨文档 grep 扫描验证、不能口头宣告
metadata:
  type: feedback
---

任务**完成**时,doc-sync 是"完成"本身的一部分,不是可选收尾:
- 删掉已过时的 pending/计划类记忆(机制已落地,记忆里的"待做"已失真)。
- **更重要**:把已落地的机制**回填进常驻活文档**(docs/DESIGN.md、各模块设计文档、README、路由/配置表等)。
- 别留**孤立 spec**——设计文档描述了 A,代码实现成了 B,而文档没回填 B = 文档腐烂,后来者被误导。

**"doc-sync 完成"是一个通过性结论,不能自证(2026-06-24 惨痛教训)**:我把"文档已同步"当结论宣告了,但那本身就是 [[feedback-pass-null-clean-not-self-validating]] 说的"通过性结果"。实际只更了最显眼的几处(DESIGN 模块条目),漏了:① DESIGN 同主题的**另一行**仍标"暂缓" ② README 端点表缺新端点 ③ 模块文档(history.md)缺新字段 ④ 记忆正文还写"暂未填" ⑤ 同 RFC 的汇总行残留。这 5 处只在用户追问、逼出一次**跨文档 grep 扫描**后才暴露。

**Why:** "代码改完但文档没同步"= **未完成**;而"我以为我同步完了"在没扫描验证前 = **未验证的声称**,等价于 grep 空就说"无残留"。改一个特性会在多处文档留痕(DESIGN 可能有多行、README 端点/配置表、模块文档、RFC 暂缓行、记忆正文),只改显眼那处必漏其余——是 [[feedback-fix-all-comparison-sites]] 在文档轴的同构失败。本条与"知识归类"([[feedback-knowledge-routing-docs-vs-memory]])正交:归类决定"写哪",本条强调"doc-sync 属于 done 的定义、且其完成须被验证"。

**How to apply:** 收尾**必做**一次验证扫描,不靠记忆:① `grep -rn "<旧状态词:暂缓/暂未/未实现/TODO/reserved/无源/单列>" docs/` 命中本次特性的全清零;② `grep -rln "<特性关键词:新端点/新字段/新机制>" docs/ README.md` 逐个核对该提的都提了;③ broken-link / L1 守卫测试绿。扫描出 0 残留才算 done。删 pending 记忆与更新活文档成对做。与 [[feedback-distill-lessons-at-boundaries]]、[[feedback-pass-null-clean-not-self-validating]] 配套。
