# Mandatory block delivery 与 HTTP/2 终止观测规格评审——实施者走查

> 状态：第一轮发现已全部采纳并整改，待原 reviewer 复审
>
> reviewer：独立异模型实施者视角 reviewer
>
> 评审基线：`2bd0b83d88d67f67a315bfc1ba331c75c28b9cff`
>
> 原始报告由 reviewer 通过工具返回；本文件逐条转录其 finding，供多轮处置保留。Reviewer 未修改仓库。

## Gate

Reviewer 在隔离 worktree detached 到固定提交，核验 `pwd`、top-level、HEAD 与干净状态。它沿 candidate／processor／sink、dispatch／transport、RequestContext／History、全部 route pump、config 和测试脚本做了只读走查，未运行测试。

## 第一轮 verdict

`0 blocker / 5 major`，修复 major 后可定稿。Reviewer 原摘要写“major 数量 4”，但正文实际列出 5 条；以逐条正文为准。

## Findings

### I1 · Major：缺少协议 adapter 契约

规格只列出 `CompleteClientUnit`、`ClientTerminal`、`ClientProtocolError`，没有定义 protocol adapter 如何识别 unit、生成合法 error／terminal／`[DONE]`、获得 control capability 或处理 terminal 后帧。现有 driver 直接写 frame，CC route 自行写 `[DONE]`。实施者可能让 owner import route codec，或保留 route terminal 直写，两者都破坏唯一 owner。

Reviewer 建议冻结 `DeliveryProtocolAdapter` 的 classification、terminal rendering、control capability 与 post-terminal 契约，并逐协议列出映射。

### I2 · Major：evidence bytes lease 没有所有权转交通道

`EvidenceCapture` 只有 digest，dispatch-scoped termination API 也只接 snapshot；“immutable bytes handle”只在说明文字出现，没有 acquire／handoff／release API。现有 transport options 只传 signal／forceHttp，V3 writer 只能写 `PreparedOperation.objects`。实施者可能过早释放 bytes，或只持 digest，导致 journal reference 没有实体。

Reviewer 建议把 opaque evidence lease 纳入 dispatch-scoped capability，明确 acquire→事务 A commit／rollback→release 的唯一 owner。

### I3 · Major：V3 format version 与旧 journal 兼容未定义

两事务设计只覆盖新写和崩溃点，没有规定旧 manifest／旧 self-contained journal 的 format-version、hydrate 兼容与升级。现有 V3 store 有 schema version、manifest format gate，旧 journal 假定 payload 自足。实施者可能直接改变 journal／manifest，令升级前遗留 journal 无法恢复，或让旧 operation hydrate 假红。

Reviewer 建议把 evidence refs 设计为可选版本化字段，明确 schema／format bump、旧 journal recovery 分支和升级 fixture。

### I4 · Major：production pump 集合未冻结

“所有 production route”没有清单或 production graph root。现有 sink 调用散布在 Responses HTTP 两条腿、Messages direct／translate、CC direct／reverse、Gemini direct／reverse 与 Responses WS。实施者可能只迁常规 HTTP route，漏 reverse、error path 或 WS fallback，局部测试仍全绿。

Reviewer 建议列出每个 pump、目标 grammar 粒度、owner entry 和对应测试；AST guard 对冻结集合判定，而不是模糊的“production”。

### I5 · Major：Node／性能验证没有可执行 harness

规格要求 Bun／Node 同矩阵和 A/A、A/B、三种变异，但没定义命令、harness、baseline selector、结果格式或 CI 落点；当前 package scripts 都由 Bun 驱动，也没有 benchmark harness。实施者可能把 Bun fixture 当 Node oracle，或只 benchmark callback 而非 session→stream→consumer 全链。

Reviewer 建议明确 Node 真 `node:http2` runner、Bun／Node 统一结果格式、A/A+A/B version switch，以及在同一端到端 harness 注入三种变异。

## 主会话处置表

| Finding | 级别 | 处置 | 证据／整改 |
|---|---|---|---|
| I1 | C | 采纳 | 现有 driver 丢弃上游 `[DONE]`，CC route 在 `src/routes/chat-completions/handler-v4.ts` 自行写 terminal。Spec §4.2～§4.4 已冻结 `DeliveryProtocolAdapter`、frame ownership、逐协议 terminal／error／`[DONE]` 与 post-terminal 契约。 |
| I2 | C | 采纳 | Canonical recorder 只返回 inert `ModelOperationRecord`，V3 prepare 只接 record。Spec §5.4～§5.5 已冻结 content-addressed registry、operation ref、`OperationPersistenceEnvelope`、terminal seal→enqueue 接管与所有失败／shutdown 释放路径。 |
| I3 | C | 采纳 | 当前 `SCHEMA_VERSION="5"`、`FORMAT_VERSION=2`，journal 无格式字段且 recovery 假定 self-contained record。Spec §6.3 冻结 schema 6／manifest 3／journal 2，以及旧 manifest v1/v2、pending journal v1、readonly/search/summary 兼容 fixture。 |
| I4 | C | 采纳 | `rg` 文本枚举与 TypeScript compiler AST 两种原理交叉确认 5 个流式 exported root 下有 9 个 sink-owning pump，且存在同名 symbols；AST 另见 Gemini 非流式 `handleGenerateContentV4`，按集合边界正确排除。Spec §4.7 以 path-qualified symbol 冻结全集与“可达 owner／不可达底层 writer”双向守卫。 |
| I5 | C | 采纳 | `package.json` 仅有 Bun backend test scripts，无 Node matrix runner／端到端 benchmark runner。Spec §8.3 冻结真实 `node:http2` fixture、同 bundle Bun／Node 执行、runtime identity gate、A/A+A/B selector、JSONL schema 与四个独立 mutation。 |

整改自审另外抓到并修复：`response-terminal` 未携带 response-level buffered frames、旧 GOAWAY 字段名残留、旧评审结论冒充当前状态、裸 symbol 名歧义、session 退役早于 History acquire 时可能丢 evidence bytes 的生命周期空窗，以及错误释放 loser dispatch evidence 会违反 richest-data-flow／canonical diagnostic History 的冲突。
