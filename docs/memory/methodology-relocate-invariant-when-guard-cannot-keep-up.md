---
name: methodology-relocate-invariant-when-guard-cannot-keep-up
description: 守卫连续 2 轮被合法语法绕过就停止加固、换判据的轴（换位置/换形状/别手写去问编译器/换问的对象），而不是把排除名单越写越长；含过近似的方向判据与「修复要落在共享处否则只救一个消费者」
metadata:
  type: project
---

telemetry 抽包（2026-07-27）的合并态审跑了**六轮**，每轮异模型 reviewer 都用**合法且能编译的**写法绕过我刚加固的守卫。完整轨迹在 `docs/plan/monorepo-split/plan-telemetry-package.md` 与 `tests/architecture/{source-ast,telemetry-domain-surface,telemetry-startup-order}.ts` 的注释里；本条记**可迁移的判断法**。

**Why:** 输的模式每轮一模一样——我把检查**加深一层**（正则→更细的正则→AST 一跳→AST 两跳），reviewer 就找到第 N+1 种合法写法。原因是判据形状错了：**枚举"坏的形态"是开放集合，永远补不完**；而我每轮的 mutation 验证只证明「守卫能抓我想到的破法」，抓不到我想不到的。两次转折点都不是「更强的守卫」：

**How to apply（识别 + 三种换法）：**

**识别信号**（命中任一就停止加固、退一步换形状）：① 同一守卫连续 2 轮以上被新的**合法**语法绕过；② 修复方式是往一个"排除/禁止"名单里加成员；③ 你能一眼看出还有第 N+1 种没列进去。

1. **blocklist → allowlist（换判据）**。原本枚举"禁止导出的 operation 名字"，于是别名/`export default`/namespace 对象/`const` 包装/跨文件两跳链逐个成为绕法。改成**枚举 barrel 允许公开的精确名单**后，这些一次全封死——因为守卫不再问"这名字哪来的"，只问"它在不在契约上"，**跨文件解析因此变得不必要**。附带收益：举证责任反转，扩大公开 API 必须显式加一行=强制评审。
2. **把不变量搬进被守护对象自己（换位置）**。启动顺序 `initialize → listen → backfill` 原本只活在 `start.ts` 的语句顺序里，靠解析那个文件来守；可选链、label+break、`throw` 后死代码、`catch` 分支、没人调的 helper 逐个成为绕法，而**语法近似永远证不了可达性**。改成 runtime 自己持有相位：`markServerListening()` 在未 initialize 时 fail-fast、`runJsonBackfill()` 在标记前**延迟到标记时**——于是"调用写反了"不再能破坏契约。守卫只剩一个 runtime 自己证不了的窄职责（有没有人调我）。
4. **别手写，去问已经知道答案的那个东西（换实现者）**。2026-07-29 state→foundation 那轮四次成功换轴全是这一形：手写候选表 `[x, x.ts, x/index.ts]` → `ts.resolveModuleName` + 项目自己的 compilerOptions（守卫与 tsc 不可能再分歧）；子串/正则判「源码含某文本」→ `ts.createScanner` 逐 token 比**解码值**（转义拼法一次全覆盖，此前 `text.includes` 与 `/\\[ux]/` 两版都被 identity escape 和行接续穿过）；按名字追 loader（改名/别名/`var` 提升/括号 callee 各绕一次）→ **守能力门**（`createRequire` 只从 `node:module` 来，import 它是语法上的单一事件，**没拿到的东西没法改名**）；枚举 callee 形态 → **只问目标**（有没有哪次调用把 `~/routes/…` 当第一个实参——「调用怎么写」被整个绕开）。**判别句：我是在重新实现一个别人已经实现对了的东西吗（解析器/词法器/binder）？** 手写 binder 那次连 `var` 提升都判错。

**过近似允许，但要真的是过近似。** 换轴时常用「宁可多报」兜底，方向判据是：**文件级过近似安全**（作用域盲最多多一行登记要解释），**文件级欠近似是静默失明**。陷阱：我曾给一个欠近似套上过近似的外衣——loader 名字的种子只看一级 initializer 文本，一次改名就断链——并为它辩护了一轮，是评审拆穿的。自检：**我的候选集真的是真实集合的超集吗，还是只覆盖了我想到的那些入口？**

**修复要落在共享处，否则只救一个消费者。** 同一条「比解析后目标、别比拼写」在 state 闭包修好之后，**在 core→server ratchet 里又原样活了四轮**，因为修复写在了消费者里。换轴之后立刻问：**还有谁在用旧形状？** `containedIn` 因此提到 `tests/architecture/source-ast.ts`，两个坑（按段比较、canonical 化）写在它自己的文档里。仓库里仍有两个守卫没搬到（telemetry / generation），见 `docs/todo/deferred-backlog.md`。

3. **接受近似但诚实标注（换声明）**。真做不到时，把守卫**能证明什么/不能证明什么**写进注释，残余立 backlog 带触发条件——而不是让注释暗示它是硬保证。反例见下。

**同轮踩到的两个自审盲区（独立价值）：**
- **注释写错 → 照着注释写的代码看起来就是对的**。我在 `unconditionalOnly` 文档里写「try/catch/finally 都不 gate 正常路径」，对 `catch` 是错的（只在抛错时跑）。于是"把生产调用从 `try` 体移进 `catch`"编译通过、正常路径永不执行、守卫全绿。**自洽且完全错**。
- **mutation 不咬 ≠ 代码没问题，也可能是 oracle 假绿**。runtime oracle 第一版用空 `:memory:` 库断言 backfill 未执行——但空库下 backfill 跑不跑**结果都一样**，去掉延迟逻辑照样绿。改成喂真实的 in-retention legacy 快照、经独立连接数 `tel_raw` 行数才有分辨力。**反过来也要诚实**：第三条 mutation（去掉延迟槽清空）不咬，因为单次吸收本就由 registry 的快照消费 + version 守卫保证——这时要改的是**测试的措辞**（别声称覆盖了那行），不是硬加断言。

**2026-07-28 印证实例（第 3 条「诚实标注」被照做了一次，并暴露它的前置条件）**：abort-provenance gap 计数只在 driver 的 `streamErrorOutcome()` 里打，守卫要证「全仓只有这一处 mint」。逐行 regex → AST，异模型 reviewer 每轮拿新的合法写法穿过去（computed `["kind"]`、指向同文件 const 的 identifier、shorthand）。这次没有继续加深：补完这三种后**在注释里点名抓不住什么**（跨模块 import 的值、函数返回值——都需要跨表达式常量求值），并把根治形状（给 variant 加只有 helper 能造的 brand）写进 backlog 带触发条件。**新增的前置条件**：写「诚实标注」时也得**先实测自己抓得住哪些**——我加固 AST 版时它对 helper 自己的 `"stream-error" as const` 统计为 0，即那一版**同样放过 `as const` 写法的绕过**，是「helper 必须恰好 mint 一次」的正样本对照抓出来的。**一个宣称覆盖面大于实际覆盖面的守卫本身就是假绿**，它诱使人说「机器会查的」。

**Related:** [[feedback-pass-null-clean-not-self-validating]]（守卫"绿"不自证）、[[tooling-eslint-no-restricted-imports-group-is-or-not-allowlist]]（同轮的 allowlist 工具坑）、[[methodology-domain-peel-execution-techniques]]（本次抽包的执行技巧）、[[methodology-exhaustive-record-proves-table-not-that-live-path-reads-it]]（守卫/穷尽性证明「表填全了」而非「活路径在读它」）、[[feedback-verify-facts-before-superlative-completeness-verdict]]（别在没实测每个支撑事实前下完备性结论）。
