---
name: feedback-test-overlap-across-altitudes-is-allowed
description: 测试覆盖跨高度/组合重叠是允许且有价值的(不是 over-coverage);真 over-coverage 只有同高度同范围子集 + 测副本/内建两类
metadata:
  type: feedback
---

判 over-coverage 的正确判据(用户 2026-06-24 纠正,我此前过度激进):**覆盖在不同"高度/范围"重叠是允许且有价值的,不算冗余**。

三条高度各自独立、彼此重叠**不算** over-coverage:
- **函数级**(unit,纯函数/接口能力测试)
- **流程级**(http/flow,handler 整链)
- **排列组合级**(format × scenario 矩阵:每格式 × {complete/H3/truncation/settled-abort/…} 各一格)

理由(测试金字塔 + 组合测试常识):**较小范围的测试更早、更准定位失败**。per-format handler 各持自己那份分支拷贝(CC/Responses/Gemini/Anthropic 的 settled-abort 分支是逐字 copy-paste、**不是**共享一份代码),所以 per-format flow 测试 localizes "哪个 handler 坏了",这是更低高度(driver)的测试做不到的。**函数/接口的能力测试本身合法**,即使更高层 flow 也覆盖它。

**真正的 over-coverage 只有两类**:
1. **测副本/语言内建而非生产代码**(false confidence,与 [[feedback-pass-null-clean-not-self-validating]] 同源)——如测试文件里内联复制 `stripInternalFields` 再测那个 copy、测裸 `Array.find`、测内联复制的正则字面量(而非调函数)。这是**正确性缺陷**(生产代码变了抓不到),不是冗余;改成指向生产、或删。
2. **纯同高度、同范围的子集重复**(无新高度 / 新能力 / 新组合)——如同一 `validateConfig` 的 deprecated-key 子集被另一个更全的 `validateConfig` 测试覆盖。

**Why**:我此前把"分支与另一格式逐字相同 + 契约已在更低高度 lock"当成 over-coverage 的充分理由,据此误判 CC settled-abort(real combinatorial cell)、driver buffer/flush(orchestration-flow vs flushChain-contract 两高度)该删。**那恰恰是被允许的跨高度/组合重叠**。WS settled-abort 我也以同一过激判据删了——它其实有 nonzero 组合价值(守 `ws.ts` 自己那份分支),只是 harness 驱不动 WS-specific 触发段(degenerate 触发)才真的弱,不是"重叠"。

**How to apply**:判某测试是否 over-coverage,先问两问——① 它是否新增了高度/能力/组合(format×scenario 新格子)?② 它是否在测**生产代码**(而非副本/内建)?任一为"是"就**保留**。只有"同高度同范围的纯子集" + "测副本/内建"两类才删。per-format × per-scenario 矩阵格子**默认保留**(只要触发真实、非 degenerate)。审计 over-coverage 时按此判据,别再把跨高度/组合重叠误报成冗余。
