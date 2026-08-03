---
name: methodology-relocate-invariant-when-guard-cannot-keep-up
description: "守卫被合法语法反复绕过的两次项目实例与实测证据（telemetry 抽包 6 轮、state→foundation 10 轮）——方法论已升级为 skill `reshaping-a-bypassed-guard`，本条只留事故时间线与取证"
metadata: 
  node_type: memory
  type: project
  originSessionId: 130363ec-1cbc-419f-86e5-7e19b0f46a7f
  modified: 2026-08-03T14:03:13.868Z
---

> **方法论的权威源是 skill `reshaping-a-bypassed-guard`**（停手判据、四种换轴、过近似的场景限定、接线 oracle、自验）。本条只留**项目实例与实测证据**——两处操作正文并存必然漂移，这一点在 2026-07-29 已经踩过一次（同一教训被写成三份）。

telemetry 抽包（2026-07-27）的合并态审跑了**六轮**，每轮异模型 reviewer 都用**合法且能编译的**写法绕过我刚加固的守卫。完整轨迹在 `docs/plan/monorepo-split/plan-telemetry-package.md` 与 `tests/architecture/{source-ast,telemetry-domain-surface,telemetry-startup-order}.ts` 的注释里。**可迁移的判断法已全部移入 skill**，本条只留证据。

**证据（可迁移的判断都在 skill 里，这里只记发生了什么）：**

输的模式每轮一模一样——我把检查**加深一层**（正则→更细的正则→AST 一跳→AST 两跳），reviewer 就找到第 N+1 种合法写法。两次转折点都不是「更强的守卫」，而是换轴：① barrel 从「枚举禁止导出的 operation 名」换成「枚举允许公开的精确名单」，别名/`export default`/namespace/`const` 包装/跨文件两跳一次全封死；② 启动顺序从「解析 `start.ts` 的语句顺序」换成「runtime 自己持有相位」（`markServerListening()` 未 initialize 即 fail-fast），于是「调用写反了」不再能破坏契约。

**2026-07-29 state→foundation 的第二次实例（10 轮）**：同一形状复现七次——只查 3 个文件却声称查闭包 / 把「以点开头」当「在包内」 / 只认 `StringLiteral` 却声称覆盖全部 import 形态 / 把「不可知」当「不存在」 / 只扫 `.ts` 却声称扫全树 / 按 `~/routes` 拼写判断却声称约束依赖 / 冻结 specifier 文本却声称冻结边。四次成功换轴全是「别手写、去问已经知道答案的那个东西」（`ts.resolveModuleName` / `ts.createScanner` / 守 `node:module` 能力门 / 只问目标）。**这轮最贵的教训不在守卫本身**：本条记忆当时就在上下文里，识别信号第 2 轮即全部命中，我仍补到第 7 轮——这次 miss 是把方法论升级成 skill 的直接原因，记在 `~/.claude/skills/reshaping-a-bypassed-guard/verification-log.md`。

**同轮踩到的两个自审盲区（独立价值）：**
- **注释写错 → 照着注释写的代码看起来就是对的**。我在 `unconditionalOnly` 文档里写「try/catch/finally 都不 gate 正常路径」，对 `catch` 是错的（只在抛错时跑）。于是"把生产调用从 `try` 体移进 `catch`"编译通过、正常路径永不执行、守卫全绿。**自洽且完全错**。
- **mutation 不咬 ≠ 代码没问题，也可能是 oracle 假绿**。runtime oracle 第一版用空 `:memory:` 库断言 backfill 未执行——但空库下 backfill 跑不跑**结果都一样**，去掉延迟逻辑照样绿。改成喂真实的 in-retention legacy 快照、经独立连接数 `tel_raw` 行数才有分辨力。**反过来也要诚实**：第三条 mutation（去掉延迟槽清空）不咬，因为单次吸收本就由 registry 的快照消费 + version 守卫保证——这时要改的是**测试的措辞**（别声称覆盖了那行），不是硬加断言。

**2026-07-28 印证实例（第 3 条「诚实标注」被照做了一次，并暴露它的前置条件）**：abort-provenance gap 计数只在 driver 的 `streamErrorOutcome()` 里打，守卫要证「全仓只有这一处 mint」。逐行 regex → AST，异模型 reviewer 每轮拿新的合法写法穿过去（computed `["kind"]`、指向同文件 const 的 identifier、shorthand）。这次没有继续加深：补完这三种后**在注释里点名抓不住什么**（跨模块 import 的值、函数返回值——都需要跨表达式常量求值），并把根治形状（给 variant 加只有 helper 能造的 brand）写进 backlog 带触发条件。**新增的前置条件**：写「诚实标注」时也得**先实测自己抓得住哪些**——我加固 AST 版时它对 helper 自己的 `"stream-error" as const` 统计为 0，即那一版**同样放过 `as const` 写法的绕过**，是「helper 必须恰好 mint 一次」的正样本对照抓出来的。**一个宣称覆盖面大于实际覆盖面的守卫本身就是假绿**，它诱使人说「机器会查的」。

**2026-08-03 anchor-stop 关闭权威（第三个实例，新增两条 skill 未覆盖的判断）**：同一条不变量的守卫被绕过三次，而**三次换轴全在表示层**——同行 regex（被「变量提取成两行」绕过）→ 类型能力边界（把 `writeAnchor` 从公共 `ClientSink` 移到 `OwnerRawSink`，被 `as OwnerRawSink` 绕过）→ 准备换运行期摘除（未卷入方实测判定：普通 `write` 与公开 raw factory 仍能发同字节，**必要但不闭合**）。

两条新的可迁移判断：

- **「换了几次」不是信号，「几次 witness 利用的是同一个事实」才是。** 本轮三次的共同事实是：判据观察源码拼写或 TypeScript view，而真正的违规是**绕过 owner canonical state 后仍能产生 client-visible wire effect**。识别它就能直接跳到正确归属层（owner 的 serialized command + 唯一 emission choke point），不必再试第四种。
- **推断型判据的正确升级方向不是换一种推断，是加一个独立的 intent 输入。** 被 `as` 绕过时**不要**去加「禁止 cast 到 X」——本地声明一个结构相同的 interface 再 cast 就绕开了，那仍是拼写轴。正确形状是让**调用方声明意图**、classifier 观测实际 effect，两者不一致时在首次外部写出**之前**报错；推断从唯一权威降为交叉验证的一条腿。（裁决原文：`docs/tmp/2026-08-03-m1-shape-adjudication-full-vs-a.md`。）

**这轮最贵的教训同样不在守卫本身**：轴被绕过两次后，**两次都是我自己选的下一条轴**——同一个问题、同一个裁判、连续两轮，正是第一次被绕过的成因。skill 的停手规则管住了「别再加拼写」，但没管住「谁来选新轴」。**交出去的应该是轴的选择本身**，不只是实现的验收；本轮把它交给未卷入第三方后，第一时间就被告知三条候选轴全错。用户那句「你和评审者是否都认可这是长远最佳」是转折点——在那之前我正准备第三次自己换轴。

**2026-08-03 同日续篇：同一「换轴」判断迁移到「人口枚举」上，一天内命中五次。** 上面讲守卫被绕过；下游还有一个同构问题——**要证明「某类东西已全部收口」，先得枚举出那一类东西**，而**按某一个轴枚举，落在别的轴上的成员就看不见**。五次各由不同评审、从不同角度撞到：① `noteWinner`——按「会产生 wire effect」列举，落在**观测轴**上的成员漏了；② 三个 `[DONE]` 与十个 `ClientSink.write` **是包含关系却被并列**（重复计数，核验者会去找 13 个而实际 10 个）；③ direct transport 的 **post-owner** 成员被「pre-owner 异域」的归类挡住；④ `getDownstreamDeliverySession`——**取得 session 的能力本身**，既不写 wire 也不是 session 的方法；⑤ 修法写成「枚举某两个目录的 exports」，而承重类型 `ClientSink` 声明在**目录之外**、下游只 `import type`，于是「capability 经函数签名传递」整类的根符号在根外。

**可迁移的判断**：连续多个成员从不同轴逃逸时，不要再补第 N 个类目——**先定义完整的能力面（传递闭包），再按处置切成互不相交的子集，并留一个 unclassified 失败桶**，使新增成员**自动**落进某处而不是等下一位评审发现第 N+1 个轴。判据是「新增一个 export 会不会自动变红」，不是「清单看起来全不全」。

**闭包本身也会画小、也会被自评过滤器污染**（同轮两次）：a) 闭包只**向上**推进（消费者方向）而不**向下**（成员方向），于是「只作为种子成员存在的能力」永远进不了种子——`GenerationWireIndexAllocator` 是 `GenerationWireState` 的一个属性，其工厂零参数、返回非种子，它和调用点整体逃逸；b) 我给向下方向加「该成员**能否**改变 authorization state」的语义过滤器，被判定为**把手写名单换成了手写判断**（实施者自评、无外部 oracle、判错即静默），**它连自己的 sanity 清单都过不了**——`WireBlockMapping`（成员只有两个 number 与一个看似纯变换的 `remap`）与 `LegToken`（branded string）都会被判「无能力」而排除，而它们正是 C10/C3 的授权事实。**正确形状是结构性停止**（停在原始类型、字面量、`node:` 内置、第三方类型），「我认为它无能力」降级为**入种子之后的 disposition**；理由是错误代价不对称——**过度纳入只是多几条可见的处置项，纳入不足是隐形的**。⚠️ 别漏 `any`／`unknown`：它们不在四类结构停止点里，默认停在那里就等于把 `as any` 变成绕过闭包的官方通道。

（守卫"绿"不自证）、[[tooling-eslint-no-restricted-imports-group-is-or-not-allowlist]]（同轮的 allowlist 工具坑）、[[methodology-domain-peel-execution-techniques]]（本次抽包的执行技巧）、[[methodology-exhaustive-record-proves-table-not-that-live-path-reads-it]]（守卫/穷尽性证明「表填全了」而非「活路径在读它」）、[[feedback-verify-facts-before-superlative-completeness-verdict]]（别在没实测每个支撑事实前下完备性结论）。
