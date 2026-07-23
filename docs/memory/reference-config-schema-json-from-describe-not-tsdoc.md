---
name: reference-config-schema-json-from-describe-not-tsdoc
description: config.schema.json 只由 Zod .describe() 生成、TSDoc /** */ 注释不进 JSON schema；改 schema 字段的 TSDoc 是 no-op，跑 generate:config-schema 可能暴露别的会话遗留的未重生成 drift
metadata:
  type: reference
---

`config.schema.json` 由 `scripts/generate-config-json-schema.ts`（zod-to-json-schema）从 `ConfigSchema` 生成，**description 只来自 Zod `.describe()` 调用，不来自字段上方的 TSDoc `/** */` 注释**。

**How to apply:**
- 想让某配置项的说明进 `config.schema.json`，必须用 `.describe("…")`；改 TSDoc 注释对 JSON schema 是 **no-op**（本项目 `anthropic.model_capabilities` 等大量字段只有 TSDoc、无 `.describe()`，故改其 TSDoc 不需要也不会改 JSON schema）。
- **只有改 schema 的结构（增删字段、改类型/enum/section）才影响 `config.schema.json`**——这类改动后须跑 `bun run generate:config-schema`。
- **陷阱：跑 `generate:config-schema` 前先 `git diff config.schema.json`。** 若 diff 里出现大量与你无关的键（`0 deletions` 的纯新增尤其可疑），说明 base 的 `config.schema.json` 相对当前 `schema.ts` **已 stale**——别的会话改了 schema 结构却没重生成。别把这段 drift 裹进你的特性提交（错误归属 + 合并冲突）；如实跳过或另起独立 housekeeping 提交，并核实你的改动是否真需要 regenerate（TSDoc-only 改动不需要）。

**Why:** 2026-07-23 做 `model_capabilities` glob 特性时，Task 6「regenerate config.schema.json」被证为对本特性 no-op（字段用 TSDoc 非 `.describe()`），而盲跑 regenerate 会拉进 264 行别的会话的未重生成 drift（continuation/favor/forward_client_query 等）。**否定性/生成性结论不自证**——用 `git diff` + 追问「这些新增行是我的吗」戳破。→ [[feedback-pass-null-clean-not-self-validating]]。
