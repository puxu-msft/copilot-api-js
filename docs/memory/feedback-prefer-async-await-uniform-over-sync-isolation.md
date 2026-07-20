---
name: feedback-prefer-async-await-uniform-over-sync-isolation
description: 用户极度倾向全面引入 async/await、接口统一 async;不要为保持同步而隔离/围堵 async
metadata:
  type: feedback
---

用户**极度倾向于全面增加 async/await 机制**——接口统一做成 async,让 async 自由贯穿全链路,**不要**为了「保持同步」而把 async 关切隔离、围堵在某个孤立阶段。

**Why:** 用户在「把 system-prompt override / route `n` 预处理从核心剥进 rewrite-registry」的方案选择中,面对三个方案明确选了**方案 2:把 RequestRewrite 链整体改成 async**(`apply` 返回 `RewriteResult | Promise<...>`),并额外声明这是**通用架构偏好**、要我「记住并据此重构」。他主动接受 async 化的波及面(dry-run `inspectRequest` 也随之 async 化等),不认为那是应回避的成本。

**How to apply:**
- 遇到「同步接口 vs async 接口」的设计分叉,**默认选 async 统一**,别再推荐「同步 native + 把 async 隔离在独立阶段」这类围堵方案。
- 具体到本项目:`RequestRewrite.apply` / rewrite 链 / `inspectRequest` / assemble 循环等**该改 async 就改**,async 爆炸半径是**可接受的、要主动铺开的**,不是要规避的红旗。
- 这条**推翻**了旧取向 [[project-symmetric-four-point-hooks]] 的 PoC 结论(当时为避免 `inspectRequest` async 化而刻意保留「同步 parse + 独立 async `translateInbound` 阶段」、把 async 围在一处)。旧结论是**当时**的技术取舍,现在用户明确要反过来——全面 async。若重构触及那块,按本偏好推进、别再引用旧 PoC 当约束。
- 仍要守 async 正确性纪律(never-throw fire-and-forget、drain-before-close 等,见 [[methodology-sync-to-async-persistence-refactor-invariants]]):偏好 async **不等于**豁免 async 陷阱,只是不再把「变 async」本身当成要回避的成本。
