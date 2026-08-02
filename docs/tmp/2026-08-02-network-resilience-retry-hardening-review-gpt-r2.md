# 网络韧性重试加固 v2 · GPT 第 2 轮事实复核

- **评审范围**：`/home/xp/src/copilot-api-js/docs/tmp/2026-08-02-network-resilience-retry-hardening.md` §2 的 C13–C23，以及 §4.6 的候选数与单候选派发数算术。
- **已读取／执行的证据**：逐行读取 retry strategies、registry、driver/coordinator/scheduler、delivery sinks、context manager、两份 ADR、allocator spec/plan；以 `rg` 覆盖 `/home/xp/src/copilot-api-js/{src,packages,tests,docs}` 与 `/home/xp/src/copilot-api-js/config.yaml`；以 `git show`、`git log`、`git branch --contains`、`merge-base --is-ancestor` 核验 allocator 落地状态。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。
- **逐条裁决**：C13 确证；C14 确证；C15 确证；C16 确证；C17 确证；C18 部分成立；C19 确证；C20 确证；C21 确证；C22 证伪；C23 确证。§4.6 候选数 11 部分成立；单候选派发 15 证伪。
- **路由判定复核**：主会话保留草案修订、实施角色待 plan 定稿后决定，是工作分配而非本文事实断言；没有独立证据表明该判定站不住，本轮不反驳。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-02-network-resilience-retry-hardening.md:71` — **C22 证伪**：plan 并非“仅 P0/P6 落地”。`git show feat/anchor-allocator-p1p2:.../README.md` 明记 P0/P1/P2/P6 已完成；commits `035d37c8`/`79551d06` 记录 P1/P2 实施与状态，但 `git merge-base --is-ancestor 035d37c8 HEAD` 为 false，说明它们只在 `feat/anchor-allocator-p1p2`、尚未进 master。— 改成“master 已落 P0/P6；P1/P2 已在分支完成、待合并；P3M/P7/P8 未完成”，并用这些 commit，而非把 P6 的 `a15ea821/2e1041e8` 当成全部实施证据。

[major] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-02-network-resilience-retry-hardening.md:207` — **单候选最坏派发 15 证伪**：`dispatch-scheduler.ts:247-285` 还有不计入四族预算的 `ws-fallback` 与 429 `rate-limit-retry`；后者每次 rate-limited 都可继续，直到 scheduler/generation 总派发闸。且普通族共享 `normalRetries`（`driver.ts:589`），不能笼统按独立族相加而不先定义新预算语义。— 将“15”限定为“排除 WS fallback、429、token-refresh，且网络／协商改成独立可累加族后的设计内上界”，否则总派发预算应由覆盖全部 dispatch reason 的统一 admission 直接约束。

[major] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-02-network-resilience-retry-hardening.md:206` — **候选数 11 部分成立**：按当前 sequential buffered 语义，`attempt=9` 后 floor continuation 确可得 `1+9+1=11`（`driver.ts:1431-1478`）；但 §4.9 要消除 `retryCap` 对 hedge 的排斥，而 hedge 会另开 candidate（`driver.ts:853-856`，`coordinator.ts:156-160`）。— 明确 11 只是不含 hedge 的 sequential 上界；统一协调器若允许 hedge 与 recovery 共存，候选公式必须再加 hedge 上限或证明二者互斥。

[minor] `/home/xp/src/copilot-api-js/docs/tmp/2026-08-02-network-resilience-retry-hardening.md:60` — **C18 部分成立**：两 ADR 的规范结论确实冲突（`2026-07-11...md:30,34` terminal-only；`2026-07-22...md:51-55` 升块级），旧 ADR 也未自标 superseded；但新 ADR `:6` 已明确“修订”旧 ADR，不能写成“无 supersede 记录”。— 改为“有笼统修订关系，但旧 ADR 的 Responses-WS 条目未标注被 D4 取代，仍保留相反的 Accepted 规范文本”。

## 确证项证据索引

- **C13**：`network-retry.ts:32-50` 的实例内 `hasRetried`；`server-error-retry.ts:23-48` 的实例内计数；更关键的是 `driver.ts:489-509` 在 `createCandidate` 内新建 `createSemanticRetryPolicy`，所以策略实例是**每候选**新建。策略拒领时 `driver.ts:555-567` 直接 fail，预算门在 `:589`。
- **C14**：`driver.ts:1430,1481` 仅接受 `other`；`packages/foundation/src/stream.ts:164-173` 把 `StreamIdleTimeoutError` 单列为 `idle-timeout`。
- **C15**：`driver.ts:821-825` 见 `retryCap` 即跳过 hedge；Anthropic buffered opts 在 `messages/handler-v4.ts:1311-1345` 恒设置 `retryCap`。
- **C16**：`driver.ts:1227,1274-1275,1348` 只清 `buffer.length`，不清 `bufferedBytes`；`:1372-1382` 的 retreated 终局早于 `:1425-1547` 三腿。
- **C17**：生产调用仅 `messages/handler-v4.ts:1367,1665` 两处；translate leg 的结构限制自述在 `:1640-1645`。
- **C19**：`driver.ts:548-551,589` 的 normal/learning 双计数；`messages/handler-v4.ts:209-210,456-457` 供给 learning=32。
- **C20**：搜索范围 `/home/xp/src/copilot-api-js/{src,packages,tests,docs}` + `config.yaml`；关键词 `max_candidates|maxCandidates|generationRecoveryMaxCandidates`。生产侧仅 config→state 写入（`config.ts:928`、`state-defaults.ts:191`），`src/` 对 `generationRecoveryMaxCandidates` 零读取；正对照 `generationMaxTotalCandidates` 可命中 `runtime-policy.ts:19`。
- **C21**：`delivery/session.ts:126-129` 是 `semanticBlockCount===0` 门；旧 sink 的等价 latch 是 `client-sink.ts:263,270,429` 的 `everOpenedRealBlock`。
- **C23**：`context/request.ts:1144-1146` 提供 `ctx.durationMs`，reaper 在 `context/manager.ts:305-306` 消费；`runtime-policy.ts:7-8,24` 提供 `requestDeadlineAtMs`，hedge 在 `hedge-policy.ts:128` 消费。
