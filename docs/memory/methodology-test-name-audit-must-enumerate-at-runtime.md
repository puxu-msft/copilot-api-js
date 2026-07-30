---
name: methodology-test-name-audit-must-enumerate-at-runtime
description: 用 grep/正则扫 `test("...")` 做用例名集合 diff 来判断「有没有测试被删掉」是结构性失明的——参数化循环 + 模板字符串命名的用例整批扫不到，会报出假的「用例消失」，反过来也会让「没有消失」这个结论建立在不可靠方法上；唯一可信的 oracle 是运行时枚举（跑测试数计数 / reporter 输出）
metadata:
  type: methodology
---

判断一次重构「有没有悄悄删掉测试」时，**静态 grep 用例名不是 oracle**。典型写法一律扫不到：

```ts
for (const abortKind of ["reaper-cancel", "timeout"] satisfies ReadonlyArray<PostCommitAbortKind>) {
  test(`${abortKind} is deliberately excluded by the user-owned never-false-kill constraint`, () => { … })
}
```

模板字符串命名 + 参数化循环，`grep -oE 'test\("[^"]*"'` 只认双引号，于是这两条在集合 diff 里表现为**被删除**。

2026-07-30 实例：评审用该 grep 审 B2 Task 4.2 的重构，报出两条 `never-false-kill` 用例「消失」——打开文件才发现是参数化改写，用例只增不减（运行时计数 6 → 7）。**更要紧的是它同时意识到：上一轮它用同一把 grep 得出的「无用例消失」结论碰巧是对的，但方法当时就已经不可靠**——一个正确结论并不给方法背书。

**How to apply:**
- **用例集合的唯一可信 oracle 是运行时枚举**：跑 `bun test <files>` 读实际用例数 / reporter 的用例名列表，改动前后各跑一次比对。静态扫描只能当**线索**，不能当结论。
- 报出「某用例消失」时，**先打开文件确认**再定性——假警报的成本是让人去找一个不存在的缺陷，且会稀释真警报的可信度。
- 同一族的失明还包括：`it(...)` / `test.each` / `describe.each` / 变量名传入的用例名 / 条件跳过（`describe.skipIf`）。凡是**用例名在运行时才成形**的写法，静态正则一律看不见。
- 反向的更危险：**方法不可靠 + 结论碰巧正确**时，没有任何信号告诉你该换方法。所以判据应当在**方法层**定死（「集合 diff 一律运行时枚举」），而不是等某次报错了才改。

**Related:** 同族根 [[feedback-pass-null-clean-not-self-validating]]（通过/空/干净结论不自证）；[[methodology-new-oracle-discriminating-power-is-experimental]]（新 oracle 的区分力是实验问题）；守卫用手写字符串匹配而非问解析器的同构错误见 skill `reshaping-a-bypassed-guard`（判据换轴：别手写，去问已经知道答案的那个东西）。
