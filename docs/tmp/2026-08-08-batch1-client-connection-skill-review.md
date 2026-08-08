# Batch 1：`debugging-claude-client-connection` skill 评审

## 结论

- **评审范围**：全文评审 `/home/xp/src/copilot-api-js/.claude/skills/debugging-claude-client-connection/SKILL.md`，并对照 `/home/xp/.claude/jobs/5cbe8f72/tmp/batch1-diff.md`、当前配置、实现及 git 历史；只评 blocker/major。
- **已读取／执行的证据**：全文与 diff；`config.yaml:209-246,729-756`；`src/lib/config/config.ts:1185-1207`；`src/routes/messages/handler-v4.ts:1003-1023`；`src/routes/messages/owner-failure-settlement.ts:4-23`；`src/lib/error/forward.ts:545-571`；`src/lib/transport/upstream-fetch.ts:98-108`；`packages/foundation/src/state-defaults.ts:120-123,247-258`；`git log -S`／`git show` 核验 20→180 与超时世代；`git diff --check` 通过。
- **总体 verdict**：修复 major 后可进入下一阶段。
- **blocker 数量**：0。另有 2 major。

## C1–C9 核验

| 断言 | 结论与证据 |
|---|---|
| C1 | **确认**。`config.yaml:216,220,224,234,240,246` 分别为四个 `0` 与两张空表。 |
| C2 | **确认但需收窄**。`src/lib/config/config.ts:1187-1207` 只在首次 apply 或配置 mtime 真变化时，汇总所有正标量／正 override 并发一次 `[config] bounded-wait override enabled...`；不是每请求告警。skill 未声称“每请求”，目前不构成误导。 |
| C3 | **确认（普通终端写路径）**。`handler-v4.ts:1005,1016,1020-1021` 为 close → synthetic write → snapshot → settle，`1019-1022` 的 `finally` 保证 settle；`1006-1015` 另有 owner-decision 分支，skill 随后已限定。 |
| C4 | **确认**。`owner-failure-settlement.ts:13-21` 先 `recordForwarded()`，再按 decision 调 `abort`／`fail`；该 helper 不写终端帧，因此 skill 的“只保证后半段同序”限定准确。 |
| C5 | **确认**。`forward.ts:557-570` 的有序前两臂正是 inbound client signal aborted→499、`error.name === "TimeoutError"`→504；机制描述一致。 |
| C6 | **确认**。`config.yaml:733` 为 180；`git show 5dd7bdeb^:config.yaml` 为 20、该提交后为 180，因此“此前为 20”已由仓库历史证实。 |
| C7 | **确认**。全文无把 600／1200 写成当前 shipped 默认的断言；`SKILL.md:76` 明确限定为 2026-08-08 之前的历史世代。 |
| C8 | **部分确认**。frontmatter `name` 与目录一致；description 的 bare ping／条件式 escalation 表述与机制一致，但正文另有当前 bundled 默认错误，见 M1。 |
| C9 | **确认**。三层 timeout、SDK `event:`、200+SSE-error 零重试仍完整保留于 `SKILL.md:14-28,91-101`；新增 owner 文字仅用于 C4 的顺序限定，未展开 evaluator 或 precontent-recovery 机制。 |

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/debugging-claude-client-connection/SKILL.md:87` — 把 `stream_keepalive_escalate_sec` 写成“默认 200s”，但当前 bundled 配置是 `0`，即默认禁用 escalation — `/home/xp/src/copilot-api-js/config.yaml:744-746` 明确 `0 disables` 且值为 `0`；`200` 只在 `/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:121` 作为更低优先级代码 fallback。未来会话会因此错误期待默认在 200s 发空 delta。修为“当前 bundled 默认 0；生效值为正时才在该阈值升级”，若保留 200 必须标成 code fallback。

[major] `/home/xp/src/copilot-api-js/.claude/skills/debugging-claude-client-connection/SKILL.md:74-76` — “必须取生效值／进程持有值／事故世代”没有绑定可执行 oracle，且旧事故的四项值并不都可从 History 恢复，门可被“我记得当时默认值”合理化绕过 — 当前进程值可由 `GET /api/config`（实现 `/home/xp/src/copilot-api-js/src/routes/config/route.ts:51-59,89-91,191-210`）读取；History 只持久化 `pipelineInfo.responseHeaderTimeoutMs`／`streamIdleTimeoutMs`（`/home/xp/src/copilot-api-js/src/lib/history/types.ts:230-233`），不含 stale/request deadline 的事故时快照。修复建议：明确当前值的命令／字段；旧记录优先读这两个 pipelineInfo 字段；缺事故世代证据时必须标“阈值归因未决”，禁止由 duration 反推配置。

## 判据可执行性与结构检查

- `durationMs` ⚠ 块：方向正确，但因 M2 尚不能机械判定是否遵守；补上“证据字段或未决”门后才可执行。
- 历史世代块：能拒绝拿当前值套旧记录，但目前不能证明旧值；同样由 M2 修复。
- 结构怪味：`SKILL.md:87` 属“bundled 默认与 code fallback 双源混称”；`SKILL.md:74-76` 属“证据门无可达 oracle”。均建议本轮修，不进 backlog，因为直接影响本轮中心判据。
- 最佳路径反思：项目内已有 `/api/config` 与 History `pipelineInfo`，无需新证明基础设施；双向判别应是“有进程／事故证据才允许命中阈值、无证据保持未决”；此处为项目私有诊断契约，无成熟第三方方案可替代。


## 复评轮

- **复评范围**：仅复核上一轮 M1／M2 的闭合情况、三处修复 diff 及其指定相邻契约。
- **已读取／执行的证据**：`batch1-fix-diff.md` 与 skill 全文；逐行复核 `src/routes/index.ts:78`、`src/routes/config/route.ts:51-59,89-91,191-210`、`src/lib/history/types.ts:217-241`、`packages/foundation/src/state-defaults.ts:120-123`；全仓枚举 `setStreamTimeouts`／六类配置字段的 History 生产与投影路径；`git diff --check` 通过。
- **总体 verdict**：修复 major 后可定稿。
- **blocker 数量**：0。另有 2 major。

### 原 finding 闭合情况

- **M1 已闭合**：`SKILL.md:97` 已正确区分 bundled 生效值与低优先级 code fallback，并把 `0` 的行为写成“不武装”；原先“默认 200s”误导路径不再成立。
- **M2 尚未闭合**：新增 oracle 表具备机械门的形状，但表内两项事实与真实持久化接线不符，见下列发现。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/debugging-claude-client-connection/SKILL.md:81` — 表称事故 entry 可从 `pipelineInfo.responseHeaderTimeoutMs` 取得 header 阈值，但该字段当前没有生产写点 — 全仓 `setStreamTimeouts(...)` 的生产调用只写 `streamIdleTimeoutMs`（如 `/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:811,1155`）；`responseHeaderTimeoutMs` 只出现在类型与内部变量中。故 header-timeout 事故按表会寻找一个实际不会落盘的值。修复方应补真实生产接线，或把该字段从现行 oracle 中撤下并明确未接线。

[major] `/home/xp/src/copilot-api-js/.claude/skills/debugging-claude-client-connection/SKILL.md:81` — “`stale_request_max_age`／`request_deadline` 的事故时快照根本不在 History 里”过强且会漏掉现有可用证据 — reaper 与 deadline 产生点分别把实际秒数写入 Error message（`/home/xp/src/copilot-api-js/src/lib/context/manager.ts:329,440`）；`ctx.fail` 保留该 message（`/home/xp/src/copilot-api-js/src/lib/context/request.ts:1824,1881`），V3 再投影到 `_index.derived.failureReason`（`/home/xp/src/copilot-api-js/src/lib/history/v3/projection.ts:437`）。它们不是结构化 snapshot 字段，但对这两条具名终止路径确实是事故时阈值证据。修为“无结构化字段；若 failureReason 命中具名 producer，可取其嵌入值，否则未决”。

### 相邻契约

- `GET /api/config` 与 `config.yaml` 的“运行态值 vs 声明值”区分准确；路由挂载和 `buildEffectiveConfig()` 引用均存在。
- `streamCommitAfterSec`／`streamKeepalivePingSec` 不在 `pipelineInfo` 的新增限定经全仓字段枚举确认，未与客户端侧 300s／600s 实测事实混淆。
- 结构怪味处置：新表仍存在“类型声明被当成活生产接线”的证据层错位，本轮必须修；无需引入新基础设施，优先复用现有 terminal error provenance。


## 第三轮复评

- **复评范围**：仅复核第二轮 M1／M2、新 oracle 表及 `/home/xp/src/copilot-api-js/docs/todo/deferred-backlog.md` 新登记项。
- **已读取／执行的证据**：逐项核对 `context/types.ts:538`、`context/request.ts:1304-1307`、六处生产调用、`tests/context/request-context.unit.test.ts:1222-1227`、`manager.ts:329,440`、`projection.ts:437`、`transport/send.ts:222`、`anthropic/client.ts:164`；全生产树搜索 `responseHeaderTimeoutMs:` 与 `setStreamTimeouts(`；逐调用点确认 `resolvedName`／`resolvedModel` 可传 resolver。
- **总体 verdict**：可定稿。
- **blocker 数量**：0；major 数量：0。

### 复评结论

- **M1 已闭合**：当前生产树中，写入 RequestContext 的唯一入口是 `setStreamTimeouts`；六处调用均只传 `streamIdleTimeoutMs`，`responseHeaderTimeoutMs` 的唯一 Context 写入样本确为单测 `request-context.unit.test.ts:1225`。新表没有再把类型声明误作活接线。
- **M2 已闭合**：`streamIdleTimeoutMs` 的结构化路径、reaper／deadline 文案路径及取不到即“未决”的门均与当前实现一致；两条文案分别在 `manager.ts:329,440` 产生，经 `ctx.fail` 的 terminal error 投影至 `projection.ts:437`，且限定为仅命中具名 producer 时可用。
- **backlog 准确**：六处均持有 resolver 所需的 canonical model 名（五处 `resolvedName`、WS 一处 `resolvedModel`）；`resolveResponseHeaderTimeoutMs` 已在 `send.ts:222`／`anthropic/client.ts:164` 按 model 使用；`setStreamTimeouts` 在 `request.ts:1307` 为对象 merge，单测 `:1222-1227` 证两次 patch 累加。resolver 对 per-model override 优先及 `0` 禁用返回 `0`，而 merge 不丢 `0`，故“忠实落盘”约束成立。
- **未发现 blocker 或 major**。本轮指定范围内，正确状态可按四行表取证，缺证据状态也会被机械判为未决；未再发现可让旧默认值绕过的路径。
