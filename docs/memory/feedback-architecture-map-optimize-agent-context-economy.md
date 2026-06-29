---
name: feedback-architecture-map-optimize-agent-context-economy
description: 架构图文档的价值轴是 Agent 上下文经济(让模型一次读取掌握现状、跳过源码全文),不是可推导性;逐文件叶子树是负债
metadata:
  type: feedback
---

维护"代码布局/架构图"类文档(如 DESIGN.md 的模块树)时,价值轴**不是"信息能否推导"**,而是 **Agent 上下文经济 + 可信度**:这张图存在的唯一理由,是让 Agent/模型**用一次读取掌握现状、从而跳过对源码全文的读取**。可推导的信息照样有价值,只要"推导成本(grep + 翻 N 个文件的 docstring)"远高于"读这一段"。

**负债的根源不是"可推导",而是 altitude 不对 + 不可信:**
- **不可信(漂移)= 价值归负**:Agent 不敢信的图 → 还得回去读源码 → 收益归零;**死条目(指向已删/改名文件)让 Agent 读空 → 价值为负**。可信度是第一杠杆,压过可推导性。被强制保持新鲜的文档(有守卫)是资产,无守卫的手维护是负债——同 [[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]] 的"漂移会不会被抓"判据。
- **altitude 错(逐文件叶子树)**:逐文件 `X.ts # 做X` = 高 churn(每次重构都碰)+ 低密度(复述文件名+docstring,Agent 打开文件本就会读)+ 可机械派生(`ls`/docstring)→ 结构性负债。本项目实测:真实 `src/lib` ~207 文件、DESIGN.md 树只列 ~87 且含死条目(`context/consumers.ts`、`openai/client.ts`、整目录 `tui/`)。

**How to apply（落地形态,本会话已实施于 DESIGN.md）:**
1. **逐文件叶子树 → 目录级关系图**:每节点只编码"读单文件得不到的"——跨文件数据流/consumed-by、provenance(怎么来的、取代了什么)、反直觉决策、硬序契约。叶子清单交 `git ls-files`/codemap **派生**(不手列)。大域(>20 文件)下沉子目录级,否则太粗失导航价值。
2. **加"现状/活的架构是哪条"小节**:orientation-per-token 最高的产物——一表让 Agent 一眼知道哪条路径是活的(done/wip/bypass/退役),不必读多个文件重建状态。这层精心手维护(推不出来且最省读取)。
3. **L1 存在性守卫测试**(如 `tests/infra/design-doc-tree.unit.test.ts`):解析文档里所有 rooted 路径引用、断言每个 existsSync——把无守卫的手维护图从负债转成被强制的资产,挡死条目复发。这是性价比最高的一击(死条目是唯一会主动误导 Agent 的漂移)。
4. **字段级指针归专门的表**(如配置表),架构图不复述;altitude 规则写进文档自约束(三问入图:provenance/consumed-by/反直觉)。

**Why:** 文档的目标不是"镜像代码",是"当 Agent 的可信快速索引"——让它只读真正要改的 1–2 个文件,而不是 50 个。方法论收敛自一次 4 轮 subagent 对抗讨论(orientation / accuracy-churn / critique / synthesis)。