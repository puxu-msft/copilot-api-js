---
name: reference-gpt-tokenizer-pathological-on-repeated-chars
description: "gpt-tokenizer o200k_base 对长重复单字符病态级联慢（60KB \"x\"=15s vs 真实词句 40ms）；测试造大 payload 别用 repeat 单字符"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 950c7328-ce3e-4272-93d9-4ed523568974
  modified: 2026-07-20T18:20:16.688Z
---

`gpt-tokenizer` 的 `o200k_base` encode 对**长重复单字符**病态级联慢：实测 60KB `"x".repeat(60001)` = **15180ms**、多样字母 60KB = 9073ms，但等长真实英文词句 ~60KB = **39ms**（BPE merge 在同字符上疯狂级联）。

**How to apply:** 测试里要造「> 50KB 大 payload」触发 size/token-estimate 分支时，**绝不用 `"x".repeat(N)`**——用等长真实词句（如 `"the quick brown fox jumps over the lazy dog. ".repeat(1400)`），断言意图不变、耗时从数十秒降到毫秒。踩坑实例：`tests/pipeline/request-payload.unit.test.ts` 用 `"x".repeat(60001)` 使 3 个纯单元测试跑 26s、吃掉 fast 档大半（2026-07-20 测试分档 Task 4 根因修，保 `.unit` 真相域非改 `.it`）。**Why:** 慢的根因是退化输入而非被测逻辑——根因修（换真实输入）胜过把慢测试踢出 fast 档。属 [[feedback-fix-all-comparison-sites]] 式「治根因非治症状」；与 empirical-verification（探针实测重复 vs 多样字符耗时才定位到根因）一致。
