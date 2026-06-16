---
name: feedback-fix-all-comparison-sites
description: 归一化键/id 粒度类 bug 常在多处比较点复发——grep 全仓逐处修，别只修最显眼那处
metadata:
  type: feedback
---

当一个 bug 的根因是"键/id/粒度的归一化不一致"(canonicalization、prefix 处理、大小写、trim、`call_`/`fc_` 前缀转换之类),它**几乎总在多个比较点复发**——同一个归一化假设被分散写在 N 处 `===`/`Map.has`/`Set`/查表里。修了最显眼那处不等于修好。

**Why:** 这类 bug 的本质是"同一份归一化逻辑被复制到多个消费点"。只修触发的那处,其余比较点仍带旧假设,下次换条路径又复发。是 [[feedback_complete_root_cause_fix]] "refactor to shared primitive" 在**比较点**这个具体场景的实例。本项目高发(三套兼容层的 id/key 互转、[[lineage-canonicalization-rules]] 的 prefix-hash 归一)。

**How to apply:** 定位到归一化 bug 后,**grep 全仓**找出所有对同类键/id 做比较或查表的点,逐处核对是否都用了一致的归一化;最优解是把归一化抽成单一 primitive,所有比较点过它,而非每处各修。修完用 [[feedback-pass-null-clean-not-self-validating]] 的正向对照确认 grep 真扫全了(空命中≠扫净)。
