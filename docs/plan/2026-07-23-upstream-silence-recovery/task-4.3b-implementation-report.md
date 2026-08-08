# Task 4.3b direct Anthropic B2 实施报告

状态：**实现与测试资产已完成；独立复评与 `bun run test:backend` 最终门进行中。** 代码基线为 `dd79edb3`（其父 `84a84bf5` 完成 evaluator discriminant guard，`aa2620db` 修复 ready-live clean EOF）。本报告只覆盖 `/v1/messages` 的 direct Anthropic live B2；buffered B2 与 translated publication 仍未实现、保持 fail-closed，见 [deferred backlog](../../todo/deferred-backlog.md)。

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

## 可复现验证

以下命令都以本报告基线的 worktree 为对象；后续提交须重新运行，不得把历史绿当作当前绿。

```sh
bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts
bun test tests/e2e-client/precontent-recovery.it.test.ts
bun test tests/context/request-context.unit.test.ts
bun run typecheck
```

focused matrix、SDK 与 context oracle 在实现期均以退出码 0 验证。`dd79edb3` 后重新运行 `bun run typecheck`、matrix＋coordinator focused suites（54 pass，0 fail）、C4 dual-read oracle（2 pass，0 fail）与受影响文件 eslint。clean EOF SDK case `ready-live clean EOF before semantic content recovers one coherent SDK message` 连续运行 10 次均退出码 0。`bun run test:backend` 尚未运行，不能由上述 focused commands 替代。

## Mutation controls

已执行项目遵循同一流程：从已包含真实实现的 commit 生成仅描述目标变换的 exact patch，先 `git apply --reverse --check <patch>`，应用 patch，执行具名 oracle 取得目标红，再对同一 patch `git apply --reverse` 并执行 restore-green command。临时 patch 不作为仓库长期资产；本表保存变换、红色失配、恢复门与代码锚点。没有持久化 red 记录的项目明确标为“待重跑”，不得把覆盖测试或推演写成 mutation 证据。abort 组合未实际达到 B2 seam，明确作为 reachability 事实记录，而非伪称 red success。

| 机制／精确变换 | 具名 oracle | 实测 red evidence | restore-green command | commit anchor |
|---|---|---|---|---|
| C9 移动：将 recovery batch C9 移到 first write 后 | `first recovery batch write client abort is committed and finalizes delivery` | exact patch `$CLAUDE_JOB_DIR/tmp/c5-c9-after-first-write.patch`；expected `{ committed:true }`，actual `{ committed:false }`；1 fail | `bun test tests/pipeline/recovery-batch-publication.it.test.ts --test-name-pattern='first recovery batch write client abort is committed and finalizes delivery'` | `b0b26abd` |
| 删除 wire-torn frontier：在 committed `writeCommittedBatch` failure 后不置 `wireTorn` | `first non-client recovery batch write tears the frontier while terminal error and finalization remain available`；`Nth non-client recovery batch write leaves only the written prefix and tears the wire` | exact patch `$CLAUDE_JOB_DIR/tmp/c5-wire-torn-delete.patch`；expected `{ reason:"wire-torn" }`，actual first case `beginLeg` 返回 `{ ok:true, value:"primary:…" }`，Nth case publish 返回 `{ ok:true, value:"published" }`；2 fail | `bun test tests/pipeline/recovery-batch-publication.it.test.ts --test-name-pattern='first non-client recovery batch write tears|Nth non-client recovery batch write leaves'` | `b0b26abd` |
| anchor-kind 位置：将 owner `closeOpenAnchorBefore` 停止帧从 batch first spec 移到 R real frame 后 | `pre-ready mode=empty_text emits the recovery success wire contract` | expected `stop@0` index < real R block start；actual stop index 6 > start index 4，matrix order oracle 红；SDK 本身容忍该坏 wire | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='pre-ready mode=empty_text'` | `14a3884f`、`1cacbea9` |
| heartbeat resume/order：删除 `evaluateAndPublishDirectAnthropicRecovery` 开始处的 `resumeHeartbeat?.()` | `ready-live recovery resumes the suspended heartbeat while evaluation waits, then publishes its batch without interleaving` | exact patch `$CLAUDE_JOB_DIR/tmp/c5-heartbeat-resume-delete.patch`；expected ping length 1，actual length 0；1 fail | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='ready-live recovery resumes the suspended heartbeat while evaluation waits, then publishes its batch without interleaving'` | `b0b26abd` |
| publication commit 提前：把 `evaluation.disposition.commit()` 从 publication success 后移到 `publishRecoveryBatch` 前 | `pre-C9 recovery publication rejection discards R and retains the primary terminal` | exact patch `$CLAUDE_JOB_DIR/tmp/c5-publication-commit-early.patch`；expected R `candidateVerdict`／`dispatchVerdict` 均为 `failed`，actual `winner`／`committed`；1 fail，且 evaluator cleanup 报 disposition already committed | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='pre-C9 recovery publication rejection discards R and retains the primary terminal'` | `328ea295` |
| post-C9 fallback：跳过 `wire-torn` callback 并立即返回 `fallback` | `pre-ready wire-torn recovery does not fall back to the primary error` | exact patch `$CLAUDE_JOB_DIR/tmp/c5-post-c9-wire-torn-fallback-dispatch.patch`；expected client error `Recovery publication failed`，actual fallback 改写为 `Failed to create messages`；1 fail。此前只改 callback 执行后的返回值无判别力，因为 callback 已先 settle ctx；该旧尝试不作为证据。 | `bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts --test-name-pattern='pre-ready wire-torn recovery does not fall back to the primary error'` | `9d4ccfc1` |

`client-gone` companion case 现在还断言 V2 History `state:"aborted"` 与 `failureReason:"client disconnected"`。跳过 dispatcher callback 的 direct control 仍保持该状态，因为 owner 的 `finalizeAfterClientGone()` 已在 dispatcher 前关闭 delivery；它不承担本行 post-C9 fallback 的判别证据，wire-torn 变体才是本轮实际 red oracle。
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
- 独立复评和 backend 最终门未完成；本报告不构成整个 Task 5 或上游静默特性的完成声明。
