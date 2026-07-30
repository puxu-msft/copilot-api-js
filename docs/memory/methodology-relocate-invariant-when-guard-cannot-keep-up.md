---
name: methodology-relocate-invariant-when-guard-cannot-keep-up
description: 守卫被合法语法反复绕过的两次项目实例与实测证据（telemetry 抽包 6 轮、state→foundation 10 轮）——方法论已升级为 skill `reshaping-a-bypassed-guard`，本条只留事故时间线与取证
metadata:
  type: project
---

> **方法论的权威源是 skill `reshaping-a-bypassed-guard`**（停手判据、四种换轴、过近似的场景限定、接线 oracle、自验）。本条只留**项目实例与实测证据**——两处操作正文并存必然漂移，这一点在 2026-07-29 已经踩过一次（同一教训被写成三份）。

telemetry 抽包（2026-07-27）的合并态审跑了**六轮**，每轮异模型 reviewer 都用**合法且能编译的**写法绕过我刚加固的守卫。完整轨迹在 `docs/plan/monorepo-split/plan-telemetry-package.md` 与 `tests/architecture/{source-ast,telemetry-domain-surface,telemetry-startup-order}.ts` 的注释里；本条记**可迁移的判断法**。

**Why:** 输的模式每轮一模一样——我把检查**加深一层**（正则→更细的正则→AST 一跳→AST 两跳），reviewer 就找到第 N+1 种合法写法。原因是判据形状错了：**枚举"坏的形态"是开放集合，永远补不完**；而我每轮的 mutation 验证只证明「守卫能抓我想到的破法」，抓不到我想不到的。两次转折点都不是「更强的守卫」：

**证据（可迁移的判断都在 skill 里，这里只记发生了什么）：**

输的模式每轮一模一样——我把检查**加深一层**（正则→更细的正则→AST 一跳→AST 两跳），reviewer 就找到第 N+1 种合法写法。两次转折点都不是「更强的守卫」，而是换轴：① barrel 从「枚举禁止导出的 operation 名」换成「枚举允许公开的精确名单」，别名/`export default`/namespace/`const` 包装/跨文件两跳一次全封死；② 启动顺序从「解析 `start.ts` 的语句顺序」换成「runtime 自己持有相位」（`markServerListening()` 未 initialize 即 fail-fast），于是「调用写反了」不再能破坏契约。

**2026-07-29 state→foundation 的第二次实例（10 轮）**：同一形状复现七次——只查 3 个文件却声称查闭包 / 把「以点开头」当「在包内」 / 只认 `StringLiteral` 却声称覆盖全部 import 形态 / 把「不可知」当「不存在」 / 只扫 `.ts` 却声称扫全树 / 按 `~/routes` 拼写判断却声称约束依赖 / 冻结 specifier 文本却声称冻结边。四次成功换轴全是「别手写、去问已经知道答案的那个东西」（`ts.resolveModuleName` / `ts.createScanner` / 守 `node:module` 能力门 / 只问目标）。**这轮最贵的教训不在守卫本身**：本条记忆当时就在上下文里，识别信号第 2 轮即全部命中，我仍补到第 7 轮——这次 miss 是把方法论升级成 skill 的直接原因，记在 `~/.claude/skills/reshaping-a-bypassed-guard/verification-log.md`。

**同轮踩到的两个自审盲区（独立价值）：**
- **注释写错 → 照着注释写的代码看起来就是对的**。我在 `unconditionalOnly` 文档里写「try/catch/finally 都不 gate 正常路径」，对 `catch` 是错的（只在抛错时跑）。于是"把生产调用从 `try` 体移进 `catch`"编译通过、正常路径永不执行、守卫全绿。**自洽且完全错**。
- **mutation 不咬 ≠ 代码没问题，也可能是 oracle 假绿**。runtime oracle 第一版用空 `:memory:` 库断言 backfill 未执行——但空库下 backfill 跑不跑**结果都一样**，去掉延迟逻辑照样绿。改成喂真实的 in-retention legacy 快照、经独立连接数 `tel_raw` 行数才有分辨力。**反过来也要诚实**：第三条 mutation（去掉延迟槽清空）不咬，因为单次吸收本就由 registry 的快照消费 + version 守卫保证——这时要改的是**测试的措辞**（别声称覆盖了那行），不是硬加断言。

**2026-07-28 印证实例（第 3 条「诚实标注」被照做了一次，并暴露它的前置条件）**：abort-provenance gap 计数只在 driver 的 `streamErrorOutcome()` 里打，守卫要证「全仓只有这一处 mint」。逐行 regex → AST，异模型 reviewer 每轮拿新的合法写法穿过去（computed `["kind"]`、指向同文件 const 的 identifier、shorthand）。这次没有继续加深：补完这三种后**在注释里点名抓不住什么**（跨模块 import 的值、函数返回值——都需要跨表达式常量求值），并把根治形状（给 variant 加只有 helper 能造的 brand）写进 backlog 带触发条件。**新增的前置条件**：写「诚实标注」时也得**先实测自己抓得住哪些**——我加固 AST 版时它对 helper 自己的 `"stream-error" as const` 统计为 0，即那一版**同样放过 `as const` 写法的绕过**，是「helper 必须恰好 mint 一次」的正样本对照抓出来的。**一个宣称覆盖面大于实际覆盖面的守卫本身就是假绿**，它诱使人说「机器会查的」。

**Related:** [[feedback-pass-null-clean-not-self-validating]]（守卫"绿"不自证）、[[tooling-eslint-no-restricted-imports-group-is-or-not-allowlist]]（同轮的 allowlist 工具坑）、[[methodology-domain-peel-execution-techniques]]（本次抽包的执行技巧）、[[methodology-exhaustive-record-proves-table-not-that-live-path-reads-it]]（守卫/穷尽性证明「表填全了」而非「活路径在读它」）、[[feedback-verify-facts-before-superlative-completeness-verdict]]（别在没实测每个支撑事实前下完备性结论）。
