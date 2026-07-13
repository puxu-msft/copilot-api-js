---
name: methodology-classify-lost-info-vs-equivalence-before-config-migration
description: "移除隐式转换、决定「交给 config 还是留代码」前，先辨丢信息(策略,归 config) vs 等价变换(拼写/大小写归一,归数据驱动代码)；用户说「也交给 config」直译可能最差"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 76acceaf-444b-46fa-9682-4199da61d798
---

用户要求把某个隐式转换「从代码移除、交给 config」时，**先辨这个转换的性质，别照字面直译**——直译（逐条塞进 config）可能是所有方案里最差的一种。

判据：
- **丢信息 / 策略决定** → 归 config。转换丢掉了信息、且「A 映射到哪个 B」是可变的运维策略。例：日期后缀 `claude-haiku-4-5-20251001` → `claude-haiku-4.5` 丢了快照日期，「哪个快照用哪个服务模型」是策略 → 归 `model_overrides` 显式映射。
- **拓扑等价变换 / 同一实体的不同拼写** → 归数据驱动的代码，**不是** config。转换是同一实体的等价改写（类似大小写不敏感），无策略成分。例：连字符→点 `claude-opus-4-6` → `claude-opus-4.6` 是同一模型的两种拼法，GHC 真实 id 就是点形式。逐条配 `model_overrides` 是把纯拼写噪音堆进 config、每上新模型都要补。

等价变换的最优形状是**数据驱动回查权威源**，优于逐条配 config，更优于硬编码正则：本例把 resolveBase 的正则 `VERSIONED_RE` 换成按 `normalizeForMatching` 回查 `/models` 目录（`canonicalizeFromCatalog`）——零 config、新模型自动、且覆盖硬编码 `claude-*` 正则漏掉的非-Claude 点号模型（`gemini-3.1-pro-preview`/`gpt-5.5`）。

配套两条收窄手法：
- **移除隐式转换前先追爆炸半径**：确认出站取的是 `resolvedName`（解析后字符串、契约不变）而非 `selectedModel.id`，于是 15 处 modelIndex 消费者 / `.size` 计数 / 并发会话在改的 state.ts **全不用碰**——把「跨 5 codec」的预估收窄成单文件改动。
- **共用常量的不同消费者要分离对待**：`VERSIONED_RE` 被请求侧 `resolveBase` 和响应/前端 `normalizeModelId` 共用，但后者是 state-free 纯函数供浏览器经 `~backend` 做遥测 join、够不到后端 catalog → 只从请求侧移除正则、响应侧保留。

**Why:** 直译用户的字面要求会错失更优形状；care about intent not instructions（user-rule `intent-over-instructions`）。辨清性质才能给出「数据驱动 > 逐条 config > 硬编码」的正确形状并让用户裁决。

**How to apply:** 收到「把 X 转换交给 config」类要求时，先问 X 丢信息还是保等价。丢信息 → config 映射。保等价 → 数据驱动回查权威目录（本项目即 `/models`）。动手前追出站到底取哪个字段定爆炸半径。共用工具函数先分清消费者再决定改哪一侧。**Related:** [[feedback-richest-data-flow-store-complete-no-pruning]]（数据以合适形式流动、决策交末端）。
