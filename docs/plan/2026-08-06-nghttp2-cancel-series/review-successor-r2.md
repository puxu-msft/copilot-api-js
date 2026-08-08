# NGHTTP2_CANCEL 交接件接手方复评 R2

- **评审范围：** 只读复评 `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md` 与 `KICKOFF.md`；未重新考古四会话。
- **绑定证据：** `sha256sum` 得 HANDOVER `9e1c9f19b6a62dfb7932588f08da85cbc730464a86a6b82815eea9e2fa5a11f3`、KICKOFF `5dc58e4691a5536574cd4661d8590d605ff5df3f555017e23fa840b92ebc3a59`，与派发件一致；仓库内 canonical/supporting 文件存在性扫描全绿；逐项对账正式计划 A4／A5／Phase B。
- **总体 verdict：** 修复 major 后可定稿。
- **blocker 数量：** 0。**major 数量：** 4。

## S1～S10 走查

| 项 | 结论 | file:line／命令证据 |
|---|---|---|
| S1 | PASS | `KICKOFF.md:4` 与 `HANDOVER.md:10,25` 均以仓库文件为入口；`python3 Path.is_file()` 扫描列出的十个 canonical/supporting 文件全部为 `FILE`，job/transcript 明确只作 provenance。 |
| S2 | FAIL | `KICKOFF.md:10-63` 的 preflight 可复制且只做读取，覆盖 main HEAD／branch／status／worktree 与 PID／cwd／exe／cmdline／environ；但 `:30-32` 原样打印 argv，违反安全读取，且 packet 的目标树只核 HEAD、不核 branch/top-level/status/ancestry。 |
| S3 | FAIL | `KICKOFF.md:30-32` 的 `tr '\0' ' ' < /proc/$pid/cmdline` 会原样泄露命令行里的 `--token`、含 userinfo 的 proxy URL 或其他 credential；`:57-61` 只保护 environ，保护不到 argv。 |
| S4 | PASS | `KICKOFF.md:68-70` 明确 main 只调度、裁决、协调、精确提交和报告，调查／实现／验证／review 归 agents。 |
| S5 | FAIL | `KICKOFF.md:72-93` 有 A4 packet，但 canonical/progress/report 写死主 checkout，且 agent 首步只核 `BASE_FULL_SHA`，同 SHA 的错误树或带 peer WIP 的树仍可 false-green。 |
| S6 | FAIL | `KICKOFF.md:95-116` 预注册未闭合时不给 verdict；但没有填写“预注册 artifact”和实验数据的精确路径，verifier 无法从 packet 唯一定位被验证对象。 |
| S7 | PASS | `HANDOVER.md:111-123` 只保留 A4 目标／缺口／验收边界与 Phase B gate，完整 schema、ownership、矩阵和裁决均指向正式计划；`:115` 的 RST 注入校准是窄验收边界，不是完整机制副本。 |
| S8 | FAIL | `HANDOVER.md:83-88,107-109` 只读定位稳定 ID 且禁止碰 4141，但要求“至少一条新 CANCEL”才进入实现；没有自然新样本时，正确的 A4 实现也被永久挡住，且 KICKOFF 没有该调查 agent 的可复制 packet。 |
| S9 | PASS | A3 六项在 `HANDOVER.md:42-53`，文档／skill gate 在 `:55-64`，A4 与 Phase B 在 `:105-123`；`KICKOFF.md:66,87-92,109-115` 明确分流，未混写成 CANCEL 已修。 |
| S10 | FAIL | `HANDOVER.md:109` 把“新 CANCEL 可复验”设为进入实现的必要条件；这是 false-red gate。A4 可由确定性 h2c 双控开工，新自然样本只应阻断 Phase B 因果裁决。 |

## 首轮 5 major 处置

1. **CLOSED** — 临时 job HANDOVER／supporting 入口已收敛到仓库内文件，见 `KICKOFF.md:4`、`HANDOVER.md:10,25`。
2. **OPEN** — 主 preflight 已大幅补齐，但 raw cmdline 泄密，目标 worktree 身份／WIP gate 仍不完整，见下列 finding 1、2。
3. **OPEN** — 已有两个实例 packet，但 A4 写路径指向错误 checkout，Phase B 缺被验证 artifact 路径，见 finding 2、3。
4. **CLOSED** — agent-driven 职责与 main 会话边界已明确，见 `KICKOFF.md:68-70`。
5. **CLOSED** — HANDOVER 已删除步骤级 A4／Phase B 副本并改为正式计划指针，见 `HANDOVER.md:111-123`。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:30-32,57-61` — preflight 原样打印 `/proc/$pid/cmdline`，environ 的 redaction 不覆盖 argv。
接手者会因此把命令行中的 token、proxy userinfo 或 credential 原值写入终端记录／交接证据。
证据：命令为 `tr '\0' ' ' < "/proc/$pid/cmdline"`；敏感匹配仅遍历 `items` 环境变量。
修复建议：argv 只输出参数名与经过 allowlist 的身份参数；其余值统一 `<redacted>` 或只记整段 digest，禁止低熵 secret 的逐值 digest。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:77-92,100-115` — 两个 packet 绑定隔离 `WORKTREE`，却把 progress/report 及 canonical 路径写死到共享主 checkout；A4 首步也只比较 HEAD。
接手者会因此让隔离 agent 向主树写报告，或在同 SHA 的错误树／带 peer WIP 的树上实施，BASE gate 仍假绿。
证据：`:89,111,115` 均为 `/home/xp/src/copilot-api-js/...`；`:85` 无 top-level／branch／status／ancestry 检查。
修复建议：派发前把所有读写路径实例化为 `$WORKTREE` 下绝对路径，并加入打印后校验 top-level、branch、HEAD、clean/已归属 WIP、base ancestry 的同调用 gate。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:101-115`、`HANDOVER.md:117-123` — Phase B verifier packet 没有预注册 artifact 与实验数据的精确路径。
接手者会因此猜测要验哪份预注册／哪批数据，可能验错轮次后给出因果 verdict，或因找不到对象而误判 gate 永远不能满足。
证据：packet 只写“预注册／实验产物只读”和报告路径；HANDOVER 也未定义 artifact 路径或命名规则。
修复建议：先在正式计划确定唯一预注册目录／文件和每轮数据 manifest 路径；packet 填入冻结 hash、full SHA、数据根与轮次 ID，缺任一项即只报 gate 未满足。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:83-88,107-109`、`KICKOFF.md:68-70` — “至少一条新 CANCEL”被设为 A4 实现前置，且该首项调查没有 agent packet。
接手者会因此在当前没有自然 CANCEL 时永久不做 A4，或由 main 亲自调查，违反 agent-driven 分工；这是正确状态也过不了的 false-red。
证据：`:109` 明写样本不可复验即“不进入实现或实验”；正式计划 A4 可由本地 h2c 双控实施，不依赖先有新生产样本。
修复建议：新稳定样本仅作为 Phase B 因果裁决前置；A4 允许在 Git/WIP 身份闭合后先做。另补只读 evidence agent packet，禁止主动制造 4141 流量、重启或写 History。

## 双方向结论

- **false-green：** 同 SHA 的错误 worktree、含 peer WIP 的目标树可通过当前 BASE gate；未绑定 artifact 的 verifier 可能验证错误轮次。
- **false-red：** 没有自然产生的新 CANCEL 时，当前 gate 会阻断本可由确定性 h2c oracle 正确实施的 A4。

## 结构怪味扫描

- `KICKOFF.md:77-115` — **隔离边界与绝对路径冲突**；处置：本轮 major，所有 packet 路径同源于现场 `WORKTREE`。
- `HANDOVER.md:83-109` — **证据积累 gate 错置到诊断实现之前**；处置：本轮 major，移动到 Phase B verdict 门。
- 除上述两处，未发现 A3／文档 skill／A4／Phase B 的范围合并或静默删除。
