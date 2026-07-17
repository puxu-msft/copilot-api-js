---
name: methodology-full-primitive-not-partial-else-silent-field-drop
description: 翻译/映射复用共享原语时用「小原语」(只做部分工作)而非「完整原语」(带全字段透传)会静默丢字段、且单测因不构造该字段而假绿——本会话 anthropic↔responses usage 映射 3 次复发、合并态审+coverage 才逮
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d3ca528-62fc-4185-bcfb-7992d9022f37
---

**复用共享原语做翻译/映射时,选「完整原语」而非「小原语」——小原语只做局部工作,会静默丢它不处理的字段,且单测因不构造该字段而假绿。**

**实例(anthropic↔responses 直接桥,2026-07-15,3 次复发)**:usage 映射本应复用 `usageFromTotalInput`(带 `reasoning`/模态明细透传),但实现者用了更小的 `netInputTokens`(只做 cache 减法)——**静默丢 `reasoning_tokens`**(gpt-5.x 每轮都产、richest-data-flow 回归)。流式 + 非流式两处、前向 + 反向共 3 次犯同一错。

**为何假绿(承重)**:usage 单测只断言 `{input_tokens,output_tokens[,cache_*]}`,**从不构造带 `reasoning_tokens` 的 usage** → 「不含该字段」的断言 trivially 通过。**用小原语丢字段 + 测试不喂该字段 = 双重假绿**,单测全绿而字段永久丢。

**逮到方式**:异模型合并态审查 + 我亲手核实 file:line + `--coverage`(小原语行覆盖但字段未消费)。修=改用完整 `usageFromTotalInput` 透传全明细 + 补 false-green 测试(构造带 `reasoning_tokens` 的输入、断言透传到位)、`git stash` 撤修则测试红证有牙。

**通用手法**:
- 复用原语前问「这个原语做的是**完整**工作还是**局部**工作?我要透传的字段它管不管?」——`netInputTokens`(纯算术) vs `usageFromTotalInput`(算术 + 全字段组装)是同域两粒度并存的陷阱。
- 加映射测试**必须构造被映射类型的每个非平凡字段**(尤其易漏的 `reasoning_tokens`/模态明细),否则「不丢」断言无牙。
- richest-data-flow 域(usage/reasoning/明细)的映射,默认用最富原语、别用只覆盖主字段的窄原语。

姊妹 [[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]](真 invariant=对在意消费者无可观测变化)、[[methodology-reasoned-safe-not-tested-producer-wire-oracle]](单测绿≠wire 对)。逮法簇 [[feedback-pass-null-clean-not-self-validating]] + user skill `verifying-authoritative-claims`。
