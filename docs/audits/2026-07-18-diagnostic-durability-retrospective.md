# Diagnostic durability 迭代复盘

日期：2026-07-18

范围：从“Ctrl+C 后停在 `History and telemetry barriers completed`”的生产故障取证，到 diagnostic durability 架构重构、测试分层重建和主树集成。

## 可量化事实

VS Code debug log 的 `session_start` 是 `2026-07-18T09:01:27.921Z`；local session store 的 turn completion 时间分别是 `09:20:44.802Z` 和 `15:52:38.207Z`，且 Git 提交 `b20b4948`、`ee09c09a`、`ca92029e` 分别发生在 `09:20:01Z`、`15:34:13Z`、`15:44:03Z`。因此可以交叉验证：

- 初始取证、局部 patch、测试和首轮交付约 **19 分 17 秒**。
- 用户否定 patch 后，到完整架构重构与合并态交付约 **6 小时 31 分 53 秒**。
- 从局部 patch 到架构重构提交，代码差异扩展为 31 个文件、`+2165/-237`；这不是可取的常规 bugfix 规模，而是原计划未落地的 durability 子系统补建。

这些数字是 turn 墙钟跨度，不等于纯模型或工具执行时间。VS Code debug log 除 `session_start` 外没有保留可供 SAT 脚本解析的模型/工具 span，无法可靠拆分模型生成、工具执行、等待和人类空闲，所以不伪造更细的比例。

第一轮最终交付是 `b20b4948`：把重复 flush 直接放进 `StructuredFileSink`，并用单个 250ms integration test 覆盖第三方行为、项目 primitive、sink 和 shutdown。它抓到了直接症状，却没有实现冻结 RFC 已要求的独立 durable writer，也没有覆盖生产 `activeSink` seam、Diagnostic barrier、真实进程退出和 crash recovery。首轮 19 分钟得到了正确直接根因，但形成了错误长期形状；后续 6.5 小时中相当一部分用于拆除该形状、重建缺失模块，并在多轮对抗审查中逐个补齐本应前置枚举的 failure matrix。并非 6.5 小时全部浪费——其中大量探针和审查找到了真实缺陷——但串行发现缺陷显著放大了上下文重建和返工成本。

## 哪些工作浪费了时间

| 浪费 | 根因 | 以后应如何避免 |
|---|---|---|
| 在 `StructuredFileSink` 内修 flush 循环 | 开始实现前没有对照 RFC/plan 做“承诺模块是否真的存在”的机械审计；计划明确写了 `durable-writer.ts`，实现却缺失 | 先做 spec→code inventory，逐项标记 present / missing / misplaced，再决定修改位置 |
| 用 250ms 测试同时证明四层行为 | 没按真相域拆测试；墙钟只证明“这台机器此刻没超时”，不能证明首次 flush 确实提前、tail 确实存在、fsync 确实发生 | 固定使用 backend contract→primitive unit→sink integration→production seam→PTY process 五层矩阵 |
| 初次 review 给出“无 blocker/major”后直接结束 | reviewer 只审局部 diff，没有从冻结 RFC 独立推导全协议，也没有探测 production cutover/shutdown seam | reviewer prompt 必须要求从 spec 独立推导 oracle、运行最小证伪探针，并检查 merged production wiring |
| 多轮串行暴露 cutover、claim、ledger、rotation、bus failure 等问题 | 缺少一张前置 failure matrix；每轮只修上一轮刚发现的边界 | 在编码前列出 normal / concurrent / crash-before-commit / crash-after-commit / retry / corrupt / dependency-upgrade / shutdown-race 矩阵 |
| “multiprocess rotation exactly-once”长期假绿 | `pino-roll` 数值 `size` 的单位是 MiB，而项目传的是 bytes；测试没有先证明 segment 数确实大于 1；`Set` 又吞掉重复 | 第三方 adapter 必须有能力正样本；测试先断言目标路径被触发，再断言结果；exactly-once 用计数多重集 |
| Shutdown unit 标题强于 oracle | `createNoopDeps()` 未注入 Diagnostic barrier，生产默认又因没有 active sink 退化为 no-op | 每个 durability barrier 都必须有 controllable latch；生产 facade 另做真实 attach→shutdown integration |
| 多个 subagent 重复读取同一大 RFC、sink 和 shutdown 文件 | 角色上下文每轮重建，且前一轮没有留下结构化 invariant/failure matrix | 主会话先产出一页共享审计输入，后续 reviewer 只验证增量和未闭环项；高风险复审继续保留，不应取消 |
| 在巨型 `DESIGN.md` 一行里承载过多运行协议 | 事实可搜索但难以建立完整状态机，且并发会话频繁冲突 | `DESIGN.md` 只保目录级关系和指针；操作性协议放项目 skill，冻结意图保留 RFC，生命周期只写跨子系统顺序 |
| 最后集成时 stash/pop 产生文档冲突 | 主树存在并发未提交 docs，功能分支也修改同一巨型架构行 | 复杂功能从一开始使用独立 worktree；模块细节尽量落独立 skill/doc，减少所有特性都修改同一超长行 |

## 哪些工作不是浪费

以下步骤耗时，但提供了不可替代的独立证据，不应为了“提速”删除：

- 从生产 per-process NDJSON 发现缺少 `shutdown.persistence-ready` 和 sealing marker，确定卡点在 Diagnostic barrier，而不是 History、Telemetry 或 WS。
- 直接运行 Bun/Node SonicBoom 探针，证明第一次 flush callback 返回时仍有 4 bytes tail；这推翻了纯源码推断的不确定性。
- 三项 mutation：删除重复 flush、删除 `await closeDiagnostics()`、删除 `activeSink` 注册，分别证明新 oracle 真能变红。
- 真前台 PTY 测试，验证单 SIGINT 成功路径 exit 0、Diagnostic drop 失败路径 exit 1、第二 SIGINT exit 130。
- 多轮异模型对抗审查。它们暴露了 size 单位、Pino 默认 level、cutover 所有权、crash idempotency、claim、semantic corruption、bus failure 等真实缺陷；问题是审查启动太晚且输入不够结构化，不是审查本身多余。

## 已落地的长期改进

### 模块边界

- `CountingDestination`：只负责 accepted / settled / queued / written / dropped 字节记账和 sticky failure，不读取 SonicBoom 私有字段。
- `DurableFileWriter`：单一拥有 generation checkpoint、strict progress、roll path/segment 稳定、文件和父目录 fsync、marker、end/close 状态机。
- `StructuredFileSink`：只负责 bus/Pino/record 映射、file threshold 和受控 maintenance；不再实现 flush/fsync 协议。
- `BootstrapDiagnosticSpool`：全会话 WAL 的唯一 bus owner；每条记录 WAL-first，再用 `(spoolId, sequence, digest)` mirror 到长期 sink。
- diagnostics file facade：generation-keyed lifecycle queue 串行 attach/disable/shutdown，生产 `activeSink` 不再是未测试的隐式全局。

### 测试分层

1. 第三方 backend contract：Bun/Node 真 SonicBoom early flush 正样本。
2. Primitive unit：受控 destination 精确验证 generation、strict progress、fsync、marker、close 和 failure。
3. Sink integration：Pino level、NDJSON 联合、权限、drop 和 model catalog。
4. Production seam：WAL replay、delivery digest、atomic claim、corrupt isolation、cutover failure、shutdown generation、真实 rotation。
5. Process oracle：PTY SIGINT 成功、失败和第二信号。

### 文档路由

- 冻结设计意图：`docs/rfc/2026-07-17-tui-structured-logging.md`。
- 当前跨模块关系：`docs/DESIGN.md`。
- Shutdown 跨子系统顺序：`docs/lifecycle.md`。
- 可执行维护知识和测试矩阵：项目 skill `diagnostic-durability`。
- 本次工作流教训：本文。

## 未来修改前的固定门禁

1. 先读 diagnostic durability skill、RFC §7.2/§7.4 和 `docs/lifecycle.md`，不要从 `StructuredFileSink` 单文件反推整个协议。
2. 写出 producer ownership、durable unit、commit point、crash recovery identity 和 shutdown barrier；任何一个答不出，先不编码。
3. 对第三方依赖先做真 backend probe，特别核对单位、默认 level、callback 时机、rotation/reopen 和运行时差异。
4. 每条测试只证明一个真相域；标题必须与 oracle 等强。
5. 所有“exactly-once”“rotation”“flush completed”“production wired”结论都先加正样本证明目标路径被触发。
6. 完成后做 merged-state review，而不是只审新增 primitive；至少覆盖 attach→live traffic→shutdown、partial replay→crash→restart、failure→retry、shutdown×attach 四条全路径。

具体模块不变量、测试入口和验证命令见项目 skill `diagnostic-durability`；本文只保留时间归因与工作流教训，不复制操作手册。
