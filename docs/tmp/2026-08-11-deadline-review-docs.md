# 文档层与裁决一致性评审（f0a1f2fe..c387a2fe）

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktrees/review-2026-08-11/docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md:28,87-100,109,159-164` — 旧 spec 对已被 2026-08-11 ADR 推翻的「shutdown 无自有 deadline／删除两个 shutdown 配置」仍保留可执行正文，且这些段落没有逐段标注为失效。文首和 §2.3 的注记只覆盖第二信号与“请求终止权”，读者仍会按 §2.1、§3.1、§4.2、§7 执行相反的配置/文档动作。新 ADR `/home/xp/src/copilot-api-js/.worktrees/review-2026-08-11/docs/decisions/2026-08-11-shutdown-owns-bounded-waits-again.md:5,13` 已明确推翻该不变量并恢复两键。修复：在所有上述段落添加醒目的 2026-08-11 推翻注记并指向新 ADR，或将正文改为历史删除线，明确仅保留历史记录。

[major] `/home/xp/src/copilot-api-js/.worktrees/review-2026-08-11/docs/DESIGN.md:204-211` — 「两档请求 deadline」导语写「都以 0 为 bundled 默认（禁用）」，与实际 bundled 配置冲突：`/home/xp/src/copilot-api-js/.worktrees/review-2026-08-11/config.yaml` 的 `timeouts.upstream_request_deadline` 为 `1200`，且新裁决明确要求该默认值。表格把内层机制描述为默认禁用会误导运维并直接违反 D5；`client_request_deadline=0` 与 `upstream_request_deadline=1200` 必须分别写明，并说明单位为秒。

[major] 活文档仍把已删除键当作可用配置，未标成历史：`docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md:21`、`docs/decisions/2026-07-14-transport-config-three-axis-organization.md:12,22`、`docs/spec/2026-07-14-upstream-transport-config-reorg.md:21,51`、`docs/spec/2026-07-12-per-model-idle-timeout.md:280`、`docs/spec/2026-07-08-negotiation-learning-lifecycle.md:152`。检索式：`rg -n "stale_request_max_age|timeouts\\.request_deadline" docs README.md README.zh.md contrib --glob "!docs/{archive,plan,rfc,tmp,audits,v4}/**"`。相较之下 lifecycle:221、旧 ADR:8-10、旧 shutdown spec:60 已明确退役/迁移；上述五份没有。修复：逐处加 2026-08-11 历史注记并改为 `client_request_deadline`／`upstream_request_deadline` 的现行模型，样例配置不能再出现已删键。

补充前述 deadline 默认不一致：`docs/DESIGN.md:70` 同样声称“四个 wall-clock guard 的 bundled 默认均为 0”，但 config.yaml:241 为 `upstream_request_deadline: 1200`；应与 `docs/DESIGN.md:204-211` 同次订正。

[major] `/home/xp/src/copilot-api-js/.worktrees/review-2026-08-11/docs/decisions/2026-08-10-three-tier-shutdown-signal-contract.md:62-64,80-83` — 旧 ADR 虽在首部总注记被部分推翻，却仍在“自动预算”和“状态”两处无标注地规定“默认 0、尚未实现、缺它不改变行为”。这与新 ADR:13 和 config.yaml:260-271 的默认开启 600/60、已实现直接相反；读者会把该 ADR 的显式状态当成现行待办。修复：逐段增加 2026-08-11 superseded 注记，并把状态改成历史快照或指向新 ADR/已实现 backlog 条目，保留原裁决叙事而非改写裁决。

[major] `/home/xp/src/copilot-api-js/.worktrees/review-2026-08-11/docs/DESIGN.md:70` — 同一活架构行末称「lifecycle 进行中 SIGUSR2 幂等；SIGINT／SIGTERM 是立即强退入口」，把三档信号的第 2 档抹掉了。实际 `src/lib/shutdown.ts:821-835` 在 `stopping`／`draining` 收到第二个 SIGINT/SIGTERM 时调用 `abandonDrain()`、武装 `abort_wait` 并返回既有 shutdown promise，以便继续 finalize；仅下一终止信号或 finalizing/notifying/failed 才 `exitFn`。修复为与 `docs/lifecycle.md:25-31` 相同的分阶段表述。

## 已核验、未发现 blocker／major 的命题

- D1/D2：`src/lib/shutdown.ts:690-728,797-803,821-835` 将 graceful 路径和 operator 路径分别传为 `graceful-wait-elapsed` 与 `operator-abandoned-drain`，二者都走 `abandonDrain()`；全仓 `src/` 无 `shutdownAbortController`／`getShutdownSignal` 生产符号。
- D3：config.yaml:241、263、271 为 1200/600/60；systemd `TimeoutStopSec=900`，pm2 `kill_timeout=1300000` ms（1300s），均大于 660s，文档数值一致。
- D7：deferred-backlog.md:1540-1546 明确记载旧设想默认 0 与实际 bundled 600/60 的方向相反、是默认行为变更。
- D8：`rg -n "recordReaperTick\\(" src tests --glob "!src/lib/observability/reaper-diagnostics.ts"` 仅命中 unit tests；`recordConfigReloadTimeoutDiff` 在 src/lib/config/config.ts:1050 的 config hot-reload 生产路径调用。

结构性检查：审计了新 ADR 的引用携带者（README、docs 索引、旧 ADR/spec、lifecycle、DESIGN、backlog、systemd/pm2），发现均落在以上过时契约／默认值的传播面；未发现额外 blocker。
