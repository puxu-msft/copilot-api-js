# GHC HTTP 408 upstream transport skill 对抗评审

## 评审范围与证据

评审 `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md`、`docs/request-pipeline.md`、`packages/foundation/src/error/classify.ts`、`src/lib/transport/http2-client.ts`，以及 408 分类、pipeline retry、h2 transport 相关测试。裁判轴为长远正确与完整，双向检查 false-green（错误 408 被误重试）和 false-red（目标瞬态 408 被漏掉）。

## 已闭合命题

- **命题 1：skill 的静态召回描述覆盖目标症状——已确认；实际自动召回尚未验证。** `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:1-3` 的 frontmatter `description` 逐字包含 `HTTP 408 user_request_timeout` 与 `Timed out reading request body`，并把“大请求”“上传卡住”列为相邻触发词；不是只藏在正文。实际新会话能否在未点名时召回需要 field evidence，见 F1。
- **命题 2：History→framing→h2c 字节 oracle→环境差异的顺序可执行——已确认。** `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:60-64` 依次给出 History endpoint 与字段、header framing 检查、`setHttp2SessionFactoryForTests(() => http2.connect(url))` 驱动生产 `http2Fetch` 的 h2c oracle、以及直连／proxy和空闲／负载对照；实际 seam 存在于 `src/lib/transport/http2-client.ts:846-849`，生产 body 写出在 `src/lib/transport/http2-client.ts:1187-1188`。
- **命题 3：证据能力边界没有过度外推——已确认。** `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:60-64` 分别限定：header 干净只排除 framing mismatch；本地逐字节一致只排除“该 runtime／该实现对该体量固定截断”，明确不覆盖真实 GHC、proxy、拥塞窗口或所有并发条件；`write(false)` 不等于丢字节；错误文案不构成“GHC 保证零处理”。
- **命题 4：skill 复述与产品文档、matcher／retry 契约一致——已确认，但发现一处注释过度定性。** `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:64-66`、`docs/request-pipeline.md:9-13` 与 `packages/foundation/src/error/classify.ts:177-188,325-336` 对三条件 matcher 的复述一致；`src/lib/request/strategies/network-retry.ts:28-55` 实现仅接收 `network_error`、等待 1000 ms、复用同一 payload、实例内最多一次，`src/lib/request/retry-registry.ts:131-163` 将其以 order 100 注册为所有 legs 的 shared strategy。定向测试命令 `bun test tests/infra/error.unit.test.ts tests/pipeline/network-retry-strategy.unit.test.ts tests/pipeline/driver.unit.test.ts` 在目标 worktree 完成且无失败；该命令只支持所选测试集合，不外推为全套件。代码注释的过度定性另见事实性发现 F2。
- **命题 5：普通／近邻 408 仍为终态——已确认。** `tests/infra/error.unit.test.ts:177-186` 以普通 408、仅 code 命中、仅 message 命中三个负控证明它们分类为 `bad_request`；`src/lib/request/strategies/network-retry.ts:36-38` 只接收 `network_error`，且 `tests/pipeline/network-retry-strategy.unit.test.ts:19-30` 明确拒绝 `bad_request`。全策略查找位于 `src/lib/pipeline/driver.ts:731-748`；仓库搜索显示其他 `bad_request` payload strategy 均额外限定 HTTP 400，没有接收 408 的路径。非 JSON 408 由 `packages/foundation/src/error/classify.ts:325-336` 的 parse-failure 返回 false 后落入 `bad_request`，但该文档明确承诺的反例缺少直接测试，见 F3。
- **命题 6：当前不拆 skill 有职责内聚依据；未来拆分触发可明确，但产物未记录召回自验——部分确认。** 408 章节直接复用同一 skill 已覆盖的 History、request framing、真实 `http2Fetch` seam、proxy 与并发对照（`.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:10-48,49-66`），当前仍是单一“上游 transport 诊断”职责，不应仅因新增一个状态码拆分。建议仅在 408 手册形成独立且稳定的长流程、拥有独立验证资产／维护周期，或需要脱离其他 transport 症状单独加载以控制上下文时拆分；目前均未成立。可是实际自动召回可靠性不能由 description 自身证明，且缺少项目强制的自验接缝，见 F1。

## 事实性发现

- **F1 [MAJOR] `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:1-87`——缺少指令类产物强制的自验表与 `verification-log.md`。** `CLAUDE.md:41` 明确要求 skill 中需要实战检验的断言必须内置“自验表 + 记录文件”；目标目录实际只有 `SKILL.md`。本轮只能从 frontmatter 文本确认三个症状具备静态触发词，不能确认新会话会在未点名时实际召回；同理，本地 h2c 配方在真实事故压力下是否按顺序被执行也没有可积累的 field evidence。此前命题 1 应收窄为“静态 description 已覆盖”，不能写成实际召回已证。**修复建议：** 由 `gpt-souls:instruction-smith` 在 skill 内加入最小自验表，至少覆盖无点名 408 症状的自动召回、四阶段配方的可执行性与结论不越界；同目录新增权威记录文件，写清确认／证伪形态与记录协议，然后重新评审。
- **F2 [MINOR] `packages/foundation/src/error/classify.ts:180`——matcher 注释把可用性裁决写成协议／因果事实。** 注释声称这是 transient failure，且“replaying ... is the only path to a response”；但 GHC 已经返回结构化 408 响应，且 `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:64` 正确限定为项目选择的一次有界重放，不是 HTTP 幂等保证，也不能从文案推出零处理。权威声音之间当前一强一弱，未来维护者可能据较强注释继续放宽 matcher。**修复建议：** 改为“项目将该窄形态按可用性政策归入 `network_error` 并有界重放一次”，删除“only path”与未经观测支持的 edge 因果定性。
- **F3 [MINOR] `tests/infra/error.unit.test.ts:177-186`——文档承诺的非 JSON 终态分支缺少直接负控。** 实现的 `catch { return false }` 当前正确，但测试只覆盖普通、code-only、message-only 三类；`.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:66` 明确把非 JSON 列入终态契约。若 parse-failure fallback 日后被改宽，现有 408 测试不会咬住。**修复建议：** 将 malformed／plain-text body 加入同一 `test.each`，并补缺失 `error`、非字符串 `message` 的结构反例，均断言 `bad_request`。
- **F4 [MINOR] `tests/pipeline/driver.unit.test.ts:416-461`——production Responses strategy stack 只有目标 408 正控，没有近邻 408 的终态负控。** classifier 与 `network-retry` 的单元负控可分别咬住多数改坏，但没有一条测试对合并 seam 断言“错误 408 只 dispatch 一次、无 retry timer、终态返回”；这正是本轮要求检查的 false-green 方向。**修复建议：** 在同一真实 strategy stack 下表驱动普通、code-only、message-only、非 JSON 四类，断言 transport attempts 为 1、未安排 1000 ms timer、`recordAttemptFailure` 标记为不重试。

## 结构怪味扫描

- `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:6`——**命名／内容漂移**：标题仍称“三陷阱”，正文已覆盖 proxy、两层保活、h2 session 池、408、流错误分类等多个主题。**处置：本轮修。** 改成不带数量且能覆盖职责的标题，例如“GHC 上游 HTTP 传输诊断”。这是标题可读性问题，不构成拆 skill 的依据。
- `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:49-66`——**潜在过早拆分**：408 章节与同 skill 的 transport seam、proxy、并发、History 诊断原语高度复用。**处置：本轮不拆。** 仅在该章节拥有独立验证资产／维护周期，或必须单独加载以控制上下文时再拆，避免现在制造交叉引用与双份 transport 前置知识。
- `packages/foundation/src/error/classify.ts:180`——**权威复述漂移**：代码注释比产品文档与 skill 的限定更强。**处置：本轮修。** 按 F2 收窄，不新增第三份重试契约。

## 主观建议

- **[建议] `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:6`——移除“三陷阱”数量承诺。** 预期影响：标题与不断演化的 transport 诊断职责保持一致，减少每次加章节都产生的名实漂移。推荐做法：使用稳定的职责标题，不按当前小节数量命名。

## 总体结论

**Verdict：修复 major 后可进入下一阶段。0 blocker，1 major，3 minor，1 nit。** 六项命题中，matcher、诊断顺序、证据边界、终态负控与当前不拆分均有当前代码／测试支持；实际自动召回只能确认静态触发词齐全，因缺自验协议不能宣称 field recall 已证。false-red 方向有 production stack 正控；false-green 方向由分类与策略单测部分覆盖，但缺合并 seam 负控。

## 最佳路径反思

- **项目内替代方案：** 当前最佳内部形状仍是把 408 留在统一 transport skill 中，并让 `docs/request-pipeline.md` 独占产品 retry 契约；拆成独立 skill 现阶段会重复前置知识。
- **判据判别力：** 正样本已穿过 production Responses stack，负样本目前停在 classifier／strategy 两层，尚不能直接排除合并 seam 误重试；F4 是必要补强。
- **第三方方案：** 本改动是项目特有 GHC 文案 matcher 与诊断知识，不存在能替代它的成熟第三方库；HTTP/2 framing 继续依赖标准 `node:http2`，不建议另造 transport primitive。

## Round 1 处置（主会话，2026-08-08）

| Finding | 级别 | 处置 | 证据／整改 |
|---|---|---|---|
| F1 缺自验表与记录文件 | B | 采纳 | SKILL 新增 V1 自动召回、V2 配方可执行、V3 证据边界三项自验；新增同目录 `verification-log.md`，明确作者／静态 reviewer 只能记数据不足，field 证据协议与三次独立确认口径。 |
| F2 classify 注释过度定性 | C | 采纳 | 注释改为“项目可用性政策把窄 408 归为 transport-class 并有界重放”，明确不是 HTTP 幂等或零处理保证。 |
| F3 非 JSON／畸形结构负控 | C | 采纳 | classifier 表新增 plain text、malformed JSON、missing error、non-string message 四类，均断言 `bad_request`。 |
| F4 production strategy stack 近邻负控 | C | 采纳目标，调整 oracle | 新增普通／code-only／message-only／plain-text 四类真实 Responses strategy stack 测试；断言 attempts=1、无 1000ms timer、`recordAttemptFailure=[]`、原错误终结。未采用建议的 `willRetry:false`，因为 production driver 只在实际 retry commit 点调用 `recordAttemptFailure({willRetry:true})`（`driver.ts:779-783`）；请 reviewer 复审并可反驳。 |
| 标题“三陷阱”漂移 | D | 采纳 | 改为稳定职责标题“GHC 上游 HTTP 传输诊断”。 |
| 当前是否拆 skill | B | 不拆，保留触发式提议 | 自验段记录未来拆分触发：独立上传协议／验证资产／维护周期或必须独立加载；当前 408 仍复用同一 History、framing、h2、proxy 与 classify 链。 |

**判别力实测：** 放宽 matcher 为所有 HTTP 408 后，classifier 与 production stack 负控转红；production 四格均在 1000ms timer 断言处快速失败。反向应用同一 patch 后靶向 13/13 绿。前两次测试门因等待终态而挂住，第三版改为竞争“终结或 timer”后形成快速判别门；该过程保留在会话记录，最终测试不依赖任意 wall-clock sleep。

## Round 2 复审（独立 reviewer，2026-08-08）

- **F1 已闭合。** `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:88-98` 新增 V1–V3 自验表与拆分观察；`.claude/skills/debugging-ghc-api-upstream-transport/verification-log.md:1-17` 提供权威记录、证实／证伪／数据不足协议，并正确把作者和静态 review 记录为“数据不足”，没有拿本轮自证冒充 field evidence。
- **F2 已闭合。** `packages/foundation/src/error/classify.ts:177-181` 已把注释收窄为 project availability policy，明确一次重放不是 HTTP idempotency 或 zero-processing guarantee；不再声称 edge 因果或“only path”。
- **F3 已闭合。** `tests/infra/error.unit.test.ts:177-190` 新增 plain text、malformed JSON、missing error、non-string message，连同原三个近邻反例均断言 `bad_request`。
- **F4 已闭合；`recordAttemptFailure=[]` 符合真实 driver 契约。** `tests/pipeline/driver.unit.test.ts:463-504` 通过 production Responses strategy stack 断言 attempts=1、无 retry timer、无 `recordAttemptFailure`、原错误终结。`src/lib/pipeline/driver.ts:763-784` 对 no-strategy、abort、budget-exhausted 都直接 `fail`，只有 retry 通过预算门后的 commit point 才调用 `recordAttemptFailure({ willRetry: true, ... })`；因此不存在合法的 `{ willRetry: false }` 事件，空数组比首轮建议更准确。
- **F4 mutation 判别力已确认。** 冻结 patch 只把 `status === 408 && isRequestBodyReadTimeout(...)` 放宽为所有 408；mutation run 中 production 四格均在 `liveTimerDelaysMs` 收到 `[1000]` 而转红，证明 classifier 放宽确实穿过 production matcher／strategy／driver 接缝；恢复同一 patch 后靶向 13/13 绿。该 mutation 证明“所有 408 被误重试”这一目标缺陷会被两层测试捕获，不外推为任意 matcher 缺陷都已覆盖。
- **标题与拆分处置已闭合。** `.claude/skills/debugging-ghc-api-upstream-transport/SKILL.md:6` 已改为稳定职责标题“GHC 上游 HTTP 传输诊断”；`:98` 明确当前共用 History、framing、`http2Fetch`、proxy／并发而不拆，并以流式上传／请求压缩／HTTP/3、独立验证资产与维护周期、需单独加载作为未来提议触发条件。

**Round 2 verdict：可进入下一阶段。0 blocker，0 major。F1–F4、标题与当前不拆分处置全部闭合。** 复跑 `bun test tests/infra/error.unit.test.ts tests/pipeline/driver.unit.test.ts`：170 pass、0 fail；命令在目标 worktree 执行。
