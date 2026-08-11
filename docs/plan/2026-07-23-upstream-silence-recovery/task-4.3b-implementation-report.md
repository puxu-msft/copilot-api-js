# Task 4.3b direct Anthropic B2 实施报告

状态：**direct Anthropic live B2 已实现、评审、验证并本地集成至 `master@04d7a144`；未 push。** 实现基线始于 `dd79edb3`（其父 `84a84bf5` 完成 evaluator discriminant guard，`aa2620db` 修复 ready-live clean EOF），C5 验证提交至 `7e6d06f6`，合并态补漏提交为 `a6eeebc1`，二次吸收最新 master 的整合提交为 `04d7a144`。本报告只覆盖 `/v1/messages` 的 direct Anthropic live B2；buffered B2 与 translated publication 仍未实现、保持 fail-closed，见 [deferred backlog](../../todo/deferred-backlog.md)。

## 已实现合同

- 两个 live mount：delayed-commit 的 pre-ready failure，以及 ready-live 的 `stream-error-before-content`／clean EOF before `message_stop`。只有 deterministic HTTP/网络上游死亡且 delivery 尚未写出真实语义内容时，才发起一次 fresh R；所有 abort provenance 都拒绝 replay。
- R 先在无 client-wire、winner、terminal authority 的 evaluator collector 中运行。仅 `complete` R 能进入 delivery owner 的 C9 batch publication；upstream error、truncation、refusal、unrepairable tool input、settled abort、delivery finished 与 unexpected throw 一律 discard，P 保持 terminal。
- owner batch 负责三个 keepalive contract：`ping` 直通；`enveloped_ping` 去重 duplicate `message_start`；`empty_text` 先 close anchor，再将 real R block index +1 remap。`commit-failed` 保持完整 R wire，pin R dispatch 而不伪造 winner；`wire-torn` 只在完成允许的 owner settlement 后唯一 `ctx.fail`。
- `RecoverySinkSupervisor.settleFinal()` 与两个 owner outer `finally` 是唯一真实 finalizer authority。History canonical projection 读取 pinned terminal attempt，不能退回最后 active R。

## 提交锚点

| 范围 | 提交 |
|---|---|
| evaluator／settlement 基线 | `963f3fbc`、`7b784d52`、`2a64acf0`、`7584c48c` |
| owner batch、C9 与 finalization | `dc7fd984`、`479d83f0`、`0d493a85`、`e247c08f`、`b2b9bc17`、`298b48fc`、`7132908a` |
| Task 5 matrix、abort、budget | `b37acc47`、`571cafae`、`37b76b9c`、`533e5bd1`、`24725d6e`、`e40424df` |
| SDK、empty anchor、clean EOF | `a2f4a740`、`14a3884f`、`aa2620db`、`8b55e072` |
| backend recovery hardening | `25a0fad0`、`fd7c7a09`、`1cacbea9`、`84a84bf5` |
| C4 History V2/V3 integrated oracle 与 initial R strategy | `dd79edb3` |
| C5 mutation evidence 与 post-C9 fallback oracle | `328ea295`、`9d4ccfc1`、`7e6d06f6` |
| 合并态补漏与最终集成 | `a6eeebc1`（补漏）→ `04d7a144`（吸收 `master@16b2b7fe` 并本地 fast-forward） |

## 可复现验证

以下命令都以本报告基线的 worktree 为对象；后续提交须重新运行，不得把历史绿当作当前绿。

```sh
bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts
bun test tests/e2e-client/precontent-recovery.it.test.ts
bun test tests/context/request-context.unit.test.ts
bun run typecheck
```

focused matrix、SDK 与 context oracle 在实现期均以退出码 0 验证。`dd79edb3` 后重新运行 `bun run typecheck`、matrix＋coordinator focused suites（54 pass，0 fail）、C4 dual-read oracle（2 pass，0 fail）与受影响文件 eslint。clean EOF SDK case `ready-live clean EOF before semantic content recovers one coherent SDK message` 连续运行 10 次均退出码 0。

交付前在 `7e6d06f6` 上第二次执行 `bun run test:backend`，退出 0、汇总显示 6276 pass／0 fail；项目已知 `parallel-test.ts` 汇总会漂移，因此该数字不作为精确测试计数，结论只使用退出码与 0 fail。第一次同门在该验证序列中显示 6561 pass／1 fail，失败为 History capture-performance ratio 8.816；该单测随后连续 10 次通过，第二次全 backend 亦为 0 fail。Task 5 coverage review、clean EOF verifier、code／doc／merged-state reviews 均已通过。

最新 master 集成链又执行了两道全 backend gate：`a6eeebc1` 合并态为 5705 pass／0 fail；二次吸收 `master@16b2b7fe` 后的 `04d7a144` 为 6039 pass／0 fail，且 typecheck 退出 0。共享 master 在 feature 63 路径与 15 条 peer dirty／untracked 路径碰撞集为 0 后，`git merge --ff-only` 到 `04d7a144`；随后在 master 上 typecheck 与 63 条关键测试通过。所有提交均为本地提交，未 push。

## 2026-08-08 最新 master 合并态审计补漏

独立 merged-state reviewer 在 feature 吸收 `master@03c3dd13` 后提出三项承重发现，主会话逐条以冻结 spec、父分支归属和红色探针复核，三项均确认并修复：

- bundled `config.yaml` 仍以 600/1200s wall-clock terminator 终止可能合法长思考，违背计划 Global Constraints。现将 `response_header`、`stream_idle`、`stale_request_max_age`、`request_deadline` 及内置 per-model override 全部改为 `0`；新增配置 guard，正值改为显式 bounded-wait override 并告警。
- primary 已成功写出真实 `content_block_start`、delta 尚未到时，旧 gate 仍为 false，clean EOF 会发 R 并制造两个并列 open block。现由 delivery owner 在任一非 synthetic Anthropic real block start 或 client-format real content frame 成功写出后关闭 B2 gate；text/tool 两种真实 handler 红绿样本均锁住 `calls===1`。
- isolated fixture 只清 History Worker registry pointer，不 shutdown 所有的 runtime。现新增 async owning reset，先等待 `runtime.shutdown()`，只在仍指向同一 runtime 时清 pointer；fixture 串行 await 该 reset，guard 将 injector setter明确路由到 owning reset。

focused 验证：open-block 2 pass／0 fail；History lifecycle 31 pass／0 fail；timeout config 最终 16 pass／0 fail；recovery delivery 12 pass／0 fail；Chat Completions 配置隔离 14 pass／0 fail；typecheck exit 0。复评新增的 per-model bounded-wait 告警与 DESIGN 当前默认值两项也已修复；同一 reviewer 最终给出 0 blocker／0 major。

## Mutation controls

已执行项目遵循同一流程：从已包含真实实现的 commit 生成仅描述目标变换的 exact patch，先 `git apply --reverse --check <patch>`，应用 patch，执行具名 oracle 取得目标红，再对同一 patch `git apply --reverse` 并执行 restore-green command。临时 patch 不作为仓库长期资产；本表保存变换、红色失配、恢复门与代码锚点。C5 mutation evidence 已闭合；abort 组合未实际达到 B2 seam，明确作为 reachability 事实记录，而非伪称 red success。

| 机制／精确变换 | 具名 oracle | 实测 red evidence | restore-green command | commit anchor |
|---|---|---|---|---|
| C9 移动：将 recovery batch C9 移到 first write 后 | `first recovery batch write client abort is committed and finalizes delivery` | C5 exact patch；expected `{ committed:true }`，actual `{ committed:false }`；1 fail | `bun test tests/pipeline/recovery-batch-publication.it.test.ts --test-name-pattern='first recovery batch write client abort is committed and finalizes delivery'` | `b0b26abd` |
| 删除 wire-torn frontier：在 committed `writeCommittedBatch` failure 后不置 `wireTorn` | `first non-client recovery batch write tears the frontier while terminal error and finalization remain available`；`Nth non-client recovery batch write leaves only the written prefix and tears the wire` | C5 exact patch；expected `{ reason:"wire-torn" }`，actual first case `beginLeg` 返回 `{ ok:true, value:"primary:…" }`，Nth case publish 返回 `{ ok:true, value:"published" }`；2 fail | `bun test tests/pipeline/recovery-batch-publication.it.test.ts --test-name-pattern='first non-client recovery batch write tears|Nth non-client recovery batch write leaves'` | `b0b26abd` |
| anchor-kind 位置：将 owner `closeOpenAnchorBefore` 停止帧从 batch first spec 移到 R real frame 后 | `pre-ready mode=empty_text emits the recovery success wire contract` | expected `stop@0` index < real R block start；actual stop index 6 > start index 4，matrix order oracle 红；SDK 本身容忍该坏 wire | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='pre-ready mode=empty_text'` | `14a3884f`、`1cacbea9` |
| heartbeat resume/order：删除 `evaluateAndPublishDirectAnthropicRecovery` 开始处的 `resumeHeartbeat?.()` | `ready-live recovery resumes the suspended heartbeat while evaluation waits, then publishes its batch without interleaving` | C5 exact patch；expected ping length 1，actual length 0；1 fail | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='ready-live recovery resumes the suspended heartbeat while evaluation waits, then publishes its batch without interleaving'` | `b0b26abd` |
| publication commit 提前：把 `evaluation.disposition.commit()` 从 publication success 后移到 `publishRecoveryBatch` 前 | `pre-C9 recovery publication rejection discards R and retains the primary terminal` | C5 exact patch；expected R `candidateVerdict`／`dispatchVerdict` 均为 `failed`，actual `winner`／`committed`；1 fail，且 evaluator cleanup 报 disposition already committed | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='pre-C9 recovery publication rejection discards R and retains the primary terminal'` | `328ea295` |
| post-C9 fallback：跳过 `wire-torn` callback 并立即返回 `fallback` | `pre-ready wire-torn recovery does not fall back to the primary error` | C5 exact patch；expected client error `Recovery publication failed`，actual fallback 改写为 `Failed to create messages`；1 fail。此前只改 callback 执行后的返回值无判别力，因为 callback 已先 settle ctx；该旧尝试不作为证据。 | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='pre-ready wire-torn recovery does not fall back to the primary error'` | `9d4ccfc1` |
| duplicate start：取消 `enveloped_ping` fresh R 的 duplicate `message_start` drop | `ready-live enveloped_ping recovery yields one coherent SDK message` | expected one coherent SDK message；actual `.finalMessage()` 抛 `Unexpected event order, got message_start before receiving "message_stop"` | `bun test tests/e2e-client/precontent-recovery.it.test.ts --test-name-pattern='ready-live enveloped_ping recovery'` | `a2f4a740` |
| empty close/remap：移除 `empty_text` open anchor 的 owner close＋R block `+1` remap | `pre-ready mode=empty_text emits the recovery success wire contract` | expected `stop@0` before R start and R index 1；actual stop was late／index conflicted，matrix wire oracle failed | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='pre-ready mode=empty_text'` | `14a3884f`、`1cacbea9` |
| noncomplete publish：允许 evaluator `truncation` result 进入 publication | `pre-ready recovery clean EOF truncation is discarded once and retains the primary terminal` | expected R marker absent／P terminal retained；actual R marker reached wire and response-less publication lost P terminal | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='pre-ready recovery clean EOF truncation'` | `37b76b9c` |
| terminal selector：把 `terminalGenerationAttempt()` 回退为 last active／last attempt | `pins terminal history and V3 egress to primary while an evaluation recovery remains active` | expected pinned P `currentStrategy="primary"`；actual projected discarded R `"precontent-recovery"` | `bun test tests/context/request-context.unit.test.ts --test-name-pattern='pins terminal history and V3 egress to primary'` | `571cafae` |
| clean EOF：跳过 `tryCleanEofRecovery()` | `ready-live clean EOF before semantic content publishes the complete direct recovery as winner` | expected `calls === 2`；actual `1` and immediate truncation terminal | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='ready-live clean EOF before semantic content'` | `aa2620db` |
| abort defense 组合：同时禁用 driver client-abort mapping 与 handler abort exclusion | `delayed-commit abort producer client-abort bypasses B2` | **未得到目标红。**更早的 `runRequest` aborted-result path 已将该 producer 终结，B2 seam 不可达；这是 reachability fact，不可写成 mutation red success | N/A；未改变持久代码 | `533e5bd1`、`24725d6e`、`e40424df` |

C4 的独立双读 oracle 不属于 mutation：`canonical terminal record and V2 entry agree when empty-text recovery wins` 与 `canonical terminal record and V2 entry retain the primary when empty-text recovery falls back` 各自从 `getHistory()` 与 terminal bus 的 immutable `ModelOperationRecord` 读回，断言 terminal、P/R upstream、failureReason、synthetic tag 与 R real frame 的无 tag 语义；`dd79edb3` 后实际运行 `2 pass，0 fail`。该轮还发现并修复初始 R dispatch 未携带 `precontent-recovery` strategy，若不修 V2/V3 `currentStrategy` 均为空；修复后 strategy 从 candidate initial dispatch 显式流入 scheduler。

## 未完成边界

- buffered B2：`runResponseBufferedSink` 的 `committedAny === false` exhausted 路径不发 B2，并继续尊重 `max_retries=0` 表示不重试的裁决。
- translated publication：不得复用 direct Anthropic 的 wire／anchor 规则；需要 cell-aware renderer、terminal contract 与各客户端 oracle。
- 真实 GHC 大上下文 fresh-retry 成功率仍未实测。离线测试证明代理控制流与协议，不证明事故请求必能恢复。
- direct Anthropic live B2 的 Task 5、final code／verifier／doc／merged-state reviews、backend gate 与本地 master 集成均已完成。这里的“完成”不扩张到上列 buffered／translated／真实 GHC 效力边界。
