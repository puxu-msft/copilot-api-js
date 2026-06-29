---
name: project-new-config-key-must-document-in-bundled-config-yaml
description: 新增 config 键收尾必须加进 bundled config.yaml（默认 SSOT + 自文档清单）,不止 schema/state/CONFIG_MANAGED_DEFAULTS;漏加的两个错误先验是"兜底够用"与"避让 peer"
metadata:
  type: project
---

新增任何 config 键(尤其 `anthropic.*`),收尾**必须**在 bundled `config.yaml` 显式列出该键 + 双语注释(三档/取值/默认/docs 链接),不能只改 `schema.ts`/`config.ts`/`state.ts`/`CONFIG_MANAGED_DEFAULTS`。

**为什么**:bundled `config.yaml`(包根、随 npm 发布)是**默认的 single source of truth + 完整自文档化选项清单**——每个 `anthropic.*` 键(含 opt-in 默认关的:`tool_recover_call_text: false`、`protect_streaming_generation: false`、`strict_response_headers: false`……)都显式列出带注释。DESIGN「配置加载层级」明说 `CONFIG_MANAGED_DEFAULTS` 只是「bundled config 无法读取时的安全兜底」,不是默认来源。键只活在兜底里 = 用户翻 config.yaml 发现不了该功能、与惯例脱节。

**漏加的两个错误先验(都要主动否决)**:
- 「默认值靠 CONFIG_MANAGED_DEFAULTS 兜底够用」——只看了**功能性**(默认值确实生效),漏了**可发现性 + 一致性**。判据是「哪个最终质量最高(自文档+可发现+惯例一致)」,非「兜底能不能跑」(architecture-health-first 否决"够用"训练先验)。
- 「peer 正在改 config.yaml,避让」——`concurrency-line-coexistence` 禁止的**退让**:并发只决定用哪种行级隔离技法(line-coexistence/filtered-patch),绝不决定改不改。

**config.example.yaml 例外**:它是**精简样例**(键数 < config.yaml),只列常用,不列所有 opt-in 默认关键——新 opt-in 键与同构先例(如 `tool_recover_call_text`)同等处理:bundled config.yaml 加、config.example.yaml 不加。

判定有无遗漏:新键应同时出现在 `schema.ts` + `config.ts`(apply) + `state.ts`(3 处) + bundled `config.yaml` + DESIGN「运行时选项」表。注:目前**无**守卫测试强制 bundled config.yaml 覆盖所有 schema 键(config-hot-reload 完整性守卫只管 schema 键 ∈ FIELDS/EXEMPT),故靠纪律。是 [[feedback-completion-updates-docs]] 的一个具体 config 维度。
