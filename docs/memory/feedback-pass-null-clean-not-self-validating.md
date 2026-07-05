---
name: feedback-pass-null-clean-not-self-validating
description: 通过/空/干净/无问题/绿测/diff 干净——任何否定性或通过性结论都不自证,下结论或采信前先用一个已知应命中的正样本证明这次检查真触达了目标;假阴性伪装成"已确认安全"是承重判断翻车高发口。通用裁决手法见 skill verifying-authoritative-claims
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bb26a9bc-bbda-45b1-94b3-4fffbd4bccdc
---

"测试通过""结果为空""没发现问题""diff 干净"这类**否定性/通过性**结论本身不证明任何东西——同样可能是检查根本没命中目标产生的假阴性。三陷阱：**空≠负**（grep 0 命中可能模式/路径写错，而非"不存在"）；**通过≠健全**（pass 可能断言太弱、mock 短路、根本没进被测分支）；**子域 0≠全域 0**（单目录/单文件 0 不代表全库 0）。

**Why:** 假阴性比假阳性危险——伪装成"已确认安全"让你停止追查，是承重判断（"无消费者""可安全删除""已覆盖"）翻车的高发口。

**How to apply:** 拿到 pass/empty/clean 先反问"这检查真触达目标了吗"，用一个已知应命中的正样本做正向对照（确认 grep/测试确实会响应），再相信它的"无"。通用裁决手法见 skill [[verifying-authoritative-claims]]，always-on 默认在 CLAUDE.md `empirical-verification`。配 skill `empirical-verification`（PASS+WARN 当黄灯）、skill `empirical-verification`（绝对断言要复核）。
