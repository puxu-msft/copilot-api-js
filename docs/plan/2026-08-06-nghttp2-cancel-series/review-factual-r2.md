# 事实证伪复评 R2

- **评审范围：** 主树工作区当前 `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/{HANDOVER.md,KICKOFF.md}`；SHA256 分别为 `9e1c9f19b6a62dfb7932588f08da85cbc730464a86a6b82815eea9e2fa5a11f3`、`5dc58e4691a5536574cd4661d8590d605ff5df3f555017e23fa840b92ebc3a59`。未重扫 history。
- **总体 verdict：** 修复 major 后可定稿。
- **计数：** 0 blocker / 3 major。
- **双视角覆盖证据——机械核对：** 核对 draft／current master Git 对象、工作区与 committed blob hash、四组 session/transcript/job/tasks 路径、A0–A3 ancestry、A3 finding 文件和 transport 路径漂移、当前源码能力／诊断缺口，并只读复跑稳定 History ID。
- **双视角覆盖证据——第一人称执行：** 从 KICKOFF preflight 依次模拟现场身份、取新样本、A4 dispatch、peer/local CANCEL 双控与 Phase B 预注册；双向检查错误状态能否假绿，以及正确但 dirty／TBD／无 listener 状态是否会被误放行或误拒。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:25` — canonical 清单把 `review-factual.md`、`review-successor.md` 一并声称为“已由 0840b929 落入仓库”，事实不成立。
证据：`git cat-file -e 0840b929:<两路径>` 与 `git cat-file -e refs/heads/master:<两路径>` 均 rc=128；两文件只存在于当前工作区。新 checkout 会缺失它们，而 KICKOFF packet :80/:103 又把它们列为必读 Supporting evidence。
修复建议：整改提交必须实际纳入这两份历史 review 后再写“已落仓库”；提交前则明确标为未提交 WIP，不得把工作区存在性冒充 commit 可达性。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:66` — 开工指针仍写“按 HANDOVER B.4 从 A4 开工”，但当前 B.4 是硬 gate，A4 位于 B.5.2，且 B.5.1 要先取得新可复跑样本。
证据：`HANDOVER.md:97-109` 是 B.4 与 B.5.1，`:111-115` 才是 A4；照 KICKOFF 执行会找不到所称 A4，或跳过 :83-87／:107-109 的稳定 ID 样本门，正确顺序被旧编号误导。
修复建议：改为“先完成 B.5.1；满足后按 B.5.2 实施 A4”，并同步 KICKOFF :4 的旧范围“B.3～B.5”为当前精确章节入口。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:57-61` — 声称“不泄露敏感值”却把 credential/proxy 值的稳定、无盐 SHA-256 前 12 位写入终端／transcript。
证据：脚本对 `TOKEN|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL|API_KEY|PROXY` 命中的真实进程值直接哈希；低熵密码可离线枚举，任何密钥也会留下跨运行可关联指纹。C13 只要求区分声明值／持有值，presence 已足够，digest 不是必要身份值。
修复建议：敏感项只输出 key presence，不输出值、长度或 digest；需要判断变化时由进程内比较后只输出 `same/different`，且不持久化可复用 verifier。

## 首轮 4 major disposition

1. **CLOSED — Node `http2` 注入语义。** `HANDOVER.md:115` 已按官方语义区分 peer `stream.close(NGHTTP2_CANCEL)`、local `req.close(...)` 与 `destroy(error)` INTERNAL_ERROR 分支。
2. **OPEN — canonical 仓库入口。** tmp 已降为 provenance（`HANDOVER.md:25`，`KICKOFF.md:4`），但同段新增“两个 review 已由 0840b929 提交”的错误状态，见本轮 major。
3. **CLOSED — 无稳定 ID 的旧样本。** `HANDOVER.md:79` 已明确降为不可独立复跑线索，`:83-87` 为新样本规定稳定 entry/request ID、完整命令、字段路径、身份和非 CANCEL 正控。
4. **CLOSED — Phase B 预注册。** `HANDOVER.md:117-123` 要求采数前冻结样本量／最大尝试、指标／分母、统计方法、排除与停止规则；TBD 阻断采数，未凭空填写数值，并含已知 effect 正控与同配置负控。

## C1–C14 当前状态命题核验

- **C1 通过。** `git merge-base --is-ancestor 0840b929 refs/heads/master` 为 0；current master 为 `74853175c2c5771e6110bdbdfb97870132788fa1`。committed HANDOVER/KICKOFF hash 为 `c0704a…`／`3466f3…`，与本轮指定工作区 hash 不同，证实整改尚未提交；`HANDOVER.md:6` 也如此标注。
- **C2 通过。** `HANDOVER.md:12,18-21` 的四 session 和承接链与 `session-inventory.md:24-113` 一致；对四组 transcript、job、tasks 逐组 `test -f/-d` 均 rc=0，未重扫 history。
- **C3 通过。** A0 `b6fb0947`、A1 `92fcc611`、A2 `50941d32`、A3 `08046d5c/c23ed804` 对 current master 的 ancestry 检查均 rc=0；`HANDOVER.md:31-40,66-70` 清楚保留 A1 002、真实库、A3 review/CI 等未完成边界。
- **C4 通过。** `HANDOVER.md:31,42-53,130` 始终把 0 blocker／6 major 锚定 `fa2bfd2d` 并将 current-HEAD disposition 标 unresolved；没有冒充 current verdict。`fa2bfd2d..master` 对四个 finding 核心文件 diff 为空，仅能支持“未触及”，文档没有越界升级。
- **C5 通过。** 计划后 transport／transport-reason／transport tests 的 Git log为空；当前 `TransportDispatchOptions` 仍只有 `forceHttp/signal`（`src/lib/pipeline/types.ts:122-128`），scheduler :204 未传 dispatch，支持 A4 未实现。
- **C6 通过。** `HANDOVER.md:77` 给出窗口 `2026-08-05T03:28:10.512Z..2026-08-06T03:28:10.512Z`、3038 GPT／57 失败／23 CANCEL，并明确来源是 `b6fb0947` 二手计划记录、未重算且不能当当前率。
- **C7 通过。** 只读 `GET /history/api/entries/req_1786048981227_99` 实得 ID 相同、PID `3575452`、`gitSha=fa2bfd2d`、`gitDirty=true`、错误 `NGHTTP2_CANCEL`、6031 SSE events；与 `HANDOVER.md:78` 一致且未据此推根因。
- **C8 通过。** TCP keepalive／PING 分别见 `http2-client.ts:153-165,249-261`，默认 15s 见 `config.yaml:278,288`；N=1 默认见 `packages/foundation/src/state-defaults.ts:250`；REFUSED／pre-response reason 与一次 network retry 见 `http2-client.ts:1159-1177`、`classify.ts:74-89`、`network-retry.ts:31-46`。
- **C9 通过。** 旧样本已按 `HANDOVER.md:79` 降级；新样本 gate :83-87 含稳定 IDs、observedAt、时间、模型、attempt、终态、PID／代码指纹、字段路径、无占位完整命令和非 CANCEL 正控。
- **C10 通过。** `HANDOVER.md:81,113-115` 准确列 explicit dispatch/session/GOAWAY/PING/local-abort 持久缺口；源码 `types.ts:122-128`、`dispatch-scheduler.ts:204`、`http2-client.ts:228-229,572,1059,1144-1149` 逐项支持。
- **C11 通过。** `HANDOVER.md:115` 的 peer/local 注入与 Node 官方 `Http2Stream.close(code)`／`destroy(error)` 契约相符，并要求两端 `rstCode`／事件序列校准，兼顾假绿与假红。
- **C12 未通过。** 仓库入口与 tmp provenance 的方向已正确，但 review 文件 commit 状态写错，见本轮第 1 条 major。
- **C13 未通过。** preflight 明确区分声明值与持有值（`KICKOFF.md:65`），但敏感值 digest 仍泄露稳定 verifier，见本轮第 3 条 major。
- **C14 通过。** `HANDOVER.md:119-123` 将所有统计字段置于采数前冻结门，值由计划／用户裁决而非交接发明，任一 TBD 阻断因果采数。

## 主观建议

未提出。

## 结构怪味与方法反思

- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:25` — **工作区存在性冒充 commit 可达性**；处置：本轮修，提交前后用 `git cat-file -e <commit>:<path>` 判定。
- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:66` — **章节编号漂移／执行顺序断裂**；处置：本轮修，指向 B.5.1→B.5.2。
- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:57-61` — **redaction 仍发布稳定 verifier**；处置：本轮修，只报告 presence 或进程内 same/different。
- **更好的内部替代：** Git 状态命题用对象数据库而非文件存在性；敏感配置比较用不暴露 digest 的进程内布尔比较；A4 继续复用 Node 原生 `http2`，无需自制协议层。
- **判据判别力：** 新样本、A4、预注册均有正负双控；本轮实际抓到“正确仓库入口仍因未提交 review 假绿”和“旧编号让正确顺序假红／漏步”。
- **第三方方案：** 无新增依赖需求；Git object oracle、Node `http2` 与标准统计预注册足够。
