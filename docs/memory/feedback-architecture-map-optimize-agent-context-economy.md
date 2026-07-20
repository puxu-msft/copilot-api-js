---
name: feedback-architecture-map-optimize-agent-context-economy
description: 架构图文档价值轴是 Agent 上下文经济(一次读取掌握现状、跳过源码全文)+可信度，非可推导性；逐文件叶子树是负债
metadata:
  type: feedback
---

维护"代码布局/架构图"类文档（如 DESIGN.md 模块树）时，价值轴**不是"信息能否推导"**，而是 **Agent 上下文经济 + 可信度**：这张图存在的唯一理由是让模型**一次读取掌握现状、跳过对源码全文的读取**。可推导信息照样有价值，只要推导成本（grep + 翻 N 个 docstring）远高于读这一段。

**负债根源不是"可推导"，而是 altitude 不对 + 不可信：**
- **不可信（漂移）= 价值归负**：Agent 不敢信的图→回去读源码→收益归零；**死条目（指向已删/改名文件）让 Agent 读空→价值为负**。可信度是第一杠杆。有守卫的文档是资产、无守卫手维护是负债。
- **altitude 错（逐文件叶子树）**：逐文件 `X.ts # 做X` = 高 churn + 低密度（复述文件名+docstring）+ 可机械派生（`ls`/docstring）→ 结构性负债。实测 `src/lib` ~207 文件、旧 DESIGN 树只列 ~87 且含死条目。

**落地形态（已实施于 DESIGN.md）**：①逐文件叶子树→**目录级关系图**（每节点只编码读单文件得不到的：跨文件数据流/consumed-by、provenance、反直觉决策、硬序契约；叶子清单交 `git ls-files`/codemap 派生）②加**「活的架构现状」小节**（一表让 Agent 一眼知哪条路径是活的：done/wip/bypass/退役）③**L1 存在性守卫测试**（解析文档所有 rooted 路径断言 existsSync，挡死条目复发）④字段级指针归专门表、架构图不复述。方法论收敛自 4 轮 subagent 对抗讨论。
