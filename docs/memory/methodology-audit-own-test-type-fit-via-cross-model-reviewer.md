---
name: methodology-audit-own-test-type-fit-via-cross-model-reviewer
description: 审自己写的测试是否「测试类型错配」必派异模型 reviewer + 亲验 file:line，别自我背书
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8aea8f36-a7f5-46e9-ad1d-ab3a834dd0cb
---

审计**自己刚写的**测试是否放错测试类型（e2e vs golden/unit/history），**必派异模型 reviewer**（`gpt-souls:reviewer` 审 Claude 写的，反之亦然），给显式唯一判据 + 试金石，且对其「已覆盖/可删」绝对断言**亲自读引用的每个 file:line 复核**——绝不自我背书。

**Why:** 本次 2026-07-14 审自己写的 27 条 client-e2e，我初判「tool-name restore 已被 `tool-name-sanitize.http` golden 覆盖、可删」。两个 reviewer（Claude + GPT）**都独立逮到**：那 golden 是 `stream:false`（非流式 restore 路径 `server-tool-filter.ts:193`），我的 e2e 走**流式**路径（`:126`），流式 restore **无任何 golden**——直接删会丢唯一覆盖。GPT 还逮到一条 oracle 缺陷（标题声称 `BadRequestError`、实际只断言基类 `APIError`）。自我背书会误删覆盖 + 放过缺陷。

**How to apply:** ① 方法论固化于 skill [[choosing-test-type]]（真相域 + 试金石 + 错配四型 + stream≠non-stream 独立路径陷阱 + 删/迁移/先补再删）。② 派 reviewer 时给「唯一判据 + 试金石」显式 prompt，别泛泛。③ reviewer 回来后**亲验 file:line**，尤其「等价覆盖」——区分「话题相邻」vs「真等价」（读 fixture 形状 + 断言）。④ 修复零覆盖损失：先补/迁替代覆盖、变异验证有牙，再删 e2e。→ 验证簇 [[feedback-pass-null-clean-not-self-validating]]。
