---
name: methodology-new-test-red-and-green-both-overclaim
description: 新写的测试，红别默认怪测试（可能撞到真缺陷）、绿别默认证到性质（N-bounded 推不出全称）
metadata:
  node_type: memory
  type: methodology
  originSessionId: b33d0633-a456-430b-af0b-a17c07796f7c
---

一条**刚写的**测试给出的信号，两个方向都容易被过度解读。2026-08-09 History Worker Batch 2a 同一批里两个方向各中一次。

## 红：新测试 flaky，别默认是测试的错

新写的 poison-journal 用例在 `bun run test:backend` 下 **3 次红 2 次**，收到的错误还与预期不符（`database is locked` 而非期望消息）。当时最顺手的解释是「新测试对负载敏感，加个 retry / 放宽断言」。

**实际根因是产品缺陷**：Worker 把**任何** initialize 抛错都当成 `fatal`，于是负载下一瞬间的 `SQLITE_BUSY` 会让 History 在整个进程生命周期内不可恢复——与 spec「可重试启动错误走自动重启」直接冲突。修根因后连跑多次全绿。

**判据（在改测试之前问）**：这条红**如果**是真缺陷，它会长什么样？把那个形态写下来，再看观测到的证据符不符。本例的关键线索是**收到的错误消息与预期不同**——纯粹的争用型 flaky 通常是超时或计时比值，不会换一条来自被测代码的具体错误。

**与既有条目的分界**（别混）：[[methodology-false-red-from-process-global-quantities-not-the-mechanism]] 与 [[methodology-full-suite-red-classify-before-pollution-playbook]] 讲的是「红了但**不是**真缺陷」的两类；本条讲相反方向——**新测试的红，先当真缺陷办**，因为它是唯一一个此前从没绿过、也就从没有过「它曾经对」这个先验的判据。区分二者的现成信号：同一批里若**每次红的是不同测试**、且**单跑均绿**，那是争用；**稳定咬同一条**、且错误来自被测代码，那要按真缺陷查。

## 绿：N-bounded 的行为测试推不出全称性质

同一批里写了一条「连续 12 次崩溃仍不进入终态」，用来守「**不得凭次数合成终态**」。评审一句话点破：它只证明了前 12 次，**实现完全可以在第 13 次 `failTerminal`，这条测试照绿**——因为第 13 代恰好 ready。变异实测证实：注入「≥13 次即终态」，行为测试**全绿**。

**判据**：当你想守的性质带 ∀（永不 / 恒 / 任意次数 / 所有输入），而测试只能举出有限个例子时，**这条测试不是那个性质的判据，只是一条回归护栏**——按它真正证明的东西命名（本例改成「twelve consecutive crashes do not terminate…」，并在注释里写明 N=12 是为了越过旧的默认上限 10）。

**全称性质要挪到它可判定的层**去表达。本例挪成**结构断言**：`handleTransportCrash` 的函数体内**不含**任何 `failTerminal` 调用（AST 计数）。它对任意 N 成立，且同一条「第 13 次终态」变异**当场变红**。这就是 [[methodology-relocate-invariant-when-guard-cannot-keep-up]]（skill `reshaping-a-bypassed-guard`）在「行为测试 → 结构判据」方向上的实例。

**配套的坑**：结构判据别用**文本匹配**。第一版写成 `expect(source).not.toContain("exhausted")`，而 `exhausted` 是普通英文词、正好出现在该文件自己的注释里（"exhausted disk"），当场假红。改成 AST 取**已声明成员名**后才既准确又不受散文影响——同 [[feedback-fix-all-comparison-sites]] 家族的 `count-syntax-with-ast`。

**Related:** [[feedback-pass-null-clean-not-self-validating]]（通过/空/干净不自证，本条是它在「新测试」上的两个具体形态）、[[methodology-verify-the-mutation-actually-applied]]、[[reference-bun-test-eager-rejects-assertion-hangs-file]]（变异对照拿不到可用红的另一种成因）。
