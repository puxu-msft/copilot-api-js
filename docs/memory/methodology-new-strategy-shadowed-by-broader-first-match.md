---
name: methodology-new-strategy-shadowed-by-broader-first-match
description: 新增反应式 retry 策略前先 grep 同错误子串的既有 matcher——driver 首命中即止会让更宽的旧策略抢先遮蔽新策略
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a5196a6a-86fa-4dfc-b231-c5192c80a930
---

新增一个匹配特定上游错误的 retry 策略时，**先 grep 全部既有策略对同一错误子串的 match 逻辑**——`driver` 是 `strategies.find((s) => s.canHandle(e))` **首命中即止**，一个更宽的旧策略若也匹配该子串、且排在前，会把错误**整个吃掉**，新策略永不触发（测试全绿但生产 dead-on-arrival）。

**实例（2026-07-07 tool-field-rejection）**：body-field 策略的 `/\b([a-z_]\w*): Extra inputs are not permitted/` 会从 `tools.0.custom.eager_input_streaming: ...` 的点号路径 capture 到叶子字段，抢先认领本该给新 tool-field 策略的错误。修复=收紧旧正则（`(?<![.\w])` 排除点号前缀，附带修既有 latent bug）+ 新策略排在旧策略**之前**（防御纵深）。是对抗 subagent review 的 CRITICAL 发现，我自己独立 node oracle 复核属实（见 [[feedback-pass-null-clean-not-self-validating]] 的先证检查触达）。

**Why:** first-match-wins 派发下，「新策略写了却不生效」是隐性失败——单测只证新策略自身正确，不证它在真实派发链里拿得到错误。

**How to apply:** 加反应式策略 → grep 既有 `canHandle`/match 对目标错误串（尤其 "Extra inputs" / "not supported" / "not found" 这类被多策略共用的通用短语）→ 若有重叠，收紧旧 matcher 到互斥 + 把更具体的新策略排在更宽的旧策略前 → 加一条断言「该错误被新策略认领而非旧策略」的回归测试。归属：策略 docstring ORDERING 节 + skill `ghc-anthropic-upstream` 症状行。
