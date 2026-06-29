---
name: feedback-present-cohesion-over-future-use-yagni-not-veto
description: 重构决策按当下内聚信号优先于 future-use;YAGNI 不是否决票;模块自己警告"别混淆两半"=该拆的冰山信号
metadata:
  type: feedback
---

用户纠正（2026-06-29）:"'将来可能用到'是具有价值的，但不是最强的信号。" 我（和 subagent）一度把 **YAGNI 当成否决票**，用"当前零跨格式消费者"一票否决了把通用 glob-strip 原语从 `request-header-forward.ts` 抽出。这是错的两次：① 把 future-use 当成"无价值"而非"弱但真实的信号"；② 忽略了**当下就存在的内聚信号**。

**Why**: 是否抽取/重构，主信号是**当下的内聚/职责**，不是 future-use。future-use 是加分项、不是否决票也不是唯一理由。最强的"该拆"信号往往已经写在代码里：**一个模块的 docstring 若必须警告读者"两套东西、相反用途、do NOT conflate"，这本身就是当下职责混杂的自证**（`request-header-forward.ts` 正是如此——通用 glob 机制 + Anthropic passthrough 策略同居）。另一个当下信号是**一致性**:已为同类理由抽过 `header-name-match.ts`（通用 matcher），那同样通用的 glob 原语就该同等对待。

**How to apply**: 评估抽取/拆分/建目录时——①先找**当下信号**:模块 docstring 是否在为自己的两半"消歧/警告"？是否与已抽出的同类原语不一致？职责是否跨抽象层？②future-use 作**加权**、不作否决也不作唯一理由（守 YAGNI 不造投机性表面，但 YAGNI 不能否决一个有当下理由的重构）。③present 信号够强(docstring 警告/一致性/跨抽象层)就抽,即使当前只有一个消费者。落地实例:本会话最终把 4 个 header 模块抽成通用原语(matcher/glob-strip)+域策略(request/response forward)两层、收进 `header-policy/` 子目录。呼应 [[feedback-optimize-long-term-maintainability]] 与 [[feedback-architecture-health-is-user-need]]。
