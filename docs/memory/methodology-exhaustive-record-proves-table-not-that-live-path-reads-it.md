---
name: methodology-exhaustive-record-proves-table-not-that-live-path-reads-it
description: 类型系统逼出的穷尽 Record 只证明「表填全了」，不证明「活路径在读这张表」——formatError 无生产调用者时四份 codec 表全绿而 wire 照旧输出旧值
metadata:
  node_type: memory
  type: feedback
  originSessionId: f2760de9-33a3-4ce4-8dc8-5c4cc9319da8
---

**给 union 加成员、让 `Record<Kind, T>` 的穷尽性在编译期逼出每一处站点——这只证明「每张表都填全了」，绝不证明「生产路径在读这些表」。** 两件事之间隔着一个「这个函数有没有调用者」的问题，而类型系统对此完全沉默。

2026-07-28 copilot-api-js 实例：给 `StreamErrorKind` 加 `request-deadline`，编译器逼出 4 个 codec 的 5 处穷尽 `Record`，逐处填好、测试全绿，我据此报告「deadline 在 Anthropic 映射 `timeout_error`、Gemini `DEADLINE_EXCEEDED`」。异模型复审实测：**codec 的 `formatError` 没有任何生产调用者**（每个 handler 都在 route 层内联构造终端 error frame，注释里甚至写明了这一点）。活路径各有一份**私有的小 switch**——Anthropic `classifyStreamErrorType` 让 deadline 落 default `api_error`，Gemini `geminiStreamErrorStatus` 落 default `INTERNAL`。分歧还不止新成员：两份映射连 `reaper-cancel` 都给不同的值。OpenAI 那条腿唯独是对的，纯因为它的映射早就抽成了共享函数、codec 与 handler 调的是同一个。

**Why:** 穷尽性守的是「表的完整性」，覆盖不到「表的**可达性**」。而单测喂的是 kind 字符串→formatter，正好绕开了「谁调 formatter」这一段——**测试与被测代码同源地绕开了同一个缺口**。把 kind 喂给 formatter 的测试，无论多少条、多绿，都无法区分「活路径读这张表」与「这张表是死代码」。

**How to apply:**
- 加/改一张映射表后，**先问「谁调它」再报告完成**：`rg -n '<函数名>' src/` 看有没有生产调用者；有同名/同职责的第二份实现更要当场对账。同职责两份映射并存 = 必然漂移，只是还没被观测到。
- **修法是消灭双份，不是把值抄一遍**。抄一遍会在下一个成员上原样复发。收敛时挑仓库里**已被证明不漂移的那个形状**当模板（这里是 `~/lib/openai/stream-error`：单一 `Record` + 薄包装，codec 与 handler 同调）。顺带把逐字重复 N 份的私有表提到产生方（`StreamErrorKind` 的家 = `packages/foundation/src/stream.ts`）。
- **验收 oracle 必须是 production-facing**：从真实入口驱动（`ctx.cancel(...)` / 真实 signal）读**客户端实际收到的字节**，别把 kind 喂给 formatter。判据是「这条测试能不能区分活路径读表 vs 读私有副本」。
- **mutation 要打在共享表上**：改坏表里的一个条目，若活路径的测试变红，才证明活路径确实在读它。表改坏而测试仍绿 = 你测的是死代码。
- 同类名实分裂顺手一起治：两个本该联动的字段各自独立硬编码（Gemini `status` 查表、`code` 却是 `shutdown ? 503 : 500`）迟早配出 `DEADLINE_EXCEEDED` + `500`。让派生字段**从主字段推导**，而不是并列维护。

姊妹：[[methodology-full-primitive-not-partial-else-silent-field-drop]]（选原语的粒度）、[[methodology-reasoned-safe-not-tested-producer-wire-oracle]]（单测绿 ≠ wire 对）、[[feedback-fix-all-comparison-sites]]（多站点复发）、[[methodology-new-oracle-discriminating-power-is-experimental]]（每加判据必答「什么变异能让它红」）。根：[[feedback-pass-null-clean-not-self-validating]]。
