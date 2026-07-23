# 第三轮聚焦确认：`max_tokens` 续传 spec（2026-07-22-max-tokens-continuation.md）

> 确认者：Claude 驱动 reviewer（第三轮，仅核对上轮 blocker + 3 major + minor 是否真闭合，非全量重审）
> 日期：2026-07-23
> 方法：逐条对照上轮 `-rereview-claude.md` 发现 + 亲手核对 master 代码锚点

## 总体结论

**可进 plan——上轮 blocker 与 major 4 彻底闭合、major 2/3 主体决策已据实修正。但 major 2 与 major 3 各遗留一处「权威节已改、摘要/次级段落未同步」的 doc 内部矛盾（均 minor、不改变任何执行决策），建议 plan 前顺手清除以免误导。** 不阻断进入 plan（plan 首要产出 terminal ownership matrix 不受这些残留影响）。

新 blocker 数：0

---

## 代码锚点核对（本轮亲手实测，全部通过）

- `driver.ts:1366` = `const retryable = (thrown ? classifyStreamError(thrown)==="other" : true) && !committedAny` ✓（§1.3/§5.1 引用准确）
- `driver.ts:1423` = `&& !hasCompleteInteractiveToolUse(ledger.snapshot())` ✓（§5.2 B-closed/§6 ADR D3 门引用准确）
- `driver.ts:1401` = cut path continuation 注释「committedAny is TRUE here」✓（§5.1/§5.3「master continuation 仅覆盖 cut 路径」准确）
- `driver.ts:1327-1358` terminal drain：`:1336` `if (drained && (candidateOpts.sawMessageStop?.() || sawUpstreamError?.()))` ✓（§5.3 抑制点「terminal drain 前截获」准确）
- `driver.ts:1431-1436` = `ledger.snapshot() already excludes thinking (extractor) — upstream rejects thinking as a prefix (ADR D3)` ✓（§3.3/§6 thinking 无 continue 依据准确；spec 标 :1434 落在此注释块内）
- `model-operation-record.ts:246` `DispatchVerdict = ...|"continued"`、`:250` `CandidateVerdict = ...|"continued"` ✓（§5.1 major 4 依据准确、确是 named type）
- `hasCompleteInteractiveToolUse` 定义在 `committed-blocks-ledger.ts:40`、由 `driver.ts:71` import ✓
- `git grep committedBlocksLedger master -- src/` 命中 `driver.ts`/`types.ts`/`handler-v4.ts` ✓（底座确已 landed master）

---

## 逐条闭合判定

### [上轮 blocker] 续写底座已 landed master —— ✅ 彻底闭合
- §1.3:38 重写为「底座已 landed master」，列全 module + 行号（`driver.ts:1279` ledger 喂养 / `:1300` recordCommitted / `:1412-1453` 触发 / `handler-v4.ts:1219` 接线）。✓
- §5.1:130 重写为「依赖已 landed、接口已固化、直接复用」。✓
- §11:250-257 重写为「底座已 landed、P0 直接复用 ledger 无需自建、P1 依赖满足」，并诚实记录根因（并发会话在起草后 landed、ground truth 变化、复用陈旧 grep 快照的教训）。✓
- R6:290 改「已 landed master、依赖满足」+ R6' 残留风险。✓
- 无活跃「master 尚无」残留。§16:313 第一轮采纳记录仍写「master 尚无（已核实）」，但那是**历史演进叙事**、§16.1:330 已明确标注被证伪并纠正——属可接受的审查记录。**[nit]** §16:313 未就地标「后被 §16.1 证伪」，顺读 §16 者可能短暂困惑，可加一句交叉引用。

### [上轮 major 4] `continued` verdict 依赖前提 —— ✅ 彻底闭合
- §5.1:130 改「已在 master `DispatchVerdict`/`CandidateVerdict`（`model-operation-record.ts:246/250`）、named type、非 in-flight 内联联合、直接复用」。实测 246/250 确含 `continued` 且是 named type。✓

### [上轮 major 2] B-closed / thinking:"continue" 撞 ADR D3 —— ⚠️ 主体闭合，2 处摘要残留 `continue`
主体已彻底改：
- §5.2:141 B-closed 改「正常 client turn boundary、不续写」对齐 `driver.ts:1423`。✓
- §3.3:96 明确「无 `continue` 选项」+ ADR D3 依据。✓
- §6:174 config thinking 只列 `passthrough | retry_with_budget`、注明「无 continue」。✓
- §6:173 tool_use `continue` 收窄为「仅 server_tool_use/非交互工具 + PoC 门 B + ADR 修订；完整 interactive tool_use 恒不续」。✓

**残留矛盾（minor，须清）**：
- **§13:276 Q2 裁决摘要**仍写「C 类策略：多策略可配置（`passthrough` 默认 / `retry_with_budget` / `continue`）」——把 `continue` 列为 C 类有效策略，与 §3.3/§6 已删除的事实**直接矛盾**。
- **§16.1:345 用户裁决记录**同样写「Q2 C 类 → …/ `retry_with_budget` / `continue`」，同一残留。
影响：执行者读 config SSOT（§6）得正确信息，但读 Q2 摘要会误以为 C 类支持 continue。属 doc-vs-doc 内部不一致。修复：§13 Q2 + §16.1 裁决记录两处删 C 类的 `continue`（或注「thinking `continue` 因 ADR D3 已移除」）。

### [上轮 major 3] CC tool_calls 尾随约束被 G5a 证伪 —— ⚠️ 主体闭合，1 处次级段落残留旧约束
主体已吸收：
- §5.2:146 明确「CC tool_calls 尾随约束不适用（master FINDINGS G5a PASS 已证伪）… CC 续写不撞该 hazard、无需 partial-degrade fallback（推翻续写 spec §4.3 CC 行旧约束）」+ G4 index 串行。✓

**残留矛盾（minor，须清）**：
- **§8:213 Chat Completions 行**仍写「B 类 CC tool_calls 尾随约束（续写 spec §4.3）叠加本 spec B 类风险，默认透传」——把**已被 §5.2 证伪的**尾随约束当作 B 类默认透传的叠加理由，与 §5.2 自相矛盾。
影响：B 类默认透传的**结论**不变（主因是 §3.2 partial 丢弃 + 发散 hazard），但 §8 引用了自己已证伪的次要理由。修复：§8:213 CC 行删「tool_calls 尾随约束叠加」，改为「B 类风险（发散，§3.2）默认透传；CC 无 tool_calls 尾随约束（G5a）」。

---

## minor 项核对

- **删重复 Q4**：✓ 现仅 §13:278 一条 Q4。
- **行号刷新**：✓ 活跃引用 `driver.ts:1366`（committedAny）、`:1279/:1300`（ledger）均已更新准确。**[nit]** §16:309 历史采纳记录仍留 `driver.ts:1283`（第一轮当时值）——历史叙事，可保留或加注。
- **多轮 usage 单调/总和语义**：✓ §5.3:158 已补「usage 单调递增、末轮报各轮真实总和、门 D 验单调性」。

---

## 是否可进 plan

**可进 plan。** 上轮 blocker（底座 landed）+ major 4（continued verdict）彻底闭合；major 2（ADR D3）+ major 3（CC G5a）的**权威节（§3.3/§5.2/§6）已据实修正**，执行决策正确。仅剩 3 处非阻断的 doc 内部一致性残留：

1. [minor] §13:276 Q2 + §16.1:345 裁决记录 —— 删 C 类残留的 `continue`（对齐 §3.3/§6）。
2. [minor] §8:213 CC 行 —— 删已被 G5a 证伪的 tool_calls 尾随约束引用（对齐 §5.2）。
3. [nit] §16:309/313 历史采纳记录留旧行号 `:1283` + 旧结论「master 尚无」未就地交叉引用后续纠正 —— 可加注。

这三处均为「摘要/次级/历史段落未随权威节同步」的对账遗漏（正是本项目强调的 doc-vs-doc 对账类缺陷），建议 plan 启动前顺手清除，但**不阻断**——plan 首要产出（§5.3 terminal ownership matrix）与 P0 识别观测 / P1 Anthropic direct A 类续写均不依赖这些残留。

设计内核（三分型策略、transparent-stitch 默认 + 后端忠实双轨、visibility×class 组合矩阵、独立预算、terminal ownership matrix、PoC 门分档）经三轮迭代已扎实，认可。
