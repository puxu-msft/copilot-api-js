# NGHTTP2_CANCEL 交接件接手方评审

- **评审范围：** `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md`、`HANDOVER.md`，并对账同目录六份 Supporting evidence、原实施计划、指定 session/job/tasks 坐标与 Git refs。未重扫 history；前两会话只采信 `session-inventory.md`。
- **已读取／执行的证据：** 先按要求单读 KICKOFF，再读 HANDOVER；核验所有文件和 174f2b81／2684f077 坐标存在；读取两组 job/tasks；核对 `refs/heads/master=0840b929b0d0494b64c2a9ec532d0e859b159d14`、`17a7f612..master` 只有交接提交；确认 job tmp HANDOVER 与仓库 HANDOVER 当前逐字相同；对账计划 A4、Phase B、独立 review/verifier 条款。
- **总体 verdict：** 修复 major 后可进入下一阶段。
- **blocker 数量：** 0。**major 数量：** 5。

## 第一人称接手走查

我能从 KICKOFF 直接回答“先读什么”和“绝不能做什么”，也能明确不得重考古四会话、不得重做 A1–A3 核账、不得碰 4141。可是我不能从交接件唯一确定 A4 要在哪个新 worktree 开工、第一批具体派哪些 agents、可直接复制的首个 dispatch packet 是什么；所谓“第一步命令”也不足以完成它自己要求的运行身份与 WIP 归属 gate。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:5,20`、`HANDOVER.md:25` — KICKOFF 把 job tmp 当首要 HANDOVER，并把 `17a7f612` 称为当前成稿基线；Supporting evidence 又写成“后续建议归档”，但两类产物均已在 `master@0840b929` 落入同目录。
接手者会因此读取可消失／可漂移的临时副本、重复归档已经归档的报告，或只裁 `fa2bfd2d..17a7f612` 后忽略基线之后的新提交。
证据：当前 tmp 与仓库 HANDOVER 虽 `cmp` 相同，但 `17a7f612..refs/heads/master` 已有 `0840b929 docs(handover)`；同目录六份报告均存在。
修复建议：KICKOFF 只指向同目录 `HANDOVER.md`；Supporting evidence 只指向同目录文件，把 job tmp 降为历史来源；把 `17a7f612` 明称“写作观察基线”，接手 gate 固定比较“该基线..现场 master”。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:11-17`、`HANDOVER.md:102-120` — 标为“第一步运行并记录”的命令没有完成同文要求的 ancestry、目标 worktree WIP 归属和运行代码身份核验。
接手者会因此把 `ss` 给出的 listener PID 加主树 HEAD 误当“4141 正在运行目标字节”，或在未检查 `nghttp2-resume`／新目标树 dirty hunks 的情况下开工，采信陈旧运行态或覆盖 peer WIP。
证据：命令块只有主树 status/worktree list/log 与 `ss`；没有目标树 `rev-parse/status`、branch-tip ancestry、`/proc/<pid>/{cmdline,cwd,cgroup}`、进程持有配置或 History/build 指纹查询。
修复建议：给出可复制的完整只读 gate 和明确 stop condition；先定义目标树，再核其 HEAD/status/ancestry；从 `ss` 提取 PID 后核 `/proc` 与运行指纹，`gitDirty=true` 或归属未知即不得把 commit tree 当运行字节，也不得开始编辑。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:24`、`KICKOFF.md:22` — “Agent dispatch packet”只是字段清单，不是当前 A4 可直接复制的 dispatch packet；目标 worktree／branch、base／target、允许写路径和各报告路径均未实例化。
接手者会因此把实现派到主树或陈旧 `nghttp2-resume`，让 mutation 落在共享 WIP 上，或因收到四份 transcript 路径而重新考古已禁止重查的会话。
证据：文档只要求缺值写 `TBD`，没有 A4 的填好模板；现有 `nghttp2-resume@c23ed804` 仅被描述为历史承接树，未被裁定为下一实现树。
修复建议：新增首个 A4 dispatch 的完整可粘贴块；动态 SHA 可写取值命令，但 tree/branch、agent cwd/isolation、允许写路径、报告路径必须确定；174f2b81／2684f077 只在确需续接时提供，前两会话只给 `session-inventory.md`，明确禁止打开其 transcript。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:5,22`、`HANDOVER.md:122-140` — 编排权归属明确，但流程并非明确的 agent-driven 编排：没有指定谁实施 A4、何时派 reviewer/verifier、谁做 merged-state review；正文直接对接手主会话下达“实施 A4”。
接手者会因此由 coordinator 亲自实现长时多语义 A4，遗漏 implementer 派活前进度文件，或只在实现结束后临时找一个 reviewer，把 verifier／合并态 review 当可选项。
证据：原计划 `history-read-path-and-h2-diagnostics.md:183-184` 明确独立 reviewer、verifier、复评与 merged-state review；交接只在 A4 完成段笼统写“由独立 reviewer/verifier”。
修复建议：写出固定序列：主会话刷新事实并建立隔离树／进度文件 → `gpt-souls:implementer` 执行 A4 → 独立 reviewer 与 verifier 双向验收 → 原 reviewer 复评 → merged-state reviewer；主会话只调度、核证、处置和集成。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:122-152` — HANDOVER 声称实施计划是阶段契约 SSOT，却复制了 A4 schema/ownership/settle 机制、验收细节和 Phase B 实验顺序，形成第二份会漂移的执行契约。
接手者会因此在计划后来修订时仍按 HANDOVER 的压缩版本实现，漏掉计划中的契约，或把 HANDOVER 与计划差异误判成新的设计分叉并重复探索。
证据：Supporting `handover-structure.md:20-27` 明确禁止复述 A4 schema 与 Phase B 裁决规则，只允许深链接和冲突说明；当前 B.4.2～B.4.4 大段复写这些内容。
修复建议：HANDOVER 只保留“当前未实施／前置 gate／产物位置／与计划冲突或偏离／首个未闭合任务”，将机制、完整验收和实验矩阵改为计划章节锚点；KICKOFF 继续强制先读计划原文。

## 结构怪味扫描

- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:5-22` — **易变状态双源＋临时路径冒充 SSOT**；处置：本轮列为 major，必须改为仓库相对入口与现场差量 gate。
- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:24` — **dispatch schema 代替 dispatch instance**；处置：本轮列为 major，补 A4 可复制实例。
- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:122-152` — **交接文档复制计划契约造成职责错位**；处置：本轮列为 major，收敛为状态／差异／指针。

## 主观建议

未提出；以上均会直接改变接手动作，属于事实性可执行性缺陷。