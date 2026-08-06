# Kick-off：Commit 1 —— Capability types 与 profile registry 准备

<!-- prompt-task-ids: T1.1 T1.2 T1.3 T1.4 T1.5 T1.6 T1.7 -->

## 背景 + 为什么

Commit 1 是无行为准备：建立 profile discriminant、capability-shaped port 的 compile-time 边界、classifier 三态与 envelope/result 类型。它的价值是让 non-Anthropic 在类型层拿不到 indexed commands，而不是 runtime 才报不支持。

## 必读

- `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`：§2.6、§3.1～§3.7、§7.4、§9.3 #1/#2、§10.2 R-2/R-6。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`：§0.3/§0.4/§0.4d、Commit 1、§11 #5/#6。
- `docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md`：R-2、R-6、调查缝 #1/#2、T1.* 反向出处。
- `docs/tmp/2026-08-05-command-algebra-progress-prompts.md` 与 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。

## 前置/停点

- Commit 0 已收口；A/B/C/D population 与属性存在性快照是本 commit 的越界基线。
- §11 #5/#6 未裁则 Commit 1 不得开工；特别是 T1.6 写 terminal result 类型前必须先裁 #6。
- §9.3 #1/#2 在此只取最小子集，完整证据归 Commit 4 kickoff；不可借此现场编 factory/runner 签名。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| `ClientFormat` | `src/lib/pipeline/envelope.ts:21` | profile discriminant |
| `FormatCodec` | `src/lib/pipeline/types.ts:948` | delivery 只消费窄 format knowledge |
| `DeliveryTerminalCommand` | `src/lib/pipeline/delivery/types.ts:69` | 迁移输入，非终态签名 |
| `OwnerTerminalDecision` | `src/lib/pipeline/delivery/owner-failure.ts:11-14` | T1.6/#6 的正交轴前置 |
| `ClientBlockLedger` | `src/lib/pipeline/delivery/types.ts:37` | observation 对照 |

完整锚点以 plan Commit 1 表为准。

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T1.1 T1.2 T1.3 T1.4 T1.5 T1.6 T1.7 -->

| Task | TDD 施工顺序 |
|---|---|
| `T1.1` | 先写各 profile common/indexed 正样本 compile fixture 红，再实现 discriminated profiles，转绿。 |
| `T1.2` | 先写 non-Anthropic 引 indexed method 的 `@ts-expect-error` 负样本，移注解须 compile-red；再实现条件 port。 |
| `T1.3` | 退化 factory 到大接口必须让 fixture 红；保留 union-profile 反例 compile-red。 |
| `T1.4` | classifier parse-failure/mismatch/unknown 三态；未知 effect 默认允许，先把它错误写成拒绝证红。 |
| `T1.5` | envelope/result/compatibility registry 的最小性质；不决定 payload 内部形状。 |
| `T1.6` | #6 已裁后才写 terminal result/type exhaustiveness；不把 OwnerCommandFailureDisposition 与 terminate result 混成一个轴。 |
| `T1.7` | 运行属性存在性快照，先加 optional method 证红，再要求相等。 |

判据细节、mutation/false-red 唯一事实源仍是 RFC §10.2 与 plan Commit 1。

## 验收 gate

- R-6 C1 auxiliary、R-2 C1 auxiliary、R-11/O-6，共同门按 plan §0.3/§0.4b。
- 准备 commit invariant：旧 API population 与 C0 机械相等、无 production call-site 切换、属性存在性解析不变、新代码仅 compile/direct unit 可达。

## 提交指引

精确 pathspec、Conventional Commit、无模型署名、绝不 push；更新本执行者 progress 文件并与本 semantic commit 一起提交。

## 红线

集中红线见 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。不创建 production owner、不注册 timer/sampling、不接 outer roots；不以 `as` 绕 capability 门；不自行裁 #5/#6。