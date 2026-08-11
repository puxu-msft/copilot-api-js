---
name: methodology-sweep-a-concepts-whole-vocabulary-not-one-keyword
description: 删除或重命名一个概念后清扫文档，grep 一个词返回零不代表概念扫净——同一概念通常有四五个称呼（类型名/方法名/属性名/描述其策略的形容词），漏掉的那些恰好活在最要紧的契约文档里
metadata:
  type: feedback
---

删掉或改掉一个概念之后做文档／注释清扫时，**grep 的是词，不是概念**。同一个概念在文本里通常有好几个称呼，它们分属不同词性、不共享任何子串，所以扫净其中一个对其余毫无信息量——而「`rg <那个词>` 返回空」读起来却像是一句完备性结论。

**实证（2026-08-11，RequestEnvelope 三作用域重构）**：把 `requestState` 拆成 `request`/`candidate` 两个作用域、并把 copy-on-write 的 `with()` 改成就地写的 `writeAttempt` 之后，我按 `requestState` 扫了 src + tests + docs，逐处改完、命中归零、宣布完成。但同一次改动的另一半留在原地：

| 称呼 | 词性 | 在哪 |
|---|---|---|
| `requestState` | 属性名 | 我扫了 |
| `env.with()` / `RequestEnvelope.with` | 方法名 | 漏 |
| 「immutable」「NEW env」「pure transform」 | 描述该策略的形容词 | 漏 |
| 「defensive body clone / defense-in-depth」 | 描述被一并删掉的配套机制 | 漏 |

漏掉的这些**恰好落在最要紧的地方**：`hooks/types.ts` 的 `client.inbound` 契约仍写着「driver 交给 hook 一份防御性 body 克隆（immutable-return + defense-in-depth）」，而防御性克隆正是用户裁决删掉的；`RewriteResult.env` 仍文档为「Immutably-updated envelope」，而 `writeAttempt` 返回的是**同一个对象**——照这份契约写的作者会持有一个 pre-rewrite 引用并以为它还是旧 body。属性名散在实现注释里（改错了代价小），而形容词散在**面向作者的契约文档**里（改错了代价大）：清扫顺序与风险顺序恰好相反。

**How** —— 下刀前先写下这个概念的**称呼表**，再逐个称呼扫：

1. 列出四类：**类型/接口名、方法/函数名、属性/字段名、描述其策略的形容词与配套机制名**。第四类最容易漏，因为它不是标识符、不会被任何工具的「重命名符号」带走。
2. 每个称呼各扫一遍，**分别**报命中数。合并成一句「已清扫」就丢掉了「哪个称呼扫过、哪个没扫」这个信息。
3. 判据不是「命中归零」而是「**称呼表上每一项都被扫过**」——前者是 [[feedback-pass-null-clean-not-self-validating]] 的空命中陷阱在清扫场景的实例。
4. 按后果排序先扫**契约文档**（给 hook/插件/rewrite 作者读的），再扫实现注释。

**与 [[feedback-fix-all-comparison-sites]] 的分工**：那条问「**这件事在系统里被独立做了几次**」，按业务维度（腿／格式／端点）枚举入口，治的是「同一动作多个入口」；本条问「**这个概念在文本里被叫过几个名字**」，治的是「同一概念多套措辞」。两条都是「grep 的边界」，但枚举的维度不同，漏的东西也不同。

**触发提醒**：这次是用户一句「整体都做完了吗」才让我回头核的——我自己给出的「清扫完成」是自证结论。凡是宣称某类清扫完备，先把称呼表交出来。
