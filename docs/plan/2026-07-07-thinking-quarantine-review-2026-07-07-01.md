# Plan Review 报告 #01：实施计划可执行性（架构）

- 日期：2026-07-07
- 对象：[2026-07-07-thinking-quarantine.md](2026-07-07-thinking-quarantine.md)
- 裁判轴：长远正确 + 完整；亲手核对每个集成锚点真实存在且签名正确。
- 结论：**架构/三层站得住、纯函数层（Task1/5/8）算法与测试自洽且已逐个手跑验证正确；但不能按原样执行**——6 CRITICAL（引用不存在符号/错误签名/断裂接线）+ 1 HIGH（config 静默断链）。主会话已亲验 C1/C2/C3/C4/C5 全部属实。

## CRITICAL（全部亲验属实，必改）
- **C1 Task3**：`sanitizeAnthropicMessages` 返回 `{ payload:{...,messages}, blocksRemoved, stats }`（[result.ts:66-78](2026-07-07-thinking-quarantine.md)），**消息在 `.payload.messages` 无顶层 `.messages`**。计划 `finalized.messages` 编译错、`return {...finalized, messages}` 挂假顶层不更新 `.payload.messages` → 生产静默 no-op。改：`destackAdjacentThinking(finalized.payload.messages, …)` + `return {...finalized, payload:{...finalized.payload, messages: destacked.messages}, stats:{...finalized.stats, destack: destacked.stats}}`。
- **C2 Task6**：types.ts 导出 `RetryStrategy`（非 `EnvRetryStrategy`）；`RequestEnvelope` 在 `~/lib/pipeline/envelope`（非 types）。改导入：`import type { RetryStrategy as EnvRetryStrategy, RetryAction } from "~/lib/pipeline/types"` + `import type { RequestEnvelope } from "~/lib/pipeline/envelope"`。`RetryAction` `{kind:"retry",env,learning,meta}`/`{kind:"abort",error}` 对。
- **C3 Task11**：`RequestRewrite`/`RewriteResult` 在 `~/lib/pipeline/rewrite-registry`（非 types）；要求 `name`+`order:number`+`appliesTo(env):boolean`+`apply(env):RewriteResult`，`RewriteResult={env,changed,stats?}`。计划漏 `order`/`appliesTo`、`apply` 返回错。改：从 rewrite-registry 导入、补 `order:250`+`appliesTo:(env)=>env.clientFormat==="anthropic"`、命中返 `{env: env.with({body}), changed:true}` 否则 `{env, changed:false}`。
- **C4 Task11**：执行序由 `.order` 排序决定（[rewrite-registry.ts:200](2026-07-07-thinking-quarantine.md) `.sort((a,b)=>a.order-b.order)`），非数组位置；sanitize(含 L1)=`ORDER_SANITIZE=300`。故 L3 filter 须 `order<300`（取 250）。
- **C5 Task9**：`SqliteDatabase` 只有 `exec/prepare/close/transaction`；`.run/.all` 在 `prepare(sql)` 返回的 `SqliteStatement`（`.all()` 返 `Array<unknown>` 无泛型）。计划 `db.query<…>().all()`/`db.run()` 全错。改：`db.exec(DDL)` + `db.prepare(sql).run(...)` + `db.prepare(sql).all()`（返回行 cast）。
- **C6 Task9**：水合键 `char(0)`(NUL) ≠ `keyString` 的空格分隔 → 重启后 cache 键读不到 → `isPoisoned` 恒 false、跨实例测试必挂、L3 跨重启静默失效。改：水合按行 `cache.set(keyString({sessionId:row.session_id, agentId:row.agent_id}), row.last_seen_at)`。

## HIGH（config 静默断链，必改）
- **H1 Task2/6/10**：config→state 桥是 `config.ts` 的 `if (a.<key>!==undefined) setAnthropicBehavior({<stateKey>: a.<key>})`（[config.ts:525-527](2026-07-07-thinking-quarantine.md) thinking_block_message_policy 范式）。计划用「`anthropic?.X ?? default`」这一**仓库不存在的模式**、File 清单**漏 `config/config.ts`** → 键能编译默认开但**不可配**（typecheck 抓不到，纯静默）。改：三键各在 config.ts 加 apply 行 + 加进 `setAnthropicBehavior` 的 Pick 联合（state.ts:985-1014）+ 初始 state 字面量(:1482，缺则 typecheck 报) + reset 块(:1346)。

## MEDIUM
- **M1 Task6/11**：用 `env.with({body})` 而非裸展开 `{...env, body}`（envelope `.with` 是唯一不可变更新法、`.view` 是 body 变则失效的缓存投影）。
- **M2 Task3 Step4**：`buildMessageMapping` 在 `message-mapping.ts:55`（非 request-rewrite-adapter），且**消息级**匹配（role+首块），de-stack 不改消息首块 → **不扰动它** → 该步大概率是伪需求。改：确认无块级归因消费合成标记则删此步（记原因）。
- **M3**：de-stack telemetry 送不达 history（`toSanitizationInfo` [result.ts:87-97] 丢 `destack` 字段 + pipelineInfo 门禁纯插入型 0 删除不触发）。改：`insertedMarkers>0||destackedMessages>0` 时扩展 `toSanitizationInfo`+门禁或独立 feature record。
- **M4 Task9**：never-throw 测试断言矛盾——`record` 在 db try **之前**无条件 `cache.set`，故 degraded 下 `isPoisoned` 应 **true**；测试断言 false 与实现矛盾、TDD 卡。改断言为 `.toBe(true)`。
- **M5 Task7**：legacy 孪生形态 `{action:"retry", payload:{...,messages:stripAllThinking(...).messages}, meta}`、`handle(error,payload,ctx)`；legacy 无 env.ctx → L3 落库只留 v4 原生策略（合 spec「无 session→降级」）。

## LOW
- 行号锚点漂移（spec 引 strategies.ts:84 / handler-v4.ts:211 实为符号名偏移）——执行者符号名优先于行号。
- `poisoned_thinking_ttl_hours` 建议加 `nullableNumber` helper（现用裸 z.number，不阻塞）。
- move_blocks 追加空/空白 text 无害（终末 filterEmptyAnthropicTextBlocks 已先跑）。

## 已亲验「真实且用法正确」（无需改）
`env.ctx.sessionId/agentId`（request.ts:250-255 getter，string|undefined）✓；`env.body/ctx/with`（envelope.ts:95/105/108）✓；`RetryAction` 成员✓；`onResolved(env,meta)` meta 来自 budget-accepted retry、本策略成功才触发✓；`createDatabase` 导出无单例✓；v4 活路径经 `sanitizeAnthropicMessages`（payload-rewrites.ts:119）单点覆盖 driver S3 + `resanitize` 每 retry 重跑（codec.ts:322）故幂等要求成立✓；`AnthropicConfigSchema`/`nullableEnum`/`nullableBoolean`✓；`buildAnthropicStrategies` 可塞未 adapt 原生策略✓；`ContentBlockParam`/`MessageParam` 类型✓；Task1 三策略算法逐样本手跑吻合✓；store 构造收 dbPath(DI)符合隔离✓。

## 交付判定
纯函数层就绪；把 6 CRITICAL + 1 HIGH 的签名/接线修正回填 Task3/6/7/9/11 + config(2/6/10) 后即可交付执行。
