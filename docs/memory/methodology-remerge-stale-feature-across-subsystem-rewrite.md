---
name: methodology-remerge-stale-feature-across-subsystem-rewrite
description: 陈旧特性分支 re-merge 撞上底座子系统重写时——冲突处取 master 结构 + 重放自己的 delta（非硬保双方）；测试失败先在 clean base 实测归属再认领
metadata:
  type: feedback
---

一个 additive 特性分支落后 master 大量 commit（本例 2012+7），且期间 master **重写了特性所触及的子系统**（History V2 leg 模型 `inboundRequest`/`outboundRequest` 整体删除、换成 V3 canonical record + `clientRequest`/`upstreamRequest` legs；auto-truncate 移除；client.ts 抽 `postAnthropicUpstream`；`model_overrides`→`model_mappings`），re-merge 不是「行级共存保双方」那种机械合并，而是**半重新实现**。

**Why:** 我最初把冲突当普通并发共存想「取双方」，但底座重写让「我那半」的目标结构（旧 leg 模型）已不存在——保双方会保出引用死结构的死代码。真相是：**特性的接线大多会 auto-merge（config/schema/codec 透传/新类型），只有 master 重构碰到的同一行才冲突**，而这些冲突处**我的 delta 必须重投到 master 的新结构上**。

**How to apply:**
- **先 `git merge-tree`（只读）预览冲突规模**，别盲目 merge。冲突文件里逐个辨：① add/add 附加（取双方）② master 重构替换了我改的结构（**取 master + 把我的 delta 重投到新家**）③ 纯 import 列表（取双方）。
- **take-theirs 会静默丢我的 delta**（新加的可选字段/接线），**typecheck 抓不到**（少填可选字段不报错）。故 take-theirs 后必须**逐点 grep 审计**「我的接线是否还在」（`resolveInboundQuery`/`endpointPath+forwarded`/各 leg 的 query 字段），缺的重放。用**端到端测试当 oracle**（本例 6/6 里 1 个 history 断言暴露 producer-leg 编辑没喂 V3 projection→顺 `record.ingress`/track-metadata 链补齐）。
- **子系统重写后，我的字段要 re-home 到新架构的对应位**：URL-级 query 天然跟 `path`/`method` 走——inbound raw 落 `clientRequest.query`（贯穿 canonical record `ModelOperationIngress`→projection 显式字段），outbound forwarded 落 `attempts[].upstreamRequest.query`（走 upstream track metadata→projection）。**V3 projection 是逐字段显式枚举**（同旧陷阱），不加就丢。
- **测试失败先在 clean base 实测归属再认领**：re-merge 后 6 个 `tests/history/` 失败，**都不引用我的改动**、样本是 `database is locked`/Tantivy 空/`projection.ts:214` TypeError。派异模型 subagent 在**纯净 master worktree** 连跑 3 次——逐字节同错 = **pre-existing-master**（非我引入、非环境 flaky），不该在特性分支背锅修。别凭「我动了 projection.ts」反射认领——我的编辑在 268/371，崩点在 214（clean master 就崩）。
- **落地机制**：feat 含 master 作祖先即可**无损 FF**；master 被 checkout 在主树时，`git branch -f`/`update-ref` 会让主树 HEAD 与工作树错位（敌对 peer），正解是从主树 `git merge --ff-only feat`——**先核 feat 改的文件 ∩ 主树脏文件 = ∅**（`comm -12` 两个 name-only 列表）确保 FF 不覆盖 peer WIP。master 快速移动时，每轮 FF 前 re-merge 增量（2012→7，越来越小）。

相关：[[methodology-full-suite-red-classify-before-pollution-playbook]]（单跑过+全套件挂才污染，本例是单跑也挂→pre-existing）、[[git-commit-pathspec-commits-worktree-not-index]]、[[feedback-fix-all-comparison-sites]]（grep 全站点补 delta）、[[methodology-broken-reference-supply-vs-delete]]（take-theirs 丢 setForwardClientQuery 定义→补符号非删引用）。
