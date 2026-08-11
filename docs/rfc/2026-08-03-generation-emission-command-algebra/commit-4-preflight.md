# Commit 4 前置调查（T4.0a / T4.0b）——证据槽与两个结构性障碍

**日期**：2026-08-11。**状态**：T4.0a 与 T4.0b 已取证；T4.0c／T4.0d 未做。**用途**：cutover-plan 的 Commit 4 kickoff 明写「没有 `file:line` 或 PoC 结论就停下回报，不生成猜测签名」——本文是那份证据。

**所有行号测于 `1d6906fb`**，重算命令写在各节。**计划正文里的行号全部已漂，别照抄。**

## composition 点的真实人口（T4.0a）

重算：`rg -n 'makeDeliverySseSink\(|makeDeliveryWsSink\(' src/routes/`

**8 个构造点**，与计划的 `8 + 2` 口径一致：

| # | `file:line` | vendor／transport |
|---|---|---|
| 1 | `src/routes/responses/handler-v4.ts:359` | Responses HTTP |
| 2 | `src/routes/responses/handler-v4.ts:608` | Responses HTTP（第二条路径） |
| 3 | `src/routes/chat-completions/handler-v4.ts:536` | Chat Completions |
| 4 | `src/routes/chat-completions/handler-v4.ts:776` | Chat Completions（第二条路径） |
| 5 | `src/routes/gemini/handler-v4.ts:450` | Gemini |
| 6 | `src/routes/gemini/handler-v4.ts:655` | Gemini（第二条路径） |
| 7 | `src/routes/messages/handler-v4.ts:1589` | Anthropic（在 `makeAnchoredSseSink` 内部） |
| 8 | `src/routes/responses/ws.ts:377` | Responses WS |

**2 个 Anthropic 接线点**（调用 `makeAnchoredSseSink`，**不自己构造**）：`src/routes/messages/handler-v4.ts:857` 与 `:964`。计划那句「别读成 10 个并列 root 各建一个 owner」成立——`:857`／`:964` 与 `:1589` 是同一条链的两层。

**⚠️ `messages/handler-v4.ts:1521` 不是构造点**，是 `makeAnchoredSseSink` 自己的签名行（`Parameters<typeof makeDeliverySseSink>[0]`）。按 `rg` 的裸命中数会把它算进去得到 9，那是错的。

### T4.0a 的三个问题，逐个回答

**① composition factory 是否需要 export？** **需要。** 8 个构造点分布在 5 个不同的 route 模块（`responses`／`chat-completions`／`gemini`／`messages`／`responses/ws`），没有一个共同的内层可以藏住工厂。

**② 谁拿 `GenerationDeliveryOwner<P>`、谁只拿 `CommandsFor<P>`？** composition root（上表 8 点）拿 owner——它要持有 raw emitter、terminal 状态机、心跳。**其余全部只拿 `CommandsFor<P>`**，包括两个 Anthropic 接线点：它们在 owner 下游，不构造任何东西。

**③ returned object 能否恢复 raw emitter？** **今天能，而且 production 正在用。** 这是下面第一个障碍。

## 障碍一：production 存在从 sink 反查完整 session 的 lookup

`src/routes/messages/precontent-recovery-sink-chain.ts:93` 做的正是这件事：

```ts
const deliverySession = getDownstreamDeliverySession(rawSink)
if (!deliverySession) throw new Error("[Anthropic:v4] raw delivery sink has no generation-owned session")
```

`getDownstreamDeliverySession`（`src/lib/pipeline/delivery/session.ts:120`）从 `deliveryBySink` WeakMap 反查。计划的 **T4.3 逐字要求**「不存在能从已传出的 sink／wrapper／observer 反查完整 session、allocation port 或 raw authority 的 lookup」——**这条不是形式条款，它有一个 production 消费者**。

同一个工厂还把 `rawSink` 原样返回，并产出**三个 sink 变体**（`sink` = supervisor、`rawSink`、`liveSink`），即同一条流上今天有三个写入口。

**对 Commit 4 的影响**：切换不只是「把 `sink.write` 换成 `commands.emitGeneric`」。这个反查注册表与三 sink 链要一并折叠进 owner，否则 T4.3 无法通过；而它们又恰好在 Anthropic 那条最复杂的链上。**这一项计划没有单列 task。**

## 障碍二：WS 的 close 不经过 sink（T4.0b）

`src/routes/responses/ws.ts:341` 走 `sendErrorAndClose(ws, ...)`，**直接持有 `ws` 句柄**关闭 socket，不经过 `makeDeliveryWsSink` 构造的那个 sink（`:377`）。也就是说 WS 的 close intent 今天由一个与 owner 平行的 helper 产生。

**typed operation result 现状**：sink 构造处（`:377`）拿到的是 `ws` 本身；close 的 code／reason 在 `sendErrorAndClose` 内部成形（`:138` 的 `code?: string` 参数）。**「WS close intent 产生时是否已具备 keep-open／code／reason」的答案是：code 与 reason 具备，keep-open 没有单独表达**——今天只有「发错误并关」与「不关」两种走法。

**对 Commit 4 的影响**：`TerminalEmissionResult.socketCloseIntent` 要真正承载 WS 语义，就得把 `sendErrorAndClose` 这条平行路径收进 terminal command，否则 socket 仍有第二个关闭者。

## 未做的两项

- **T4.0c**（production 双命中 mutation 的精确注入点）：属证据设施，随 Commit 0 推迟。真要做时注意计划自己写的分叉——若接线完成后该状态仍不可达，要点名是「单一拒重复 key 的 registry 从结构上消除了它」还是「witness 未触达」，前者改用 registry insert-conflict mutation，后者停下修 oracle。
- **T4.0d**（65 个 raw factory test 迁 test-only entrypoint）：与 Commit 6 的删除同期做更省，Commit 4 不依赖它成立，只依赖它**不阻塞**。

## 结论

**T4.0a／T4.0b 的证据齐了，但它们改变了 Commit 4 的形状**：除计划列出的 12 项切换外，还要折叠掉①`deliveryBySink` 反查注册表及其 production 消费者、②三 sink 链、③WS 的平行 close 路径。三者都在「唯一原子发布点、不许拆」的约束内，**必须与切换同一个 commit 完成**。

这不是「计划错了」，是计划把它们归在 T4.3／T4.11 的验收条款里而没有单列施工 task——按条款字面执行会在实施到一半时撞上。
