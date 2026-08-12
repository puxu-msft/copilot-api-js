# RequestEnvelope 三作用域 + 可变化（2026-08-11 落地）

本目录记录一次破坏性重构：`RequestEnvelope` 从**扁平字段 + copy-on-write** 改成**三个生命期作用域 + 就地可变**。

**当前形状的权威在代码与 DESIGN，不在本文**：
- 类型与逐字段 docstring → `src/lib/pipeline/envelope.ts`
- 活的架构现状（判别器、稳定态归属、归属文件表）→ [../DESIGN.md](../DESIGN.md)「活的架构现状」与「类型架构」节

本文只回答后来者最可能问的三件事：**它现在长什么样、为什么这么改、改之后有哪些坑**。

## 一、现在长什么样

三个作用域按**生命期**切分，各自回答一个不同的问题：

| 作用域 | 生命期 | 装什么 | 跨候选行为 |
|---|---|---|---|
| `request` | 整个客户端请求 | 请求级纯值：`clientFormat`／`model`／`stream`／`truncateBaseline`／`clientAnthropicBeta`／`clientRequestHeaders`／`preprocessInfo`／`sourceToolNameMapper`／`legSupplyReady` 等 | **按引用共享**——一个对象，写它每个兄弟候选都看得见（gemini 的 S1b 迟到写入正需要这个） |
| `candidate` | 一个生成候选 | 不透明可变持有者：`betaProbe`／`resanitize`／`reverseMapperHolder`／`responsesFallbackScratch` | **逐候选重建**——`CandidateStateFactory` 为每个候选新建，绝不共享 |
| `attempt` | 下一次派发 | `body`／`targetEndpoint`／`prepareHints` | **逐候选深拷贝**——fork 时 `structuredClone`，兄弟之间互不可见 |

三个 API：`makeEnvelope`（S1 出生）、`forkEnvelope`（候选分叉，共享 `request`、换 `candidate`+`attempt`）、`writeAttempt`（写下次派发的输入）。

**`view` 是 getter**，每次从当前 `attempt.body` 重新派生——所以裸 `{...env}` 展开会把它固化成快照，且副本不再共享作用域对象。要写就走 `writeAttempt`。

## 二、为什么改（用户裁决）

原设计是不可变的：`with(patch)` 返回新 envelope。用户在引入 hook 机制时明确要求**这些上下文对象不要是不可变的**，并给了两条裁决：

> 用户不需要过于强大的安全保护，当 hook 写错，就应该错误继续、系统异常。
> 核心系统应该相信 hook 知道自己在做什么。

据此一并移除的还有 `client.inbound` 的**防御性 body 克隆**与「不可变返回契约」。移除之所以安全，理由**不在**那个克隆，而在四个 codec 的 `parse` 各自对客户端原样 payload 做 `structuredClone`——客户端原样轨的独立性与 hook 行为无关。遗留缺口：将来新增 codec 若忘了 clone，没有 driver 兜底了。

对 hook / rewrite 作者的直接后果：**`writeAttempt` 返回的是同一个 env 对象**。就地改 `env.attempt.body` 后返回 `undefined`，与用 `writeAttempt` 返回 env，两种写法都成立、都到得了 wire（`tests/pipeline/hooks/client-inbound.unit.test.ts`）。**不要持有改写前的 env 引用并指望它还是旧 body。**

## 三、改之后的坑（都是实际踩过的）

1. **同一行克隆的兄弟字段会被漏掉。** `forkEnv` 在一行里克隆 `body` 与 `prepareHints`；第一版只给 `body` 补了守卫，把 `prepareHints` 改成共享后 92 条测试全绿。两个字段现在都有真实 hedge 路径的身份 + 行为断言。
2. **cell-fork 判别器换了。** 从「`requestState` 存在与否」改成显式 `request.legSupplyReady`——拿数据袋的存在性当能力判据，会把「真跑过一次 parse」和「那次 parse 恰好有东西可放」混为一谈。
3. **清扫残留时，一个关键词扫不干净一个概念。** 这次概念有四个称呼（`requestState`／`with()`／「immutable」／「defensive clone」），只扫第一个导致漏改面向作者的契约文档与**可加载的示例** `hooks/strip-todowrite.ts`。方法论已固化 → `docs/memory/methodology-sweep-a-concepts-whole-vocabulary-not-one-keyword.md`。

## 四、目录内容

- [review-dispositions.md](review-dispositions.md) —— **三轮共 18 条评审发现的处置记录**（含级别、理由、证据、提交号），零未采纳。为什么某条守卫改成行为 oracle 而非扩大字符串黑名单、为什么某条环境归因被降级为「先后与共变而非因果」，都在这里。
- `archive-2026-08-11/` —— 九份评审报告原文，按轮次与角度命名。留档理由：处置表只写结论与依据，报告里有各评审自己跑的变异实验、扫描范围与判据；日后怀疑某条结论时可回到原始证据。

## 五、已知遗留

- `docs/v4/03-spec/envelope-driver.md` §1 描述的是**改动前**的扁平形状，已加取代横幅但正文未重写（其余章节未受影响）。
- `docs/spec/2026-07-26-server-tool-provenance-routing.md` 的载体分析引用了已删的 `snapshotStableState` 与 `with()`；该 spec **待用户裁决是否起实施**，故只标注前提失效、未改其论证与结论。
- `tests/history/v3/migrations-wiring.it.test.ts` 单跑必挂（分片跑才绿）——**与本重构无关**，A/B 已证先于它存在，登记在 [../todo/deferred-backlog.md](../todo/deferred-backlog.md)。
