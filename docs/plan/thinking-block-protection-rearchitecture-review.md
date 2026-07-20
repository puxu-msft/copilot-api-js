# 对抗式审查结论 — thinking 块保护体系重构 plan

> **类型**：对抗性审查报告 —— 非独立 plan，实施状态见父 plan [thinking-block-protection-rearchitecture.md](thinking-block-protection-rearchitecture.md)。

这是只读审查，不执行重构。下方是逐项 verdict + 独立发现。

## 概要判定
- (A) **不可直接放心执行**：有 1 个 must-fix（Part 1.4 compat 框架的 warn-once 误报 + 同键值迁移的 passthrough 必须返回 patch 否则丢用户合法值），1 个 must-decide（Part 5 drop-empty 可能制造连续同 role 400），2 个 INCOMPLETE（config.schema.json 应生成而非手改；漏改 docs/sync-ghc-api/messages-api.md:80）。
- (B) **需回到用户决策**：Part 5 的空消息清扫策略（drop-only vs drop+merge-adjacent vs 实测容忍连续同 role）；第二跳非流式是否返回带签名 thinking（建议实测，但有 fallback 兜底）。

## 逐项见正文
（详细 verdict 见交付消息）
