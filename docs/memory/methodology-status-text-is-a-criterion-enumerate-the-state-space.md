---
name: methodology-status-text-is-a-criterion-enumerate-the-state-space
description: 面向操作者的状态文本也是判据、也会假绿；按「我想到的场景」枚举分支必漏格，要按驱动它的返回值状态空间穷举
metadata:
  node_type: memory
  type: feedback
---

**一段告诉人「刚才发生了什么」的文本，和一条断言一样是判据——它同样会在某些格子里报出让人放心的假话。** 而漏格几乎必然发生，因为**分支是按「我想得到的场景」写的，不是按「驱动它的那组值有几种有意义的组合」写的**。属 verification 簇（[[feedback-pass-null-clean-not-self-validating]] 的「空≠负」在**人类可读输出**上的形态；与 [[methodology-missing-evidence-counted-as-zero]] 并列——那条讲聚合器的零来自「没读到」，本条讲**零来自「确实没做成」却被渲染成进展**）。

**实例（2026-08-10，shutdown 第二档信号的操作者横幅）**：横幅原本无条件打印 `terminated N in-flight request(s), now flushing`。同一个缺陷被抓了**三次**，每次我都以为已经闭合：

1. drain 尚未开始（`activeDrainSource` 还是 null）→ 打印 `terminated 0 … now flushing`，而这一档根本够不到任何东西。我修了。
2. 残余是「已 settled 但仍在 finalizing」的 operation → `fail()` 早返回却照样 `reached++`，数字直接谎报。我修了，并以为「两格都覆盖了」。
3. **registry 里只剩 lightweight operation** → 三个计数**全为 0**，落进我新写的「无残余」分支，照旧打印 `now flushing`——而 drain 正被那些不可取消的 operation 阻着。这一格是独立评审实测发现的，不是我想到的。

**根因**：我写的是 `if (没开始) … else if (有 settled 残余) … else 一切正常`，而真正该问的是：驱动这段文本的返回值 `{started, terminated, finalizing, lightweight}` **有几种有意义的组合**？照后者写，第 3 格自己就冒出来了。

**How to apply**：
① **先写下驱动文本的那组值，再写分支**；分支数对不上组合数就是漏了格，别用「我想不出还有什么场景」收尾。
② **`0` 单独出现时必须追问它的成因**：是「没有可做的」还是「做不到」？前者可以说「完成」，后者必须说清是什么在挡着——两者在计数上完全一样。
③ **只在「确实没有东西还挡着」时才敢许诺下一步**（本例：残余列表为空才说 `now flushing`）。许诺型措辞（正在刷盘 / 已完成 / 即将退出）比数字更容易被当真。
④ 变异对照要打在**措辞的条件**上而非只打在计数上：把 `if (残余为空)` 改成 `if (true)`，看有几条用例变红——本例一次红 3 条，正是它该有的覆盖面。
⑤ 同一缺陷第二次被指出时，**别只补那一格**，回头把状态空间列全；第三格通常就在旁边。
