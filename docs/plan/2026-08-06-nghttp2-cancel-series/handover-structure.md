# NGHTTP2 系列 HANDOVER / KICKOFF 结构建议

## 目录
- `docs/plan/2026-08-06-nghttp2-series/HANDOVER.md`：接手事实、理由、证据、未决项的唯一入口。
- `docs/plan/2026-08-06-nghttp2-series/KICKOFF.md`：可复制启动提示词；只重复硬 gate、接手第一步和 HANDOVER 指针。
- 既有 `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md`：计划与阶段契约 SSOT；HANDOVER 不复述其方案正文。

## HANDOVER.md 章节骨架
### 0. 状态头
写明状态、核验时间、核验 HEAD、分支/worktree、与 master 的 ancestry、dirty/staged/untracked 归属、已跑门禁及未跑项；所有运行态数字标“易腐，接手时重取”。
### 1. 入口与阅读顺序
先读本文件，再读计划的“实施状态”、A4、Phase B；按需读 `docs/DESIGN.md` 活架构与 transport/history SSOT，禁止把这些正文复制进交接。
### 2. A：偏离 NGHTTP2 主线但已完成的内容状态
只列 History A1/A2/A3：语义单元、状态（代码完成/评审完成/合并状态）、commit 区间、所在分支、产物路径、验证命令与结果、未完成交付门、它没有证明什么。
每项事实字段固定为：`claim`、`scope`、`baseline SHA`、`observedAt`、`evidenceType`、`evidence`、`freshness`、`supersedes/conflicts`、`disposition`。
把真实大库验收、独立 review/verifier、A1 最终 002 收敛等未闭合项单列，不得用“完成”包住；未知值写 `TBD（由谁、用什么命令补）`。
### 3. A 的产物与分支账
表列 commit、分支、是否已进 master、对应 docs/code/tests；验收是 `git merge-base --is-ancestor <sha> master`，证伪是任一声称 landed 的 commit 不在 master ancestry。
### 4. B：回归 NGHTTP2_CANCEL 主线——已知事实
只记当前仍成立的观测，不重做根因叙事；每条加“回答哪个问题/不回答哪个问题”。
事实字段固定为：`claim`、`population/window`、`runtime identity`、`HEAD/config`、`probe/query`、`raw artifact`、`cross-check`、`confidence`、`expiry trigger`、`SSOT pointer`。
数字属于易腐状态：失败率、样本数、数据库行数/体积、延迟、当前运行实例 PID/代码身份；不得从旧文档抄成当前值。
不能复述的 SSOT：计划的 A4 schema/Phase B 裁决规则、`docs/DESIGN.md` 活路径、`docs/API.md` 端点字段、History schema 文档、ADR 决策理由；这里只放深链接与冲突说明。
### 5. B：未决线索
每条按“观察→候选解释→支持证据→反证/替代解释→缺失观测→下一最小实验”写；PING、TCP keepalive、event-loop starvation、peer RST、session GOAWAY/close、local abort、clean EOF 分开，禁止提前合并成单一根因。
### 6. B：下一步
B1 接手先验证工作树与运行代码身份；B2 对账 A4 是否已落地并能把 stream/session/local-abort 归到 explicit dispatch；未落地则先执行 A4，已落地且有样本才进入 Phase B。
每项下一步固定五栏：动作、前置 gate、验收、正控/反控、证伪；实验产物落 `exp/nghttp2-cancel/` 并写“它没有证明什么”。
### 7. 环境、禁区与易腐状态复验表
逐项列复验命令、期望输出、失败时停止条件；任何真实 4141 迁移、重启、备份覆盖或维护窗口标“需用户明确授权”。
### 8. 对账与遗留欠账
列“文档说 X / 当前证据 Y / 证据位置 / 已改文档或待决”；TBD：最终 commit、分支合并态、最新运行样本、A3 review/verifier 结论、A4 实施态。

## KICKOFF.md 必须逐字重复的 gates
- **绝不停止、重启或 kill 4141 端口的用户主服务器；测试服务器只能使用非 4141 端口，并只按 PID 清理自己启动的实例。**
- **接手第一步先验证“正在观测的运行代码就是目标代码”：记录 PID/InvocationID、进程持有的配置与可核对的 commit/build 指纹；`is-active`、配置文件或文档声明不能替代运行态身份。**
- **先刷新 HEAD、分支/worktree、master ancestry 与工作区归属；不得采信 HANDOVER 中的易腐状态或碰 peer 的未提交改动。**
- **A4 canonical diagnostics 未证明可按 explicit dispatch 区分 stream/session/local-abort 前，不进入 Phase B，不把 PING cadence 或 generic `NGHTTP2_CANCEL` retry 当修复。**
- **真实迁移、主库写入、备份覆盖和维护窗口未经用户逐项授权不得执行；性能/迁移实验只用临时数据库副本。**
- **关键 gate 必须有正确样本与目标缺陷 mutation；绿色结果若未证明命中目标路径，不得作为完成证据。**

## KICKOFF.md 接手第一步
执行并记录：仓库 HEAD/branch/status/ancestry → 目标 worktree HEAD → 运行实例身份与代码指纹 → 对照 HANDOVER §2/§4 的基线；任一不一致先更新交接事实，不继续诊断。随后只从 HANDOVER §6 的首个未闭合且前置已满足的任务开工。
