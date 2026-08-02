# 对抗评审报告合集：server-tool provenance routing spec v2

评审对象：[2026-07-26-server-tool-provenance-routing.md](2026-07-26-server-tool-provenance-routing.md)
评审者：`gpt-souls:reviewer`（GPT 底座，异模型对抗；同一实例经 SendMessage 续跑五轮，上下文连续）
日期：2026-07-29　　裁判轴：长远正确 + 完整优先，禁止以 ROI/YAGNI 否决正确方案

逐条处置（采纳/驳回 + 理由 + 级别）见 spec 的 §0.1–§0.4 处置表，本文件只存**评审方原文**，不复述处置。

| 轮次 | blocker | major | verdict |
|---|---|---|---|
| 1 | 0 | 5 | 修复 major 后可进入下一阶段 |
| 2 | 0 | 3 | 同上（两处争议：接受我对 M3 因果链的修正，驳回我对 M1 的驳回） |
| 3 | 0 | 3 | 同上 |
| 4 | 0 | 2 | 同上（裁决接受「本 spec 不扩展核心 rewrite timer 契约」的边界） |
| 5 | 0 | 0 | **可以定稿** |


---

## 【第 1 轮】评审报告：server-tool provenance routing spec v2

## 评审范围

评审对象：`/home/xp/src/copilot-api-js/docs/spec/2026-07-26-server-tool-provenance-routing.md`。

背景材料：`/home/xp/src/copilot-api-js/docs/plan/2026-07-27-handover-server-tool-provenance.md`、`/home/xp/src/copilot-api-js/docs/spec/2026-07-26-thinking-terminal-block-layout.md`、`/home/xp/src/copilot-api-js/docs/decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md`。按用户要求，§2 的既决取舍与 §3 的范围收窄不重开。

## 已读取／执行的证据

- 逐条读取并核对 spec 的 C1–C12；用 `rg` 枚举相关生产消费者、测试消费者、retry matcher、synthetic kind union 与实施影响面。
- 读取本地 `@anthropic-ai/sdk` 类型真相：`/home/xp/src/copilot-api-js/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`，重点核对 `ContentBlock`、`ServerToolUseBlock`、caller union、全部 6 类 `*_tool_result` 及 typed tool 声明。
- 用只读脚本解析 spec 全部 Markdown 链接并验证目标文件存在、`#L` 行号不越界；没有启动服务器，没有修改仓库，没有执行 Git 写操作。
- 关键确认：C1、C2、C3、C4、C5、C7、C8、C9、C10 基本属实；C6 的 SDK 穷尽表属实；C12 的链接目标与行号均真实存在。C11 不成立，见 M4。

## 总体 verdict

**修复 major 后可进入下一阶段。** blocker 数量：**0**。major 数量：**5**。

## 事实性发现

### M1／major／§4.3、§6.2–§6.5

**问题：provenance graph 的规范没有定义 forward reference 与环，按当前逐事件算法会把可证明为 client-declared 的嵌套调用永久误降级。**

**证据：** SDK 明确允许 `caller:{type:"code_execution_20250825"|"code_execution_20260120",tool_id}`（`messages.d.ts:984-990,1002-1009`），而 spec 只写 `invocationById`“在流内按 start 建立”并在 `content_block_start` 当场分类（spec §4.3、§6.3）。若 child start 先于 parent start，`caller.tool_id` 此刻不存在，会命中 §4.4“父 invocation 不在本响应内→降级”；后到 parent 无法纠正已经 suppress 的 child。重复 ID 与 `A→B→A` caller 环也不在五条 fallback 或七条边界中，递归定义可能不终止或依赖实现偶然行为。

**建议方向：** provenance 解析必须显式支持 `unresolved`，至少缓冲待父调用解析的整块，直到父出现或流结束；定义重复 ID、self-cycle、multi-node cycle、parent-later、parent-never-arrives 的确定动作。若选择“父尚未出现即降级”，应明确这是保守但有损的语义，并补对应验收；不能把 §4.4 的“跨响应／丢帧”与“同响应稍后出现”混为一类。

### M2／major／§6.3–§6.5、§10-2／3／10

**问题：`flush` 只处理无结果 invocation，遗漏“结果已 start 但未 stop”的正常结束路径；该 pair 会被完整静默丢失。**

**证据：** 状态机在 result start 时把块加入 `downgradeResults` 并 suppress，仅在 result stop 时发 transcript（spec §6.3）；`flush` 只遍历“未配对的 invocations”（spec §6.3:343），没有遍历 `downgradeResults`。因此序列 `use start/delta/stop → result start → message_stop/EOF` 会同时 suppress use 与 result，且 flush 不发任何文本，直接违反“降级而非丢弃”。真实接口的 `flush` 会在自然 drain 与异常 finally 都执行（`response-processor.ts:212-217,275-287`），所以这不是不可达状态。

**建议方向：** 在状态里区分 `result-started`／`result-closed`；flush 先按统一上游顺序发所有未 emitted 单元，其中 result-started 用已累积内容渲染并标 `incomplete`，完全无 result 才用 `result=null`。验收补 result-before-stop EOF、result delta 后 EOF、result start 后异常三类。与此同时修正 §6.5-6“异常中断 flush 未跑”这一现状断言；当前实现异常也跑 flush。

### M3／major／§5.4-2／3、§10-5

**问题：spec 声称“JSON 字符串化／转义”能保证 transcript 不含 `<invoke` 与 `<system-reminder>`，该机制事实错误，会让合成文本再次被现有重写器误处理或剥除。**

**证据：** `JSON.stringify({x:"<invoke",y:"<system-reminder>"})` 原样输出 `<invoke` 与 `<system-reminder>`；JSON 不转义 `<`。请求侧 `removeAnthropicSystemReminders` 会清理 assistant text（`sanitize/system-reminders.ts:76-86`）；响应侧 `recover-tool-call` 会在 text 中正则搜索完整 `<invoke name="X">`（`recover-tool-call/core.ts:57-79`），且 server-tool filter 的 order 300 晚于 recover 的 order 100（`response-rewrite-adapters.ts:124-196,325-346`），所以新 transcript 内嵌恶意／偶然完整标记时，recover 已有机会先把它重建成假的 `tool_use`。

**建议方向：** 定义真正可验证的 escaping／encoding 契约，例如对所有用户可控文本至少将 `<` 编码为 `<`，并规定 decode 不发生；不要用“JSON 序列化天然不产生标记”作依据。验收必须构造结果正文内含完整且工具名命中的 `<invoke name="X">…</invoke>`、`<system-reminder>…</system-reminder>`，走真实 rewrite 顺序与第二轮回流，确认既不恢复成 `tool_use` 也不被剥除；仅单测 renderer 字符串不够。

### M4／major／§12、C11

**问题：实施影响面明显漏文件，尤其是策略更名与共享 helper 的既有消费者；按当前清单执行会留下编译／测试／文档契约漂移。**

**证据：** `web-search-not-found-retry` 更名还需改 `src/lib/request/retry-registry.ts:65,282-288`、`tests/pipeline/web-search-not-found-retry.unit.test.ts`、`tests/anthropic/anthropic-codec.unit.test.ts:132`、`tests/helpers/retry-strategy-names.ts:33`、`tests/request/retry-registry.unit.test.ts:149`；§12 只列源策略文件。`isServerToolResultType` 另被 `sanitize/empty-encrypted-search-result.ts:44,77`、`sanitize/rewrite-server-tool-blocks.ts:37,103`、`stream-accumulator.ts:17,292` 消费；`createServerToolBlockFilter`／`filterServerToolBlocksFromResponse`／`isServerToolBlock` 的现有集成测试集中在 `tests/anthropic/server-tool-rewriting.it.test.ts`，清单也未点名。新增 config 还需 `config.yaml` 示例／说明、foundation state/default、config 装配与 config 测试，而 §12 仅列 `schema.ts + config.schema.json`。

**建议方向：** 将 §12 改成按“生产接线／导出消费者／策略注册与名字守卫／配置全链／既有测试”分组的穷尽清单。策略若更名，明确所有 import、registry entry、golden strategy-name 列表、测试文件名同步；config 字段明确 `schema.ts → config.schema.json → config.yaml → packages/foundation state/default → config.ts hot reload → validation/hot-reload tests` 全链。

### M5／major／§10-1／6／7／9／12

**问题：多条验收标准仍可在错误实现下假绿，尤其没有证明 live wiring、passthrough byte identity 与 retry-hint 同 attempt 不变量。**

**证据：** AC1 只断 SDK 拼装和两块存在，允许实现改写 `id/caller/input/content/encrypted_content` 后仍绿，不足以证明“原样”；AC6 所谓“逐字节等于今天 golden”未要求 frozen pre-change oracle，实施者更新 golden 即可自洽；AC7 只说 property 测 wire 不变量，若 generator 从 `resolveEffectiveServerToolDeclarations` 同源生成 expected，会把 S3/S4 同错变成绿，且没有真实 `prepareHints.excludeServerToolTypes` retry 路径；AC9 依赖“现有 golden”，但仓库已确认 Gemini→Messages 有独立真实路径 `tests/gemini/reverse-gemini-messages.it.test.ts`，并非一套泛称 golden 就能证明四象限。AC12 跑全量门也证明不了这些接缝。

**建议方向：** AC1 对 SDK 结果逐字段／逐块深等于冻结上游 fixture，并加 mutation（改 `encrypted_content` 或 `caller` 必红）；AC6 在实施前冻结 raw byte oracle，禁止由新实现重生成；AC7 用独立 oracle 扫最终 prepared wire，并真实驱动 server-tool rejection strategy 产生 hint，断同一 retry attempt 的 pair 与 declaration 同时变化；AC9 分别点名 CC、Responses、Gemini reverse-leg 的真实测试文件与各自 raw-byte oracle。每条 positive control 都应写“mutation 必须确认实际生效”，避免 mutation 本身未命中而误判测试有效。

## 主观建议

无。本轮仅报告 blocker 与 major。

---

## 【第 2 轮】第二轮复评报告

## 评审范围

仅复评 `/home/xp/src/copilot-api-js/docs/spec/2026-07-26-server-tool-provenance-routing.md` 的两处争议、§6.2–§6.5 flush 状态空间、§4.3.1／§4.4 fallback 的互斥穷尽与递归终止。

## 已读取／执行的证据

读取更新后的 §4、§5.4、§6、§10，并对照 `/home/xp/src/copilot-api-js/src/lib/pipeline/rewrite-registry.ts:179-185`、`/home/xp/src/copilot-api-js/src/lib/codec/anthropic/response-rewrite-adapters.ts:124-196,325-346`、`/home/xp/src/copilot-api-js/src/lib/pipeline/stream/response-processor.ts:212-221`。未修改仓库、未启动服务器。

## 总体 verdict

**修复 major 后可进入下一阶段。** blocker 数量：**0**。major 数量：**3**。

## 事实性发现

### R2-M1／major／§4.3.1

**问题：不缓冲 `UNRESOLVED` 的核心代价论证不成立，当前选择会在可构造序列上破坏“客户端声明则原样转发”的已决语义。**

**证据：** 缓冲只在 child-before-parent 的 `UNRESOLVED` 序列出现后才启动，不会“落在每个正常响应上”；正常 parent-before-child 响应完全不缓冲。当前算法对 `child(caller=P) → parent(P, client-declared)` 永久降级 child，而完整图可证明它应继承 client-declared。生产计数只能在错误行为上线后发现，不能补回已降级历史。

**建议方向：** §11-4 的真实帧探针应前置为设计裁决门：若证明协议／真实实现保证 parent-before-child，保留降级并把保证写成依据；否则只在首次 `UNRESOLVED` 后缓冲该块及后续帧至 parent／EOF，不影响正常响应。不能以一个实际不存在于正常路径的性能代价否决语义完整方案。

### R2-M2／major／§4.3.1、§6.2、§6.5-4

**问题：重复 invocation/result 的既定动作与 `emitted: Set<serverToolUseId>` 直接矛盾，会吞掉要求独立发射的单元。**

**证据：** §4.3.1 要求重复 `server_tool_use.id` 的后到块“按自己的 upstream index 独立成单元”，§6.5-4 要求同一 `tool_use_id` 的第二个 result 再发一次；但 §6.2 用仅按 ID 的 `emitted` 去重。第一单元发射后，该 ID 已存在，第二 invocation 或重复 result 无法表示为“尚未发射”；反向顺序同样会吞一项。

**建议方向：** 发射身份改为稳定的逻辑单元 ID／upstream index，而不是 `serverToolUseId`；结果单元也以自己的 upstream index 跟踪。`tool_use_id` 只用于关联与标注 duplicate，不能兼任 emission identity。AC13/14 之外补重复 invocation ID、重复 result、两者组合的正向与 mutation 测试。

### R2-M3／major／§4.3、§4.4

**问题：fallback 六行尚未互斥穷尽，且“未知 caller”没有接入伪代码；畸形 caller 可直接抛异常。**

**证据：** `resolve` 仅特判 `caller.type === "direct"`，其余立即读 `caller.tool_id`；`caller` 缺失／null、未知 type 且无 string `tool_id`、空 `id` 均未定义。§4.4 的“未来未知 caller.type”与“UNRESOLVED”可同时命中，未知 name 又可与 cycle／声明不匹配同时命中；表未声明 first-match，诊断与计数归因不确定。递归本身在有效对象上有 visited+depth，能终止，但入口域未封闭。

**建议方向：** 在伪代码入口先验证 `id/name/caller` 形状，再按有序互斥分支分类：malformed/unknown caller → direct → nested-with-valid-tool_id → graph resolve；明确 first-match precedence，并把重复 ID 作为独立预处理状态。补 missing caller、null caller、unknown caller with/without tool_id、空/非字符串 tool_id 的验收。

## 两处争议结论

- **M3 因果链修正：接受。** `recover-tool-call` order 100 早于 filter order 300，当前响应看不到后生成 transcript；第二轮是请求路径，也不经过 response recover。可达风险是请求侧 system-reminder 清理；`&lt;` 且禁止 decode 的修法成立。
- **M1 保守降级：暂不接受为定稿方案。** 不是因为“降级永远不能用”，而是当前拒绝缓冲的性能前提被代码路径推翻；应先用已有探针闭合 parent-before-child 保证，或采用仅异常序列触发的局部缓冲。

## §6 flush 结论

除重复 ID／重复 result 的 emission identity 缺陷外，四形态已覆盖单一合法 ID 下的未发射状态：invocation closed/no result、closed/result started、invocation unclosed、orphan result started；closed result 在 stop 当场发射，不构成第五种未发射形态。

---

## 【第 3 轮】第三轮复评报告

## 评审范围

仅复评 `/home/xp/src/copilot-api-js/docs/spec/2026-07-26-server-tool-provenance-routing.md` 的 emission identity／AC15、`UNRESOLVED` 局部缓冲上界与触顶动作、未知 `caller.type` 继承。

## 已读取／执行的证据

读取更新后的 §4.3–§4.4、§6.2–§6.5、AC14–AC16，并对照 `/home/xp/src/copilot-api-js/src/lib/pipeline/rewrite-registry.ts:65-76,93-99,101-125` 的 rewrite 驱动契约及 `/home/xp/src/copilot-api-js/docs/spec/2026-07-27-inter-block-keepalive-carrier.md:30-56` 的静默窗口取证。仓库未修改、未启动服务器。

## 总体 verdict

**修复 major 后可定稿。** blocker 数量：**0**。major 数量：**3**。

## 事实性发现

### R3-M1／major／§4.3.1、§6.2、AC14

**问题：5s“硬上界”在现有 `ResponseRewrite` 接口中不可驱动，长静默时恰好永远不会触顶发射。**

**证据：** rewrite 只有由上游帧触发的同步 `transform` 与流结束 `flush`（`rewrite-registry.ts:101-125`）；接口注释已明确“timer-driven heartbeat 在 SILENCE 时无 frame，纯 transform 无法表达”（同文件 :93-99）。`buffered.startedAtMs` 只能在下一帧到达时检查；若 parent 与后续帧都沉默 300s，5s 时没有执行点，仍会复现本节要避免的整段静默。

**建议方向：** spec 必须选定可执行接线：扩展 rewrite/processor 的 idle-timer hook，或把 timeout 所有权交给已有 delivery heartbeat owner，并定义定时回调如何经 serializer 发帧、如何与 parent 到达／flush 竞争且 exactly-once。AC14 要用 fake clock 证明“5s 内无任何新上游帧”也会主动释放；只在第 201 帧检查不算时长硬上界。

### R3-M2／major／§4.3.1、§6.2–§6.4

**问题：触顶后的状态转移未定义，无法保证已缓冲内容不丢、不重、不乱序，以及后到 parent/result 仍与先前降级决策一致。**

**证据：** spec 只有单个 `buffered{frames}` 与一句“按保守降级渲染并发射已缓冲内容”，逐事件表完全没有“进入缓冲／缓冲中解析 parent／解析成功重放／触顶重放／重放后继续”的动作。缓冲内容含 unresolved child 的 start/delta/stop 及其后所有普通块；不能把它们整体渲染成 transcript。触顶后 parent 若再到且判为 CLIENT_DECLARED，child 已降级，后到 result 必须锁存为 downgrade，否则 pair provenance 会分裂。

**建议方向：** 增加明确状态机：`idle → buffering(unresolvedIds, frames) → replaying → idle`；重放必须按原序重新过本 rewrite 的同一分类逻辑，但禁止二次入缓冲；触顶时给相关 invocation 锁存 `forced-downgrade`，其后 parent/result 均服从该决定。定义 timer／parent／EOF 同时发生的单一赢家与 `emitted<upstreamIndex>` exactly-once，并为普通块夹在缓冲区、多个 unresolved parent、触顶后结果到达补验收。

### R3-M3／major／§4.3:205-217、§4.4、AC16

**问题：未知 `caller.type` 仅凭存在 `tool_id` 就继承，仍把未知 discriminant 当成已知语义，打开误放行口子。**

**证据：** 当前 SDK 的封闭 union 只为 `code_execution_20250825|20260120` 定义 `tool_id` 的“父 server tool”语义（`messages.d.ts:982-990,1002-1009`）；未来未知 type 的同名字段是否仍表示 provenance parent 尚无契约。构造未知 caller 指向一个 client-declared root 即可令任意 child name 继承 CLIENT_DECLARED、绕过 §4.2 的 typed name/type 判据而原样转发。

**建议方向：** 只对白名单 caller type 继承；未知 type 一律 `UNKNOWN_CALLER → 降级 + warn`，待 SDK／协议明确新 discriminant 后加入表。若坚持结构化 forward compatibility，至少必须有独立协议证据证明所有含 `tool_id` 的 caller 都承诺父子 provenance；当前字段名推断不足以支撑放行。

## 已确认关闭

- emission identity 改为 upstream index 后，R2-M2 的重复 ID／重复 result 矛盾已关闭。
- AC15 的 mutation 在三组 fixture 都明确走 downgrade transcript 路径并逐 upstream-index 计数时，会使三条全红；实施时应把这一前提写进 fixture，避免 passthrough 样本绕开 `emitted`。
- 缓冲硬上界的需求本身正确；问题是当前 spec 尚未给出能在无帧静默期间执行它的接线，以及触顶后的完整状态转移。

---

## 【第 4 轮】第四轮复评报告

## 评审范围

仅复评 `/home/xp/src/copilot-api-js/docs/spec/2026-07-26-server-tool-provenance-routing.md` 的局部缓冲子状态机，以及“不在本 spec 内扩展 rewrite timer 契约”的边界。

## 已读取／执行的证据

读取更新后的 §4.3–§4.4、§6.2–§6.5、AC14–AC16，并对照 `/home/xp/src/copilot-api-js/src/lib/pipeline/rewrite-registry.ts:93-125`。仓库未修改、未启动服务器。

## 总体 verdict

**修复 major 后可定稿。** blocker 数量：**0**。major 数量：**2**。

## 事实性发现

### R4-M1／major／§4.3.1:286-299、§6.2

**问题：`awaiting`／`forcedDowngrade` 的键域互相矛盾，触顶时无法执行规范要求的锁存。**

**证据：** `awaiting` 存的是尚未出现的 parent `tool_id`，没有 upstream index；`forcedDowngrade` 却声明为 `Set<upstreamIndex>`。转移表要求“给 awaiting 里的 id 锁存 forcedDowngrade”，在类型和信息上都做不到。真正需要锁存的是触发 unresolved 的 child 单元 index；若还要求后到 parent 也服从，则另需 `forcedCallerIds`，不能混成一个集合。

**建议方向：** 分开定义 `awaitingParentIds`、`unresolvedChildIndicesByParentId`、`forcedDowngradeIndices`；触顶时把每个 parent 对应的 child indices 锁存。明确后到 parent 自身是否降级——parent/result pair 与 child/result pair 是两对，不应把“pair provenance 一致”误扩成整棵树必须同 disposition。补触顶后 parent + parent result + child result 的逐块验收。

### R4-M2／major／§4.3.1:287-299、AC14／14c

**问题：多个 awaiting 时“任一父出现即重放，并把其余 unresolved 强制降级”仍会无故破坏已决的 client-declared passthrough 语义。**

**证据：** 构造 `childA→PA, childB→PB, PA(client-declared), PB(client-declared)`，且未触任何上界。PA 到达即重放；规则 2/5 把仍未出现的 PB 路径强制降级，尽管 PB 随后在预算内到达且可证明 childB 应 passthrough。局部缓冲已经存在，没有理由在第一个父出现时放弃等待集合中的其他父。

**建议方向：** `buffering → replaying` 应在 `awaitingParentIds` 清空、上界触顶或 flush 时发生；父出现只从集合移除，不立即重放。若因已解析部分而做增量重放，必须保留未解析后缀且维持全序，设计更复杂，无必要。AC14c 改测“多个 parent 逐个解析后一次重放”；另测一父永不到时由上界统一强制降级。

## 边界裁决

接受本 spec 不扩展核心 rewrite timer 契约。当前把 5s 明确定义为“下一帧到达时惰性检查”、并记录真正 idle hook 的依赖与触发条件，足以实施本功能；它不再冒充真实 wall-clock 硬上界。未知 `caller.type` 白名单修订也已关闭 R3-M3。

---

## 【第 5 轮】第五轮复评报告

## 评审范围

仅确认 `/home/xp/src/copilot-api-js/docs/spec/2026-07-26-server-tool-provenance-routing.md` 对 R4-M1、R4-M2 的修订是否闭合。

## 已读取／执行的证据

核对 §4.3.1 的三类键域、状态转移与重放规则，以及 AC14b–AC14d。仓库未修改、未启动服务器。

## 总体 verdict

**可以定稿。** blocker 数量：**0**；major 数量：**0**。

## 结论

- R4-M1 已关闭：待解析 parent ID、其 child upstream indices、强制降级单元 indices 三个键域已分离；触顶锁存可执行，且锁存范围正确收窄到 child invocation 自身 pair，不再误伤 parent pair。
- R4-M2 已关闭：只有 `awaitingParentIds` 清空、上界触顶或 flush 才进入 replay；父逐个出现只消减集合，不会提前迫使其他 child 降级。AC14c 的 mutation 能区分旧错误行为。
- 重放规则与 `emitted<upstreamIndex>` 共同覆盖顺序、exactly-once、终止和 pair disposition 一致性；本轮未发现 blocker 或 major。
