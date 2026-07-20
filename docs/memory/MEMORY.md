# 记忆库索引（话题 → 归属引用地图）

纯引用层：实质在正式归属（skill / `docs/` / ADR / user-rule），下方每行 stub。合并/清理前 deep-read 正文，不只凭钩子。

## 已下沉到项目 skill 的方法论（记忆文件 = stub 指向）

- [审自己写的测试类型错配必派异模型 reviewer](methodology-audit-own-test-type-fit-via-cross-model-reviewer.md) → skill `choosing-test-type` — 真相域归位 + 试金石 + 错配四型 + stream≠non-stream 独立路径
- [sync→async 持久化不变量](methodology-sync-to-async-persistence-refactor-invariants.md) → skill `persistence-async-invariants` §1 — drain-before-close / pending Set 不靠 bus / re-entrancy / never-throw / 全 await
- [信号在 committed settle 点记录](methodology-record-signals-at-committed-outcome-not-per-attempt.md) → skill `persistence-async-invariants` §3 — per-attempt 累积 + onAttemptReset 清空 + committed flush
- [settle 冻结 history entry 快照](reference-settle-freezes-history-entry-record-before-fail.md) → skill `persistence-async-invariants` §2 — client-facing 数据须 settle 前 record；新顶层字段三处必改
- [可扩展遥测 registry 三支柱](pattern-extensible-telemetry-registry.md) → skill `telemetry-architecture` 一 — 下沉 sink 层 / 开放 counters bag / 不可重算因子拆最细
- [遥测 model key 成功失败分裂](reference-telemetry-model-key-split-success-vs-failure.md) → skill `telemetry-architecture` 二 — 成功=规范名/失败=客户端别名；双侧 normalizeModelId
- [迁移框架 Umzug hybrid](methodology-migration-framework-hybrid-forward-runner.md) → skill `history-sqlite-schema` — hybrid forward-runner / partial-DDL wedge / 跨-runtime e2e 需 bundle
- [内容寻址归一化边界剥离](methodology-content-addressed-normalization-boundary-strip.md) → skill `history-sqlite-schema` — config-无关 canonical 投影 / 独立 oracle
- [可恢复 backfill 协作停 + keyset](methodology-recoverable-backfill-cooperative-stop-and-keyset.md) → skill `history-backfill` — 协作 stop / (started_at,id) keyset / dedup tripwire
- [派生列 backfill 靶向 + 非阻塞](methodology-derived-column-backfill-targeted-and-nonblocking.md) → skill `history-backfill` — 靶向解压别 `SELECT *` / 非阻塞 / 等价性 oracle
- [逐字节等价是代理按消费者校准](feedback-byte-equivalence-is-proxy-calibrate-by-consumer.md) → skill `large-refactor` §7 — 真 invariant=对在意消费者无可观测变化；三层 oracle
- [sed 碰过的文件裹入在飞工作](sed-touched-files-bundle-inflight-work.md) → skill `large-refactor` §6 — `git diff --cached --stat` 逐文件对账（1 行改 170 churn=红旗）
- [声称完备前多维度自审](feedback-multidim-completeness-audit-before-claiming-done.md) → skill `empirical-verification` — 活路径/传输分层/可观测性/副作用四维
- [UI 交付必跑 build:ui](feedback-verify-ui-with-build-not-just-typecheck.md) → skill `debugging-frontend-tests` — 根 typecheck 不覆盖 ui-v4;权威门 `typecheck:ui-v4`+rollup
- [改共享 mock 契约打爆 sibling 测试](methodology-shared-mock-contract-change-breaks-sibling-test-files.md) → 拟下沉 `debugging-frontend-tests` — grep 全 `vi.mock` 逐改 + 每 task 跑全量
- [动大工程前核实命名目标](feedback-verify-named-target-resolves-before-large-work.md) — 用户命名目标先 find/ls 核实;踩坑=Vue `ui/` vs React `ui-v4/`
- [测试绝不碰真实环境](feedback_tests_never_touch_real_env.md) → skill `test-isolation` — DI 注入临时目录（Bun 忽略 `env.HOME`）；地板=bunfig preload 沙箱

## 已下沉到 ADR（记忆文件 = stub 指向）

- [richest-data-flow 后端完整存](feedback-richest-data-flow-store-complete-no-pruning.md) → ADR `2026-07-05-richest-data-flow` — 永不为 DRY/YAGNI 裁剪；"无数据源"常是没接线该建
- [合成帧必打可辨识标记](feedback-synthetic-data-must-be-distinguishable-from-real.md) → ADR `2026-07-05-richest-data-flow`（对称面）— 上游轨绝不含合成物、合成物只进 forwarded 轨打标记
- [读上游轨的投影看不到 forwarded-only rewrite 产物](methodology-upstream-original-projection-misses-forwarded-only-rewrite.md) — recover/filter 只进 forwarded 轨;side channel 旁路传名勿污上游轨;同类站点 grep

## 精炼保留（verification 簇 / 独有教学价值）
- [通过/空/干净/自洽/doc-vs-code 不自证](feedback-pass-null-clean-not-self-validating.md) — verification 簇根;通用手法 skill `verifying-authoritative-claims`
- [下完备性判断前先实测每个支撑事实](feedback-verify-facts-before-superlative-completeness-verdict.md) — 尤其 absence/negative 断言最易凭结构推断而错;别贬防御为「只治一半」
- [诊断日志本身是会撒谎的权威声音](methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth.md) — 计数器可能只接部分路径、恒打零;别信自报探 history 上游轨;收紧入参用类型逼全站点
- [从日志断代码有缺陷前先核实运行进程含修复](methodology-verify-running-server-has-fix-before-diagnosing-from-log.md) — 生产日志可能陈旧进程打;ps lstart vs 提交时刻 + merge-base 核祖先
- [V3 direct-driver 测试两 gotcha](methodology-v3-direct-driver-test-async-finalize-race-and-arena-enrichment-oracle.md) — getEntry 撞异步 finalize race(须 await whenModelOperationFinalized)·arena-value 富化于 wire 令 golden oracle 过严(projection 读 observation.type 非 value.type);V2→V3 迁移令旧测试同步假设失同步
- [reasoned-safe≠tested / producer wire-oracle 必断全序](methodology-reasoned-safe-not-tested-producer-wire-oracle.md) — reviewer「推理安全」也错;client-facing wire 须 producer oracle 断完整帧序 + 真实产出
- [client 源码 grep ≠ REST 上游能力](methodology-client-source-grep-not-rest-capability-probe-endpoint.md) — 代理型上游 REST 表面>client 子集;须 curl 打端点;实例=「GHC 无 count_tokens」被证伪
- [从 primitive 推理别从流行 wrapper 泛化](methodology-reason-from-primitive-not-dominant-wrapper.md) — 干净 primitive vs 耦合全局 wrapper 并存,判风险从 primitive 实现推理
- [归 config 还是归代码：先辨丢信息 vs 等价变换](methodology-classify-lost-info-vs-equivalence-before-config-migration.md) — 丢信息→config,拼写等价→回查 catalog;移隐式转换前追 resolvedName 定爆炸半径
- [面向用户永久只用中文、禁日语](feedback-chinese-only-never-japanese.md) — 输出层自检语言=中文;内部推理无所谓
- [闻到怪味永远大声报警绝不粉饰](feedback-never-paper-over-smells-warn-loudly.md) — 名实不符当场停下显眼报警;踩坑=扩内容留旧名 shutdown 糊过(已改 lifecycle.md)
- [写 plan 引用现有接线须核实位置与桥接](methodology-plan-verify-interface-location-and-wiring-channel.md) — 同名 interface 核实确切文件;诊断落盘唯一通道=pipelineInfo(recordFeature 不落盘);新 union 打爆 ui-v4 穷尽 Record
- [畸形 tool_use 全人群扫描法](methodology-malformed-tooluse-full-population-scan.md) — 查全 decode error 别只看 error_message;分真缺陷 vs abort 伪畸形;实例=\uXXXX 击中 opus-4.8
- [GHC Responses item.id 每事件重加密](reference-ghc-responses-item-id-reencrypted-per-event.md) → skill `ghc-api-reference` — 跨事件关联用 output_index/call_id 不用 item.id;曾致 tool_call 2× 翻倍;修=finalizedOutputIndexes
- [exactly-one-message_start 须覆盖两条转发腿](reference-exactly-one-message-start-both-forward-legs.md) → spec §10.10 — keepalive 注入器漏 live 早转发腿;修=reconcileLiveFrame 置 messageStartForwarded flag;producer-oracle 断全序
- [配置哲学独立：留兼容层 + 警告并继续](feedback-config-philosophy-separate-compat-and-warn-continue.md) — 配置不享代码「无向后兼容负担」;键重命名留旧键别名;热重载绝不因配置杀进程
- [微改动别反射式派 subagent 评审](feedback-tier-subagent-review-skip-for-mechanical-micro-changes.md) — 与 user-rule 41 `tiered-review-by-risk` 合读;机械低风险走 TDD、微改攒批合并态审
- [agent 后台连挂也绝不自作主张换模型](feedback-never-unilaterally-switch-agent-model-on-flakiness.md) — API 错误连挂也永远 resume 原 agent、绝不擅换模型家族(破坏异模型对抗、是用户决策)
- [eslint --cache 假绿](tooling-eslint-cache-false-pass.md) — `--cache` 对过期文件假绿;`lint:all` 已去 cache、核单文件 `bunx eslint <path>`
- [eslint --fix 的 .at() autofix 破类型](tooling-eslint-fix-at-autofix-breaks-types.md) — `prefer-at` 把 `arr[len-1]`→`.at(-1)`(返 T|undefined);--fix 后**必重跑 typecheck**、测试照绿会漏
- [测试跑 real codex 用 CODEX_HOME 隔离、--ephemeral 不够](reference-codex-ephemeral-insufficient-use-codex-home.md) — --ephemeral 只抑 rollout;memories/state 仍写真 ~/.codex;每次套 `CODEX_HOME=$(mktemp -d)`;代理侧对应物是 XDG_DATA_HOME
- [node_modules 存在 ≠ 锁文件事实](reference-node-modules-presence-not-lockfile-truth.md) — 可能是 prune 的 orphan;选依赖前 `grep '"<pkg>@' bun.lock`
- [worktree bun add 后主树须补 install](reference-worktree-bun-add-needs-main-tree-install-after-merge.md) — 隔离 worktree `bun add` 只进该树;FF 合并后主树须 `bun install`
- [server.ts 与 test-app.ts 双份 notFound 镜像](reference-server-vs-test-app-dual-notfound-mirror.md) — 改 server 中间件/notFound 须用真实 createServer 测(createFullTestApp 无中间件镜像);config 中间件每请求覆盖 state→level 测须 config 文件驱动
- [起测试服务器端口被 peer 占用会静默打到 peer mock](reference-spawn-fails-silently-hits-peer-server-verify-port-ownership.md) — launcher 静默失败但 health 仍绿;spawn 后必验 server.log 无 port-in-use + ss 真监听 PID 是我的
- [编译错误：补符号 vs 删引用](methodology-broken-reference-supply-vs-delete.md) — 按消费者契约 + 独立 oracle 裁决,别反射式"让它编译"
- [复用共享原语选完整版非小版、否则静默丢字段+单测假绿](methodology-full-primitive-not-partial-else-silent-field-drop.md) — usageFromTotalInput vs netInputTokens 丢 reasoning_tokens;3 次复发、合并态审+coverage 才逮;映射测须构造每个非平凡字段
- [「别继承退化」建议只在目标真有对应值时成立](methodology-degradation-advice-scoped-to-target-has-equivalent.md) — content_filter→refusal 过度改进;目标无对应值→诚实退化+marker;实现者采纳审计意见最易过度应用、orchestrator 亲手核实两侧类型才裁
- [修全部比较点](feedback-fix-all-comparison-sites.md) — 归一化键/id bug 多点复发;grep 全仓逐处修+抽共享 primitive;盲区靠合并态审逮
- [变体路由既有 outcome + 穷尽 Record 审计](methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit.md) — 路由既有 outcome 复用全 handler + 类型系统逼出全站点
- [新策略被更宽 matcher 首命中遮蔽](methodology-new-strategy-shadowed-by-broader-first-match.md) — 加 retry 策略前 grep 同错误子串既有 matcher;收紧旧正则+新策略排前
- [全套件红先分类再套污染 playbook](methodology-full-suite-red-classify-before-pollution-playbook.md) — 单跑过+全套件挂才真污染;`git log -S` 定 peer commit
- [架构图优化 Agent 上下文经济](feedback-architecture-map-optimize-agent-context-economy.md) — 价值轴=上下文经济+可信度;目录级关系图+现状小节+L1 存在性守卫测试
- [交用户前先 subagent review（含 in-chat 提案）](feedback-subagent-review-before-any-user-facing-proposal.md) — 审查门适用任何交付物含对话里直接呈现的设计
- [用户对齐只证方向对、非细节最优](feedback-user-alignment-confirms-direction-not-detail-optimality.md) — brainstorming 逐节点头≠细节最优;落盘 spec 前仍须过异模型对抗审
- [后端抖动挂的 Agent 必须只 SendMessage resume](feedback-backend-flakiness-must-sendmessage-resume-no-alternatives.md) — 失败→强制单一路径 resume 原 agent,不派替代/不换模型
- [空闲等后台 agent 主动做 dead check](feedback-proactive-liveness-dead-check-on-background-agents.md) — 别被动干等;stat output mtime 判活;抖动/stall→resume、用户停止不可 resume→仅用户明确要求才起新
- [计划的红绿 mutation 预测可能错、执行期真跑验证](methodology-plan-red-green-mutation-prediction-can-be-wrong-verify.md) — plan「注释 X 行→变红」可能不咬(更早前置条件遮蔽);真跑 mutation、不咬则别提交假绿、降 characterization+记 backlog
- [git commit -- pathspec 取工作区非 index](git-commit-pathspec-commits-worktree-not-index.md) — 共享 worktree 最终提交一律 pathspec,免疫 peer 并发 `git add` 的 index race
- [语义合并冲突暴露对方 timing 潜伏 bug](methodology-semantic-merge-conflict-exposes-latent-bug-via-timing.md) — 两边各自绿合并却坏;静态 diff 逐字节等一侧≠行为同,根因在运行时数据/时序→instrument 探针别死盯 diff;判归属纯父分支复现;修法补全对方设计非回退;`test:backend` 排除 `.e2e.test.ts`
- [谁合并谁退让、但必须合并](feedback-merger-yields-but-merge-must-happen.md) — 并发落地不因主树 WIP 跳过合并;退让=行级共存两份都保+备份→选择性 stash 重叠文件→FF→pop 三方合并;对方改动依赖 untracked 时只作未提交叠回不吞其特性
- [eslint --fix 宽扫入并发既有 dirt](tooling-eslint-fix-broad-sweeps-concurrent-dirt.md) — 宽集只 check 不 fix;显式 pathspec 只提交自己文件
- [lint-staged 已移除](tooling-lint-staged-revert-blocks-edit.md) — 2026-06-29 起无 pre-commit 门禁;rollback 见 skill `git-preference:disarming-lint-staged-rollback`
- [覆写迁移前审计真实库原始字段](methodology-migration-audit-raw-fields-not-just-projection-oracle.md) — projection-等价 oracle 对已死字段是盲的;覆写前只读探针枚举真库字段
- [一次性 connected 快照须常驻根订阅](methodology-one-shot-connected-snapshot-needs-root-subscriber.md) — WS `connected` 携初始快照无缓存;snapshot-then-delta 消费者须挂常驻宿主(AppShell)
- [穷举可行方案面再择优](methodology-exhaust-then-choose-over-single-solution.md) — 并行 subagent 分层穷举→实测 supersede 源码推断→异模型审→exp/FINDINGS 择优
- [跨 phase 集成缝只在合并态审能抓](methodology-cross-phase-integration-seam-only-caught-at-merged-state.md) — Phase A 契约被下游漏接线逐 task 审看不到、只 whole-branch 逮;死枚举是红旗
- [并发分片的环境/路径分支缝 per-task+全量都证不了](methodology-merged-state-review-catches-env-branch-seam.md) — 合并态对抗审查须点名对每条路径(supervised vs bare-metal)第一人称走查;数据完整性判据须环境无关(存活性)非某路径记得填的外部名单;merge auto-合并无文本冲突≠语义正确(静默吞 peer 文件、先分类再信基线)
- [CLI e2e spawn+hook 两机制](reference-cli-e2e-spawn-and-hook-load-gotchas.md) — hook 经 data-URL 加载丢具名导出→帧存 base64;`proc.kill()` 漏杀真 server;权威 `exp/cli-e2e-stall/FINDINGS.md`
- [Bun 忽略 import ?v= query;热重载用项目内唯一文件(非 data-URL)](reference-bun-esm-cache-busting-query-fails-data-url-works.md) — Bun 按路径缓存 ESM、`?v=` 静默返旧;data-URL 绕缓存但**不解析 `~/` 别名**(实测证伪、带 import 的 hook 丢导出);可行=转译后写唯一项目文件再 import(绕缓存+解析别名两得)
- [picocolors 在 bun test 塌缩成恒等](reference-picocolors-collapses-to-identity-in-bun-test.md) — 测退化文本;改测引用相等 + FORCE_COLOR 子进程 SGR
- [迁移副作用旧路径仍被 eager 求值→双触发](methodology-migrate-side-effect-old-path-still-eager-evaluated.md) — driver eager 求值 `deps.strategies` 仍触发→双记;根因修=抽 lazy resolver
- [无疑问改进当场做](feedback-slam-dunk-fixes-do-immediately.md) — 更好+无取舍+无分叉三条全中就立即改,别以超范围推迟
- [自以为暂缓的任务先核实没被 peer 落地](feedback-verify-deferred-task-not-already-landed-before-designing.md) — 并发仓库「暂缓」是时间点声明;写设计/handoff 前 grep 现码+RFC 状态行核实;撞车先保留自己分析做对比、别急删(用户纠正:删了要找回)
- [绝不推荐短期止血方案](feedback-never-propose-short-term-mitigation.md) — 有根因可修就只提根因;「打开 gated feature 绕过」也算短期将就、禁列选项
- [现有代码无权威、别为将就它降格最佳方案](feedback-existing-code-has-no-authority-dont-accommodate.md) — 诡异症状=设计错的证据;别把「在现有架构里可行吗」的锚点写进 subagent prompt 让审查背书将就
- [恢复 agent 永远 SendMessage 绝不 Agent tool 重派](feedback-resume-agent-always-sendmessage-never-agent-tool.md) — 已终止/已完成 subagent 接续永远 `SendMessage`、绝不 `Agent` 重派(丢上下文);唯一 Agent 新派=真全新独立任务

## project 现状 stub（权威看正式归属；「全 landed」项细节在 docs/git）
- [合成/改写帧 forwarded 轨完整性（Unit2/3 全量+Unit1 缩减 landed master 2026-07-20）](project-synthetic-frame-forwarded-track-completeness-spec.md) — 三单元;Unit1 原前提被 History V3 实测推翻(durable 已完整、只治瞬态快照);Unit2 responseFrame 展开·Unit3 writeSynthetic 读 tag 根因修+raw-canonical FeatureKind;两轮异模型审 0 blocker;reaper 两阶段待 backlog
- [Responses buffered-merge（全 36 task landed 分支，待合并 master）](project-responses-buffered-merge-landed.md) — 候选托管 reducer + 两正交旋钮(drop-delta/repair-if-incomplete 默认);承重=buffered 默认 ON 致 drop-delta 作用于所有 Responses 流、纯 delta 累加者拿空文本;bare-driver harness 不可行须 HTTP e2e;@ai-sdk 比官方 openai 更宽容;权威 DESIGN 活的架构现状行 + spec/plan 2026-07-14
- [transport 配置三轴归位（P1-P5 全 landed master 2c19c7cf）](project-transport-config-three-axis-reorg.md) — timeouts 看门狗/upstream_transport egress/server.responses_ws ingress;0 语义统一+SOCKS 诚实拒 0;WS 无 keepalive 键;热重载 generation retire-and-replace;每相位 TDD 逼出真 bug(Bun pre-header bare-close·集合字段损坏·WS never-throw 半实现·dead export);权威 ADR/spec 2026-07-14 + DESIGN 活的架构现状
- [History 三层降温归档（已合并 master，lifecycle follow-up `27b65b89`）](project-history-tiered-archive.md) — HOT→tier-1→不可变 session-generation sealed units；move 永不真删；Archive worker 以 durable unit 协作停/续跑、并发 sibling 全 settle 后关 DB；同 session 增量不覆盖；用户重启实例已实证加载
- [对称四点 hook 架构重构（已实施合并 master 2a77bf7c）](project-symmetric-four-point-hooks.md) — client/upstream×in/out+exchange;四格式 async 入站下沉 driver S1b translateInbound;client.inbound 剥 TodoWrite;7 phase 全绿+verifier 验收;实测教训=data-URL 不解析别名·config-freshness 须 parse 前;权威 RFC docs/rfc/2026-07-14-symmetric-four-point-hooks
- [请求生命周期 cancel/settle/quiesce（四根因+C5 结构全合 master）](project-request-lifecycle-cancel-settle-quiesce.md) — 2800s 越超时多根因;RFC 6 轮对抗复核逼出 3 死锁/orphan 缺陷;RC1-4 治根+C5(operation 三态/双 registry/drain-等-operation/driver 追踪 exchange)全 landed master;承重=有界 grace+per-request 精确 timer>周期 scan;剩低频站点接线;并发合并纪律=等 peer 提交后 3-way 自动合不 force
- [请求首包/时序埋点（landed master f982e0e3）](project-request-timing-instrumentation-landed.md) — 上游4刻/客户端3刻/fleet DDSketch;承重=两段显式投影+WS 剥 event 行+谓词收完整帧
- [AskUserQuestion 顶层 question 键抢救（landed master）](methodology-plan-verify-interface-location-and-wiring-channel.md) — salvage→兜底 header→strip;诊断落盘唯一=pipelineInfo;权威 docs/spec+plan/2026-07-13-askuserquestion-toplevel-key-salvage
- [block 级缓冲重试（P0-P4 landed,剩 gated 翻转）](project-block-level-buffered-retry-execution.md) — merge master c2012555(默认 OFF);P1 wire 缺陷被绿测放过→3轮修;翻默认前门=真 CLI+scenario-B
- [上游错误→客户端形态整形（spec+plan 评审中）](project-upstream-error-client-shaping.md) — 按 commit 阶段分治;Phase 6 依赖 P1;权威 docs/spec+plan/2026-07-13-upstream-error-client-shaping
- [anthropic↔responses 直接桥（Phase 0-7 全 landed + 4 次合并态审查 + 收官）](project-anthropic-responses-direct-bridge.md) — 推翻 CC-as-canonical、lossless-per-pair 为默认;per-pair 穷尽桥表 + 前向/反向六腿直连 + reasoning 全链路 round-trip 两向(claude-signature 载体 byte-exact、探针 e 背书)+ 两场景 model_translation + server-tool 透传/降级;`model_overrides`→`model_mappings`;权威 RFC + ADR 2026-07-14-lossless-per-pair-bridge + DESIGN 活的架构现状行
- [unknown HTTP endpoint 可配置日志（Task1-3 landed，Task4 部分）](project-unknown-endpoint-logging.md) — 404/405 配日志级别;影子 TrieRouter 绕中间件污染+三态分类(route-owned 保 404);config.yaml/schema.json/DESIGN 待 peer model_mappings 后补;权威 docs/spec+plan/2026-07-14
- [auto-truncate 移除 + calibration 重定位（实施未合并）](project-remove-auto-truncate-keep-calibration.md) — worktree rebase 风险;权威 RFC/plan 2026-07-13
- [web_search 双跳退役（2026-07-13 landed）](project-web-search-double-hop-retired.md) — 双跳+config 键整套删;教训=称职实现≠有需求;权威 ADR 2026-07-13-server-tool-positioning
- [上游 hook 中间件（spec v2 定稿，待用户审）](project-upstream-hook-middleware.md) — driver 三挂载点;承重=hook 帧进上游轨必打 synthetic 标记;权威 docs/spec/2026-07-12
- [通用翻译矩阵（Phase 0-7 landed master）](project-universal-translation-matrix.md) — 4入站×3出站 hub-spoke;承重=反向绝不合成 thinking、三反向 pump 须 streamError 门;权威 RFC v5 + DESIGN.md
- [GPT reasoning→Anthropic thinking 透传（landed master）](project-reasoning-passthrough-synthetic-thinking.md) — summary:auto/标签封装签名 round-trip;前向哨兵 thinking≠反向绝不合成;权威 DESIGN.md 矩阵行④
- [codec cell-assembly 重构（C0-C6 landed + 清理完成）](project-inbound-outbound-cell-assembly-refactor.md) — (clientFormat×targetEndpoint) 双穷尽 Record;死码删+hub 提取+gemini 剥前缀;入口 docs/plan/inbound-outbound-split/
- [遥测分层持久化（P0-P7 landed master）](project-telemetry-tiered-storage.md) — telemetry.db(三层 rollup+DDSketch);承重=cost防2^53·γ绑db·cumulative-cap DB-seeded;对抗审逼出2静默持久化缺陷;权威 spec+plan+DESIGN
- [交互式 TUI live 面板（P0 merge，P1/P2 待做）](project-tui-interactive-live-panel.md) — 折叠 footer↔面板↔detail+行级动作;权威 RFC/ADR/plan 2026-07-10-*
- [ui-v4 shadcn 重设计（讨论中/未实施）](project-ui-v4-shadcn-redesign-decisions.md) — new-york+锐角+Amber+布局 A;权威 ADR ui-v4/docs/decisions/2026-07-10;代码 agent 写 [[feedback-ui-v4-code-authored-by-agents]]
- [ui-v4 代码由 agent 协作编写](feedback-ui-v4-code-authored-by-agents.md) — 措辞不用"手搓"贬义;重构自由度放宽(守可恢复性底线)
- [Codex/Responses tier-1 硬化（landed master）](reference-undici-websocket-runtime-split-bun-vs-node.md) — 关闭码1000+guardCallback+下游保活+opt-in buffered(默认 OFF);权威 DESIGN.md
- [runtime-split：undici WS Bun vs Node](reference-undici-websocket-runtime-split-bun-vs-node.md) — Bun→原生(有 ping、容忍 1001)/Node→真 undici(无 ping、抛 invalid);属 skill `bun-node-runtime-gotchas`
- [keepalive 无条件 timeout-safety（landed）](project-keepalive-unconditional-timeout-safety-landed.md) — 分支 MERGE-READY 待 user-run oracle;权威 ADR 2026-07-09 + spec §10
- [v4 流水线重构（landed）](project-v4-pipeline-rearchitecture.md) — v4 P0-P3 + response-pipeline Stage A/B;权威 DESIGN.md + archive/2606-landed-rfcs/
- [GHC 三特性对齐（landed）](project-ghc-feature-alignment-landed.md) — tool-search default-allow / extended-cache-ttl / memory tool;现状 skill `ghc-api-reference`
- [history client/upstream 双腿重构（landed 5db1aff6）](project-history-client-upstream-legs-landed.md) — clientRequest/clientResponse+model{}+attempts[];权威 DESIGN.md「类型架构」
- [thinking「cannot be modified」400 三层修复（并 master）](reference-undici-websocket-runtime-split-bun-vs-node.md) — 权威 docs/spec/2026-07-07-thinking-signature-quarantine + skill `ghc-anthropic-upstream`(根因=相邻性;逐块 poison 判「空明文≠毒化」)
- [反应式学习 TTL 生命周期 + Learned 页（landed 67afa1af）](project-negotiation-learning-lifecycle-landed.md) — per-entry TTL+pin,单一判据 `isEntryActive`;权威 docs/spec/2026-07-08

## 已删除记忆的话题去向
通用工作原则 → user-rule + CLAUDE.md + skill `session-closeout` / `git-preference`。已归档完成叙事 → `docs/archive/memory/`。散落调试参考收编为 on-demand skills：`bun-node-runtime-gotchas` / `debugging-{claude-client-connection,server-crashes,ghc-api-upstream-transport}` / `ghc-anthropic-upstream` / `ghc-api-reference`。
