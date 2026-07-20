# 第二轮收敛复核结论

> **类型**：对抗性审查报告 —— 非独立 plan，实施状态见父 plan [thinking-block-protection-rearchitecture.md](thinking-block-protection-rearchitecture.md)。

## 逐项核实(亲手读码)

### 1. must-fix compat 值迁移 — RESOLVED(诊断+测试层),实现描述 PARTIAL
- validation.ts:64/68/69 证实:key-present 判断对合法值同样为真 → 无条件 delete+warn 在 translate 之前。translate 返回 undefined 则 key 被静默丢(73 continue)。
- 关键:warn(69) 是循环体内**无条件**触发,纯 builder 无法抑制。专用变体必须改 `extractAndTranslateDeprecated` 循环结构(把 warn+delete 改为"仅当值是 legacy 才触发"),plan 描述了正确终态行为但没点明修在循环而非 builder。
- TDD step #1 + 测试 harness 的 `expect(warnSpy).not.toHaveBeenCalled()` 会强制实现正确。

### 2. Part 5 空消息移位 — RESOLVED,降级为技术确定项
- tool-blocks.ts:148/175 + tool-utils.ts:126 证实"删整条空消息"是既有普遍行为 → 连续同 role 风险确实"与现状一致不恶化"。
- 移位后 stats:filterEmptyThinkingBlocks 仅 result.ts 一处调用,finalize 仅 sanitize.ts 一处调用 → 完全封装。totalBlocksRemoved 锚定 originalBlockCount(含被删块),block-count delta 在移位处算可行,算术自洽。
- count-tokens 不走 sanitizeAnthropicMessages → 移位对其中性无影响。
- **不需要回到用户**——已是技术裁决项,实测兜底足够。

### 3. incomplete 补全 — RESOLVED
state.ts:40-46 JSDoc(三档枚举,必改)、config.schema.json 改为 generate:config-schema(脚本存在 package.json:38)、docs/sync-ghc-api/messages-api.md:80(死引用确认)、config-yaml-routes:179/451 round-trip、config-hot-reload:274-278(sampleValue=stripped+动态默认,确认无需改)——全部核实属实。

### 4. 新风险 — 无实质新风险
移位无副作用(封装完整、算术自洽、全调用点统一)。

## 独立发现(两轮均未点明)
- config-validation.unit.test.ts:47-61 "fully-valid...unchanged" 用 immutable + 断言 not warn → 迁移后会 warn,必改值。plan flag 了 :52(在此块内),覆盖但需执行者注意整块。
- config-compat.unit.test.ts:125 `toBe("immutable")` 须改 `toBe("preserve")`;plan 仅泛指"同步",非字面;靠 test:backend 跑出来兜底。
- compat.ts:132 既有 bool 迁移产 "immutable"(将非法);plan Part1 已明确改 preserve。

## 裁决
(A) 可放心执行。无 NOT-RESOLVED。唯一 PARTIAL=#1 实现位置描述(循环 vs builder),被 TDD 强制兜底。
(B) 无需回到用户的主观决策点。policy 两档、默认 preserve、Part5 移位均已由实证/技术裁决确定。
(C) 见上独立发现:均为 test 字面断言更新,typecheck 不捕获、靠 test:backend green 兜底,非阻塞。
