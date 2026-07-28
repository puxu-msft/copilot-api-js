---
name: methodology-new-oracle-discriminating-power-is-experimental
description: 自己新写的 oracle 断言「它一定咬得住」只是推理不是实验——每加一个判据都要答「什么变异能让它红」，答不上来就是没鉴别力
metadata:
  type: feedback
---

**给自己新写的 oracle 下「它专门咬某某失败」这类绝对断言，是推理不是实验。** oracle 的鉴别力和被测代码的正确性一样，是需要实验证明的经验性主张。

2026-07-28 的 state→foundation 交接整改里，我一轮内连犯三次，**而这份文档通篇在教读者「守卫绿不自证」**：

- **S2「环数不回升，专门用来咬 re-export 逃生口」** —— 错。该步同时移走别的边，删掉的旧环完全可能多于新增的两节点环，`count` 不回升照样绿。**鉴别力来自集合差（新环/新成员），不来自计数。**
- **S1「`toBe` 而非 `toEqual` 能证明是同一份绑定」** —— 错。primitive string 两者都只是值相等，两处独立重复的字面量照样通过。单一 owner 只能用 source guard（AST 断言旧模块不再有自己的声明）证明。
- **S4「`git diff --stat -- tests/` 为空即调用点未改」** —— 无鉴别力。前序步骤已合法改过约 104 个测试文件，diff 被 churn 污染；且**按文件路径做的排除，恰好在允许改动的地方留了洞**。换成 `文件 + 词法调用序号 + 规范化实参` 三元组比对。（后续还发现「全局实参 multiset」也不行——两个调用点互换整份实参会通过。）

**Why:** 写 oracle 时人处在「我知道我想抓什么」的心智状态，于是把**意图**当成了**能力**。而假绿的定义就是「意图与能力不一致」——正是最容易自我欺骗的位置。判据形状的错误比代码错误更隐蔽：代码错了会红，判据错了会**绿**。

**How to apply:** 每新增一个 oracle（测试断言、守卫、grep 判据、验收命令），当场问一句「**什么变异能让它红？**」，答不上来或答案与你想抓的失败不是同一件事，就是没鉴别力。落到具体形态：① 计数类判据换成集合差；② 值相等换成来源/身份断言；③ 按路径排除换成按目标对象本身断言；④ 变异实验的正样本必须**旧判据不咬、新判据才咬**（只用新旧都咬的样本，得到的「变红了」是假信号）。

Related: [[feedback-pass-null-clean-not-self-validating]]（通过性结论不自证的根条目）、[[methodology-relocate-invariant-when-guard-cannot-keep-up]]（守卫连续被合法语法绕过时换判据形状/换不变量位置）、[[methodology-verify-the-mutation-actually-applied]]（变异本身也要自证生效）。
