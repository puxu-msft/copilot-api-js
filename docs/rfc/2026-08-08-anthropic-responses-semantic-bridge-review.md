# Anthropic ↔ Responses semantic bridge RFC 评审记录

> 评审对象：[`2026-08-08-anthropic-responses-semantic-bridge.md`](2026-08-08-anthropic-responses-semantic-bridge.md)、[`2026-08-08 protocol-neutral reasoning exchange ADR`](../decisions/2026-08-08-protocol-neutral-reasoning-exchange.md)
> 第1轮基线：`78b5a97d`
> 第1轮后先行修订：`fb20919a`、`b6cbced2`
> 状态：第1轮已处置，待原 reviewers 复评

本文件转录并处置第1轮三名独立 reviewer 的返回结果。首轮报告没有写入仓库，以下按原评审分组保留 finding，而不是把重叠项去重；这样每名 reviewer 的复评范围都可逐条追溯。技术设计裁决均为 C 级可逆产物决策。实施授权冲突涉及用户已裁决事项，按 A 级“适用性明确且本次裁定是遵从既有决定”分支直接同步，不重新询问。

## 第1轮处置

### A．协议状态机与 wire 语义

| ID | 原严重级别 | Finding | 处置 | 落点 |
|---|---|---|---|---|
| P1 | BLOCKER | ledger 无法表达 Responses nested lifecycle：缺 content／summary index、part declare／done、reasoning content track 与 authoritative done。 | 采纳（C）。加入 `PartKey`、`PartKind`、`PartState` 与 declare／delta／done；part `.done` text 为权威值，item 完成不得替代 nested part 完成。 | RFC §4、§11 C1 |
| P2 | BLOCKER | function／server-tool 终态数据不足，declare 缺 name／callId，result variant 不完整。 | 采纳（C）。`b6cbced2` 先补 function-result／server-tool-result；本轮再加入 declare-time `CallMetadata`，缺 name／callId 的 call 不进入 emitter。 | RFC §4 |
| P3 | MAJOR | 缺 response-level terminal：completed／incomplete／failed／cancelled、reason、usage、error 与 EOF／abort provenance。 | 采纳（C）。新增 `ResponseTerminal`，规定每个 candidate 恰有一个 response terminal，且 emitter 不得把非成功终态改成 completed。 | RFC §4、§11 C0/C1 |
| P4 | MAJOR | partial 只存在 Reasoning Exchange Envelope，普通 text／function item 无法表达 partial。 | 采纳（C）。`TerminalKind` 适用于所有 item 与 part；reasoning carrier 的 `boundary.partial`只作为统一 item terminal 的序列化投影，没有独立 setter。ADR 同步修订。 | RFC §4、§6.1；ADR §2 |
| P5 | MAJOR | reasoning visible 有 `summaryParts` 与 final envelope `visible` 两个 owner。 | 采纳（C）。parts authoritative text 加 `reasoningVisibleKind` 是唯一可写 owner；终结时才派生 envelope visible。 | RFC §4 |
| P6 | MAJOR | Carrier v2 的 `opaque:string` 无内部 discriminant，prefix／source protocol／opaque kind 一致性未冻结。 | 采纳（C）。加入 `kind`，decoder 联合校验 wire prefix、kind 与 source protocol，任一不一致 fail-closed。 | RFC §6.1 |

### B．架构、candidate lineage 与 cutover

| ID | 原严重级别 | Finding | 处置 | 落点 |
|---|---|---|---|---|
| A1 | BLOCKER | DAG 在 C5/C6 cutover 后才做 ordered-turn、server-tool、capability policy 与 carrier v2，切换会丢既有或目标行为。 | 采纳（C）。重排为 C4–C7 先闭合全部领域语义，C8 全 cell shadow parity，C9/C10 才切 production authority。 | RFC §11.2 |
| A2 | BLOCKER | C5 stream 与 C6 non-stream 分开切换，违反“一个方向原子替换 stream/non-stream 全部 cells”。 | 采纳（C）。C1–C8 均不切 production writer；C9、C10 分别在一个语义 commit 内覆盖单方向 HTTP／WS、stream／non-stream、terminal、usage 与 History。 | RFC §11.2 C8–C10 |
| A3 | MAJOR | retry／hedge／fallback lineage 不完整：winner commit point、loser discard、partial 已发状态、retry 从何处 fork 均未定义。 | 采纳（C）。新增 config snapshot、candidate／dispatch／segment lineage，冻结首次不可逆客户端 emission 为 winner commit point，区分 pre-commit retry 与 post-commit continuation。 | RFC §6、§11 C2 |
| A4 | MAJOR | 缺通用 partial terminal。 | 采纳（C）。与 P4 同一根因，但保留独立评审项；所有 item／part 使用统一 `TerminalKind`。 | RFC §4 |
| A5 | MAJOR | reasoning visible 双 owner。 | 采纳（C）。与 P5 同一根因；parts 是唯一可写 owner，envelope 是终态派生值。 | RFC §4 |
| A6 | MAJOR | Observation 缺 candidate／winner／sink-commit 阶段，shadow 或 loser 可能写入 History actual effect。 | 采纳（C）。加入 proposed→winner-committed→sink-emitted 单向阶段；loser／shadow 永远停在 proposed，actual 只收 winner。 | RFC §10 |
| A7 | MAJOR | config snapshot 应在 ingress 捕获一次；每 candidate 只按 final route 从同一 snapshot 解析 policy。 | 采纳（C）。ingress 在任何分叉前捕获 immutable snapshot；所有后代共享 snapshot identity，candidate final route 后解析一次 policy。 | RFC §3.1、§6、§11 C2 |
| A8 | MAJOR | carrier 比较不能只看 model，必须使用 protocol／provider／resolved model 组成的规范化 `ModelIdentity`。 | 采纳（C）。source 与 target 均改用完整 `ModelIdentity`；三维全部相同才 preserve v2 opaque。 | RFC §4、§6、§6.1 |

### C．决策、配置与公共文档

| ID | 原严重级别 | Finding | 处置 | 落点 |
|---|---|---|---|---|
| D1 | BLOCKER | ADR 说“不自动启动代码执行”，RFC 说 plan 后无需再问，二者冲突。 | 采纳（A，遵从既有裁决）。文档自身不构成一般授权；用户在 2026-08-08 本轮已另行明确授权协调实施，因此 plan 定稿后不重复询问。新公共契约分叉、范围变化或不可逆动作仍另行裁决。 | ADR“实施边界”；RFC §16 |
| D2 | MAJOR | 非法 policy 叶子不能 warn-continue 后静默回落默认；v2 policy rule 必须原子。 | 采纳（C）。任一非法／未知／冲突字段使整条 rule 不进入 resolver；服务可继续使用其他有效 rule，但匹配失效 rule 的请求返回 typed config error。 | RFC §6.2、§11 C6 |
| D3 | MAJOR | `safe-stable-stringify` 有损容错，不能直接承担 canonical validator。 | 采纳（C）。`fb20919a` 已要求先用严格递归 JSON-domain validator 拒绝非有限数、undefined、function、symbol、bigint 与 cycle，再只借用 stable key ordering。 | RFC §6.1、§8.1 |
| D4 | MAJOR | History 公共 projection shape 未冻结：缺双向 versioned path、policy snapshot、observation stage、缺失语义与 opaque hash 算法；API 文档同步不能等 C11。 | 采纳（C）。冻结 `pipelineInfo.translation.semanticBridgeV2`、actual/candidate 分层、字段缺失语义、域分离 SHA-256、详情／WS／summary 表面；公共 docs 前移到 C3。 | RFC §10.1、§11 C3 |

## 第1轮后自我证伪修正

1. RFC 初写的 History detail 路径为不存在的 `/api/history/:id`。对照 `docs/history.md` 与 `docs/API.md` 后修为实际公共端点 `GET /history/api/entries/:id`。
2. `boundary.partial` 若不说明派生关系，仍可能成为 reasoning 专属第二状态源。RFC 已明确它只能从父 `SemanticItem.terminal` 序列化／恢复。
3. 原 DAG 的章节文字与图互相冲突：文字要求按方向原子切换，图却按 stream/non-stream 分开。现由 C9／C10 两个方向性 cutover 作为唯一 production authority 切换点。

## 复评门

原三名 reviewer 逐条复核自己分组内的 finding，并检查本轮修订是否引入同类新缺陷。若只剩 minor，须明确给出“可定稿”；任何未关闭 blocker／major 都进入下一轮处置与复评。复评还必须覆盖以下当前状态命题：

1. RFC 中所有会影响 production 语义的能力都在 C9／C10 cutover 前完成并进入 C8 全 cell shadow parity。
2. 单一方向的 production cutover 不再拆分 stream/non-stream 或 HTTP/WS。
3. nested part、item terminal 与 response terminal 三层状态互不替代。
4. loser／shadow observation 不会进入请求级 actual History 或 WARN。
5. 所有 candidate 从同一 ingress config snapshot 解析 policy，v2 opaque 比较使用完整 `ModelIdentity`。
6. 非法 v2 policy rule 整条失效，不会删除坏叶子后静默使用默认值。
7. History v2 投影在 C3 定义、持久化、API readback 并同步公共文档，且不复制 opaque bytes。
8. ADR 与 RFC 对本轮实施授权的描述一致。
