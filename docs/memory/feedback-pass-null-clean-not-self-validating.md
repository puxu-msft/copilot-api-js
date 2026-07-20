---
name: feedback-pass-null-clean-not-self-validating
description: 否定性/通过性结论(通过/空/干净/自洽/doc-vs-code)不自证——先用正样本证检查触达目标+独立 oracle 裁决方向；通用手法见 skill verifying-authoritative-claims
metadata:
  node_type: memory
  type: feedback
---

**通用裁决法见 user-level skill `verifying-authoritative-claims`**（判断该不该信任何声音权威、用哪种独立裁决）。本条是 verification 簇（原 pass-null / self-consistent / verify-doc-vs-code 合并）在本项目的高发实例与钩子。

**① 否定性/通过性结论不自证。** "测试通过/结果为空/没发现问题/diff 干净"本身不证明任何东西——同样可能是检查没命中目标的假阴性。三陷阱：空≠负（grep 0 可能模式/路径写错）、通过≠健全（断言太弱/mock 短路/没进被测分支）、子域 0≠全域 0。假阴性伪装成"已确认安全"是承重判断（"无消费者/可安全删除/已覆盖"）翻车高发口。拿到 pass/empty/clean 先反问"这检查真触达目标了吗"，用已知应命中的正样本做正向对照再信其"无"。

**② 自洽不是判据，须独立 oracle。** wire/协议/格式正确性别用自己 encode↔decode 自洽（耦合双端共享同一误解会全绿、mock 上游太宽松假绿），用独立 oracle——协议规范/参考实现/真实对端（GHC / 官方 SDK）。本项目实例：L2 escalation force-inject `context_management` mode=off 漏 `context-management-2025-06-27` beta header→400；三套兼容层（Anthropic/OpenAI/Gemini）互转高发。

**③ doc-vs-code 方向须先确证。** 文档与代码不一致，动手前用 `git log -S` 确证方向——①陈旧（改文档、加注解移 archive、不删行）②未实现（删行会掩盖缺口）③代码缺陷（改文档会固化 bug）三者后果完全相反。提交/改动非自己创建的内容须逐条核，局部正确≠整体有效、方向赌对≠验证过。

always-on 见 CLAUDE.md `empirical-verification`；探针落地见 skill `empirical-verification`。补充：引用缺失符号"补 vs 删"的第 4 变体见 [[methodology-broken-reference-supply-vs-delete]]。
