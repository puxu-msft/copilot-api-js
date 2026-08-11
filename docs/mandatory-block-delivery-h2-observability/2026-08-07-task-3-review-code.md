# Task 3 独立代码复审

## 结论

- **评审范围**：精确候选 `300d01a3..b8ae7e8c`，两提交 `8572b892` + `b8ae7e8c`；复核上一轮 live outcome Important、branded assembled opts、callback语义、无candidate/public shape、dry-run及跨协议生产接缝。
- **已读取／执行的证据**：读取精确 diff与最终代码；在 frozen snapshot `/tmp/copilot-api-js-task3-review-b8ae7e8c` 运行完整 `driver.unit` 46／46、Chat buffered 5／5、Responses buffered 11／11、Anthropic buffered 9／9、driver fence + candidate suites 15／15、live Chat streaming 2／2、typecheck通过。
- **总体 verdict**：**Spec PASS；Quality APPROVED；可集成。**
- **blocker 数量**：0。Critical 0；Important 0；Minor 2。

## Important 复核：live public outcome shape

**RESOLVED。** `/tmp/copilot-api-js-task3-review-b8ae7e8c/src/lib/pipeline/driver.ts:1138-1188` 的 `capturesFinish` 仅在以下任一事实成立时安装driver finish observer：存在真实 generation binding、effective candidate/outer `finishResponse`、或调用者显式 `onFinishResolved`。无candidate／无finish callback兼容路径不安装observer，返回恢复为精确 `{kind:"complete",headers}`；完整driver suite 46／46恢复。存在candidate的live路径仍捕获finish，不影响Chat handler对账。

- `capturesFinish` 判断无副作用，只读binding与函数存在性；不会调用predicate。
- 若仅caller提供`onFinishResolved`，wrapper先保存finish再调用caller；caller throw继续传播，无吞错。
- 若candidate存在，即使其finish回调来自session默认值也捕获，这是Task 3协议finish对账所需。
- dry-run走public `runResponse`而非sink wrapper，不受`capturesFinish`改变；live Chat direct/via-Responses字节锁2／2绿。

## Branded assembled opts与callback契约

**PASS。** `/tmp/copilot-api-js-task3-review-b8ae7e8c/src/lib/pipeline/driver.ts:858-957` 移除 `optsAlreadyMerged` boolean，改为私有 `AssembledCandidateResponseOpts` + `runAssembledCandidateResponse`：

- 裸 `RunBufferedOpts`不满足unique-symbol brand，源码内 `AssertFalse<IsAssignable<...>>` 是编译正控；typecheck绿。
- brand symbol仅`declare`，没有运行时值或export；外部／route无法构造，文件内仅`currentCandidateResponseOpts`签发。虽然TypeScript可用双重cast伪造任何类型，但当前没有第二cast点，攻击面不比其他私有类型大。
- buffered每attempt恰一次candidate+outer merge，再由`withBufferedFinishObserver`只替换observer；assembled入口不再merge。
- additive callbacks顺序仍为outer→candidate；driver-local observer在外层先保存finish，再调用最终assembled observer。异常按调用顺序传播；outer throw会阻止candidate callback，这与普通函数组合的既有fail-fast契约一致，未被本修复改变。
- terminal predicates为outer短路OR candidate；当前outer predicates均纯读。candidate字段默认优先的既有契约保持，只有明确列出的additive seams组合。

## Recovery、兄弟协议与竞态

**PASS。** recovery bind后下一attempt按current upstream取得最新session并签发新brand；finish observer不跨attempt复用。Chat／Responses／Anthropic三套完整buffered production suites合计25／25绿，fence与candidate 15／15绿。状态均为request-local，未发现新共享竞态；Task 4边界未越界。

## 事实性发现

### Critical／Important

未发现问题。

### Minor

[Minor] `/tmp/copilot-api-js-task3-review-b8ae7e8c/src/lib/pipeline/driver.ts:864-870` — branded opts的正控嵌在生产模块并生成一个运行时`false`常量（随后`void`），虽开销可忽略但职责偏测试 — 预期影响：生产文件增加类型断言噪音 — 推荐后续迁到type-test文件；不能迁成运行时测试，因为brand本来就是compile-time only。

[Minor] `/tmp/copilot-api-js-task3-review-b8ae7e8c/src/lib/pipeline/generation/candidate-response-session.ts:213-220` — Responses `complete` compatibility特判仍是Task 4前迁移桥；production suites证明当前必要，但Task 4 outcomes直连时应同commit删除，避免长期双读面。

## 双向判据与结构怪味

- 正样本：三协议buffered、live有candidate、fence、candidate、dry-run相邻路径全绿。
- 负样本：无candidate live exact shape恢复；裸opts compile-time不可传assembled入口；失败路径不追加成功terminus。
- 结构已从易误用boolean门收敛为私有类型入口，长期方向正确。
