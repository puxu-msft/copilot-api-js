# config-page-design review 260329-1

## Findings

本轮复查未发现新的问题，也没有剩余阻塞性 review finding。

上一轮最后保留的两个收口项，这版文档也已经修正：

- `/v/config` 的 variant switch 行为已经收敛为单一规范：在 Config 页面隐藏，不再保留“隐藏或跳回 dashboard”两种实现口径，见 `docs/config-page-design.md:35`, `docs/config-page-design.md:637`
- `CONFIG_MANAGED_DEFAULTS` 的注释已经明确其职责边界，说明 model overrides 继续使用 `DEFAULT_MODEL_OVERRIDES`，见 `docs/config-page-design.md:93-95`
- `hasRestartFields` 的时序问题已修正，保存前先快照 `requiresRestart`，见 `docs/config-page-design.md:456-462`
- `Save 流程` 已补齐 `resetConfigCache()`、`resetConfigManagedState()`、`applyConfigToState()`、`loadRawConfigFile()` 的完整链路，见 `docs/config-page-design.md:460`
- `resetConfigManagedState()` 已改成从单一默认值来源 `CONFIG_MANAGED_DEFAULTS` 派生，并要求 `mutableState` 初始化也复用它，见 `docs/config-page-design.md:89-154`
- 测试计划已补上 debounce bypass、删除字段回退默认值、以及 `CONFIG_MANAGED_DEFAULTS` 与 `mutableState` 一致性的测试，见 `docs/config-page-design.md:612-625`
- “未做任何修改的 PUT” 的测试已不再要求 byte-for-byte 一致，而是改成结构/注释/顺序层面的稳定性断言，见 `docs/config-page-design.md:605-610`

按当前文档描述，方案已经可以进入实现阶段。

## Resolved Since Earlier Reviews

前几轮的关键问题，这版文档都已经有实质修复：

- 已承认并修复 `applyConfigToState()` 的 merge-only 语义与 Config 页面“删除即回退默认值”目标之间的冲突，见 `docs/config-page-design.md:85-166`
- 已把 `resetConfigCache()` 放进 PUT 调用链，处理 `loadConfig()` debounce 旧缓存问题，见 `docs/config-page-design.md:80`, `:159-160`, `:236`
- 已把原始文件读取抽象成 `loadRawConfigFile()`，不再混淆“文件视图”和“运行时视图”，见 `docs/config-page-design.md:77-79`, `:239`
- 已修正“创建 config.yaml”的产品边界表述，见 `docs/config-page-design.md:15-20`
- 已把 `model_overrides` 重复 key 问题收敛到前端 UI 层，而不是错误地要求后端在 `Record<string, string>` 上做重复检测，见 `docs/config-page-design.md:223-227`
- 已固定空 rewrite rules 的规范编码为 `false`，避免 `false` 与 `[]` 并存，见 `docs/config-page-design.md:472-473`
- 已给 `JSON.stringify` dirty compare 补充 canonicalize 约束，见 `docs/config-page-design.md:449-452`

这些修正方向都是正确的。

## Summary

这版设计文档已经没有我这边的剩余 review finding，可以进入实现阶段。

后续重点已经不再是补设计，而是按文档把实现和测试落全，尤其是以下几块不要缩水：

1. PUT 保存后的完整 reload 链路
2. 删除配置项时回退默认值，而不是保留旧 runtime 值
3. YAML round-trip 写回中的注释/顺序稳定性
4. `/v/config` 只提供 Vuetify 页面、且隐藏 variant switch 的路由一致性
