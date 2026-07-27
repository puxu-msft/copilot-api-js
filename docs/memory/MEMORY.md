# 记忆库索引（话题 → 归属引用地图）

纯引用层：实质在正式归属（skill / `docs/` / ADR / user-rule），下方每行 stub。合并/清理前 deep-read 正文，不只凭钩子。

## 已下沉到项目 skill 的方法论（记忆文件 = stub 指向）

- [审自己写的测试类型错配必派异模型 reviewer](methodology-audit-own-test-type-fit-via-cross-model-reviewer.md) → skill `choosing-test-type` — 真相域归位+试金石+错配四型
- [sync→async 持久化不变量](methodology-sync-to-async-persistence-refactor-invariants.md) → `persistence-async-invariants` §1 — drain-before-close/pending Set 不靠 bus/never-throw/全 await
- [信号在 committed settle 点记录](methodology-record-signals-at-committed-outcome-not-per-attempt.md) → `persistence-async-invariants` §3 — per-attempt 累积+onAttemptReset 清空+committed flush
- [settle 冻结 history entry 快照](reference-settle-freezes-history-entry-record-before-fail.md) → `persistence-async-invariants` §2 — client-facing 数据须 settle 前 record；新顶层字段三处必改
- [可扩展遥测 registry 三支柱](pattern-extensible-telemetry-registry.md) → `telemetry-architecture` 一 — 下沉 sink 层/开放 counters bag/不可重算因子拆最细
- [遥测 model key 成功失败分裂](reference-telemetry-model-key-split-success-vs-failure.md) → `telemetry-architecture` 二 — 成功=规范名/失败=客户端别名；双侧 normalizeModelId
- [迁移框架 Umzug hybrid](methodology-migration-framework-hybrid-forward-runner.md) → `history-sqlite-schema` — hybrid forward-runner/partial-DDL wedge/跨-runtime e2e 需 bundle
- [内容寻址归一化边界剥离](methodology-content-addressed-normalization-boundary-strip.md) → `history-sqlite-schema` — config-无关 canonical 投影/独立 oracle
- [可恢复 backfill 协作停+keyset](methodology-recoverable-backfill-cooperative-stop-and-keyset.md) → `history-backfill` — 协作 stop/(started_at,id) keyset/dedup tripwire
- [派生列 backfill 靶向+非阻塞](methodology-derived-column-backfill-targeted-and-nonblocking.md) → `history-backfill` — 靶向解压别 SELECT */非阻塞/等价性 oracle
- [逐字节等价是代理按消费者校准](feedback-byte-equivalence-is-proxy-calibrate-by-consumer.md) → `large-refactor` §7 — 真 invariant=对在意消费者无可观测变化；三层 oracle
- [sed 碰过的文件裹入在飞工作](sed-touched-files-bundle-inflight-work.md) → `large-refactor` §6 — `git diff --cached --stat` 逐文件对账(1 行改 170 churn=红旗)
- [声称完备前多维度自审](feedback-multidim-completeness-audit-before-claiming-done.md) → `empirical-verification` — 活路径/传输分层/可观测性/副作用四维
- [UI 交付必跑 build:ui](feedback-verify-ui-with-build-not-just-typecheck.md) → `debugging-frontend-tests` — 根 typecheck 不覆盖 ui-v4；权威门 `typecheck:ui-v4`+rollup
- [改共享 mock 契约打爆 sibling 测试](methodology-shared-mock-contract-change-breaks-sibling-test-files.md) → 拟下沉 `debugging-frontend-tests` — grep 全 `vi.mock` 逐改+每 task 跑全量
- [动大工程前核实命名目标](feedback-verify-named-target-resolves-before-large-work.md) — 用户命名目标先 find/ls 核实；踩坑=Vue `ui/` vs React `ui-v4/`
- [测试绝不碰真实环境](feedback_tests_never_touch_real_env.md) → `test-isolation` — DI 注入临时目录(Bun 忽略 env.HOME)；地板=bunfig preload 沙箱

## 已下沉到 ADR（记忆文件 = stub 指向）

- [richest-data-flow 后端完整存](feedback-richest-data-flow-store-complete-no-pruning.md) → ADR `2026-07-05-richest-data-flow` — 永不为 DRY/YAGNI 裁剪；"无数据源"常是没接线该建
- [合成帧必打可辨识标记](feedback-synthetic-data-must-be-distinguishable-from-real.md) → ADR `2026-07-05-richest-data-flow` — 上游轨绝不含合成物、合成物只进 forwarded 轨打标记
- [读上游轨的投影看不到 forwarded-only rewrite 产物](methodology-upstream-original-projection-misses-forwarded-only-rewrite.md) — recover/filter 只进 forwarded 轨；side channel 旁路传名勿污上游轨

## 精炼保留（verification 簇 / 独有教学价值；触发钩子，细节读正文）
- [通过/空/干净/自洽/doc-vs-code 不自证](feedback-pass-null-clean-not-self-validating.md) — verification 簇根；skill `verifying-authoritative-claims`
- [下完备性判断前先实测每个支撑事实](feedback-verify-facts-before-superlative-completeness-verdict.md) — absence/negative 断言最易凭结构推断而错；别贬防御为「只治一半」
- [诊断日志是会撒谎的权威声音](methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth.md) — 计数器可能只接部分路径恒打零；收紧入参用类型逼全站点
- [从日志断代码前先核实运行进程含修复](methodology-verify-running-server-has-fix-before-diagnosing-from-log.md) — 生产日志可能陈旧进程打；ps lstart + merge-base 核祖先
- [V3 direct-driver 测试两 gotcha](methodology-v3-direct-driver-test-async-finalize-race-and-arena-enrichment-oracle.md) — getEntry 撞异步 finalize race(await whenModelOperationFinalized)·arena 富化令 golden 过严
- [reasoned-safe≠tested / producer wire-oracle 必断全序](methodology-reasoned-safe-not-tested-producer-wire-oracle.md) — reviewer「推理安全」也错；client-facing wire 须 producer oracle 断完整帧序
- [client 源码 grep ≠ REST 上游能力](methodology-client-source-grep-not-rest-capability-probe-endpoint.md) — 代理型上游 REST 表面>client 子集须 curl 打端点；实例=GHC count_tokens 被证伪
- [从 primitive 推理别从流行 wrapper 泛化](methodology-reason-from-primitive-not-dominant-wrapper.md) — 干净 primitive vs 耦合全局 wrapper 并存，判风险从 primitive 推理
- [归 config 还是代码：先辨丢信息 vs 等价变换](methodology-classify-lost-info-vs-equivalence-before-config-migration.md) — 丢信息→config，拼写等价→回查 catalog；移隐式转换前追 resolvedName
- [极度倾向全面 async/await 别围堵](feedback-prefer-async-await-uniform-over-sync-isolation.md) — 接口统一 async、爆炸半径主动铺开非规避
- [面向用户永久只用中文禁日语](feedback-chinese-only-never-japanese.md) — 输出层自检语言；内部推理无所谓
- [闻到怪味永远大声报警绝不粉饰](feedback-never-paper-over-smells-warn-loudly.md) — 名实不符当场停下显眼报警
- [写 plan 引用现有接线须核实位置与桥接](methodology-plan-verify-interface-location-and-wiring-channel.md) — 同名 interface 核确切文件；诊断落盘唯一=pipelineInfo；新 union 打爆 ui-v4 穷尽 Record
- [畸形 tool_use 全人群扫描法](methodology-malformed-tooluse-full-population-scan.md) — 查全 decode error；分真缺陷 vs abort 伪畸形；实例=\uXXXX 击中 opus-4.8
- [GHC Responses item.id 每事件重加密](reference-ghc-responses-item-id-reencrypted-per-event.md) — 跨事件关联用 output_index/call_id；曾致 tool_call 翻倍；skill `ghc-api-reference`
- [exactly-one-message_start 须覆盖两条转发腿](reference-exactly-one-message-start-both-forward-legs.md) — keepalive 注入器漏 live 早转发腿；producer-oracle 断全序
- [配置哲学独立：留兼容层+警告继续](feedback-config-philosophy-separate-compat-and-warn-continue.md) — 配置不享代码「无向后兼容负担」；键重命名留旧别名；热重载绝不因配置杀进程
- [微改动别反射式派 subagent 评审](feedback-tier-subagent-review-skip-for-mechanical-micro-changes.md) — user-rule 41 `tiered-review-by-risk`；机械低风险走 TDD、微改攒批合并态审
- [agent 后台连挂也绝不擅换模型](feedback-never-unilaterally-switch-agent-model-on-flakiness.md) — 永远 resume 原 agent；破坏异模型对抗、是用户决策
- [eslint --cache 假绿](tooling-eslint-cache-false-pass.md) — 对过期文件假绿；`lint:all` 已去 cache
- [config.schema.json 只由 .describe() 生成非 TSDoc](reference-config-schema-json-from-describe-not-tsdoc.md) — 改字段 TSDoc 是 no-op；regenerate 前 git diff 防裹进别会话 stale drift
- [gpt-tokenizer 对重复字符病态慢](reference-gpt-tokenizer-pathological-on-repeated-chars.md) — 60KB repeat=15s vs 真实词句 40ms；测试造大 payload 别用单字符 repeat
- [bun test 慢的三层根因与逐层解](reference-bun-test-parallel-breaks-single-process-superlinear-degradation.md) — 单进程超线性退化→`--parallel`→LPT 分片；崩溃桶须 --isolate 重跑；pty/e2e 不并行
- [eslint no-restricted-imports 的 group 是 OR、写不出 allowlist](tooling-eslint-no-restricted-imports-group-is-or-not-allowlist.md) — `["**","!allowed"]` 退化成匹配一切；allowlist 必须用 patterns.regex + 负向先行断言
- [eslint --fix 的 .at() autofix 破类型](tooling-eslint-fix-at-autofix-breaks-types.md) — `.at(-1)` 返 T|undefined；--fix 后必重跑 typecheck
- [测 elapsed 逻辑注入 clock seam 别用 setSystemTime](reference-elapsed-time-test-inject-clock-seam-not-setsystemtime.md) — bun setSystemTime 跨 await 不冻结+绝对时基减真 startedAt 出负值；`now?:()=>number` seam 默认 Date.now、测试注入；边界别恰等 cap
- [real codex 测试用 CODEX_HOME 隔离](reference-codex-ephemeral-insufficient-use-codex-home.md) — --ephemeral 不够、state 仍写真 ~/.codex；代理侧对应=XDG_DATA_HOME
- [node_modules 存在 ≠ 锁文件事实](reference-node-modules-presence-not-lockfile-truth.md) — 可能是 prune orphan；选依赖前 grep bun.lock
- [worktree bun add 后主树须补 install](reference-worktree-bun-add-needs-main-tree-install-after-merge.md) — 隔离 worktree bun add 只进该树；FF 合并后主树须 bun install
- [server.ts 与 test-app.ts 双份 notFound 镜像](reference-server-vs-test-app-dual-notfound-mirror.md) — 改 server 中间件须真实 createServer 测；config 中间件每请求覆盖 state
- [起测试服务器端口被 peer 占用会静默打到 peer mock](reference-spawn-fails-silently-hits-peer-server-verify-port-ownership.md) — launcher 静默失败 health 仍绿；spawn 后验 server.log + ss PID
- [编译错误：补符号 vs 删引用](methodology-broken-reference-supply-vs-delete.md) — 按消费者契约+独立 oracle 裁决，别反射式让它编译
- [复用共享原语选完整版非小版](methodology-full-primitive-not-partial-else-silent-field-drop.md) — 否则静默丢字段+单测假绿；映射测须构造每个非平凡字段
- [「别继承退化」只在目标真有对应值时成立](methodology-degradation-advice-scoped-to-target-has-equivalent.md) — 目标无对应值→诚实退化+marker；实现者最易过度应用
- [修全部比较点](feedback-fix-all-comparison-sites.md) — 归一化键/id bug 多点复发；grep 全仓逐处修+抽共享 primitive
- [修一条约束别自造兄弟约束违规](methodology-fix-one-constraint-violates-sibling-constraint.md) — 对象级约束要一起断言；最小构造须保留被测对象的结构性处境(序数/位置)否则阴性无裁决力、加法+减法二分两头逼近、matcher 按补救手段归类且须 clause-local、按形状非索引定位
- [名实不符变量+双源值](methodology-lying-variable-name-dual-source-value.md) — 名字断言单一身份、值取自会撒谎的源(原始vs已变换)；根治=单一原语+命名反映真实来源(requested vs resolved)+单一抑制权+独立oracle锁接线缝
- [变体路由既有 outcome + 穷尽 Record 审计](methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit.md) — 复用全 handler + 类型系统逼出全站点
- [新策略被更宽 matcher 首命中遮蔽](methodology-new-strategy-shadowed-by-broader-first-match.md) — 加 retry 策略前 grep 同错误子串既有 matcher
- [全套件红先分类再套污染 playbook](methodology-full-suite-red-classify-before-pollution-playbook.md) — 单跑过+全套件挂才真污染；`git log -S` 定 peer commit
- [transport-config 新字段：纯路由标志绝不进 change-detection](methodology-new-transport-config-field-routing-vs-connection-rebuild.md) — setter 对任一追踪字段变化 fire 全体 listener（含全 h2 session retire）；纯逐请求读的 favor 类标志靠 updateState 无条件应用即时生效、须排除出 changed；实例=favor 初版误加被异模型 reviewer 抓
- [append 日志 tail 游标两静默丢失陷阱](methodology-append-log-tail-cursor-silent-loss-traps.md) — 同毫秒 tie-break 永久丢行+per-row hydrate 抛错卡死；只合并态审+新鲜探针戳破
- [架构图优化 Agent 上下文经济](feedback-architecture-map-optimize-agent-context-economy.md) — 价值轴=上下文经济+可信度；目录级关系图+现状小节+L1 守卫
- [交用户前先 subagent review（含 in-chat 提案）](feedback-subagent-review-before-any-user-facing-proposal.md) — 审查门适用任何交付物含对话里直接呈现的设计
- [用户对齐只证方向对非细节最优](feedback-user-alignment-confirms-direction-not-detail-optimality.md) — 逐节点头≠细节最优；落盘 spec 前仍过异模型对抗审
- [后端抖动挂的 Agent 必须只 SendMessage resume](feedback-backend-flakiness-must-sendmessage-resume-no-alternatives.md) — 强制单一路径 resume 原 agent，不派替代/不换模型
- [空闲等后台 agent 主动做 dead check](feedback-proactive-liveness-dead-check-on-background-agents.md) — stat output mtime 判活；抖动/stall→resume
- [计划红绿 mutation 预测可能错、执行期真跑验证](methodology-plan-red-green-mutation-prediction-can-be-wrong-verify.md) — plan「注释 X→变红」可能不咬；不咬别提交假绿、降 characterization
- [git commit -- pathspec 取工作区非 index](git-commit-pathspec-commits-worktree-not-index.md) — 共享 worktree 最终提交一律 pathspec；姊妹坑=`git mv` 只列新路径漏提删除侧
- [语义合并冲突暴露对方 timing 潜伏 bug](methodology-semantic-merge-conflict-exposes-latent-bug-via-timing.md) — 两边各绿合并却坏；根因在运行时时序→instrument 探针；`test:backend` 排除 `.e2e`
- [别合进 peer 多提交重构中间态](methodology-dont-merge-into-midflight-multicommit-refactor.md) — rename/usages 跨提交、合中间点 textually-clean 但 TS2339；等落定或退 last-green 别追 tip；FF 前 WIP∩FF=∅ 则脏主树安全
- [谁合并谁退让、但必须合并](feedback-merger-yields-but-merge-must-happen.md) — 退让=行级共存两份保+备份→选择性 stash→FF→pop 三方合并
- [空 pathspec stash push 会误 pop 别人 WIP](git-stash-push-empty-pathspec-pops-peer-wip.md) — 共享 worktree：stash push -- 无改动 path 不建 stash → pop 误弹栈顶别会话 WIP；stash 前先 stash list、验 HEAD 用独立 worktree 非 stash 套路、已提交本无需 stash
- [按 gitBranch 字段找并发 session](find-claude-session-by-git-branch.md) — ~/.claude/projects/<path>/*.jsonl 的 gitBranch 字段精确命中=强信号(+100)；置信度脚本 /tmp/find-session-by-branch.sh；title 提取须滤系统注入 XML 标签
- [陈旧特性 re-merge 撞底座重写](methodology-remerge-stale-feature-across-subsystem-rewrite.md) — 取 master 结构+重放我的 delta；take-theirs 静默丢 delta；FF 前 `comm -12` 核∩=∅
- [eslint --fix 宽扫入并发既有 dirt](tooling-eslint-fix-broad-sweeps-concurrent-dirt.md) — 宽集只 check 不 fix；显式 pathspec 只提交自己文件
- [lint-staged 已移除](tooling-lint-staged-revert-blocks-edit.md) — 2026-06-29 起无 pre-commit 门禁；skill `git-preference:disarming-lint-staged-rollback`
- [覆写迁移前审计真实库原始字段](methodology-migration-audit-raw-fields-not-just-projection-oracle.md) — projection-等价 oracle 对已死字段盲；覆写前只读探针枚举真库字段
- [一次性 connected 快照须常驻根订阅](methodology-one-shot-connected-snapshot-needs-root-subscriber.md) — WS connected 携初始快照无缓存；消费者挂常驻宿主 AppShell
- [穷举可行方案面再择优](methodology-exhaust-then-choose-over-single-solution.md) — 并行 subagent 分层穷举→实测 supersede 源码推断→异模型审→exp/FINDINGS 择优
- [跨 phase 集成缝只在合并态审能抓](methodology-cross-phase-integration-seam-only-caught-at-merged-state.md) — Phase A 契约被下游漏接线逐 task 审看不到；死枚举是红旗
- [并发分片的环境/路径分支缝 per-task+全量都证不了](methodology-merged-state-review-catches-env-branch-seam.md) — 合并态审须点名每条路径第一人称走查；数据完整性判据须环境无关
- [CLI e2e spawn+hook 两机制](reference-cli-e2e-spawn-and-hook-load-gotchas.md) — hook data-URL 丢具名导出→帧存 base64；`proc.kill()` 漏杀真 server；权威 exp/cli-e2e-stall
- [Bun 忽略 import ?v= query；热重载用项目内唯一文件](reference-bun-esm-cache-busting-query-fails-data-url-works.md) — Bun 按路径缓存 ESM；data-URL 绕缓存但不解析 `~/` 别名；转译后写唯一项目文件
- [picocolors 在 bun test 塌缩成恒等](reference-picocolors-collapses-to-identity-in-bun-test.md) — 改测引用相等 + FORCE_COLOR 子进程 SGR
- [迁移副作用旧路径仍被 eager 求值→双触发](methodology-migrate-side-effect-old-path-still-eager-evaluated.md) — driver eager 求值 deps.strategies 仍触发；根因修=抽 lazy resolver
- [无疑问改进当场做](feedback-slam-dunk-fixes-do-immediately.md) — 更好+无取舍+无分叉三条全中立即改
- [写设计前先核实功能没被 peer 落地](feedback-verify-deferred-task-not-already-landed-before-designing.md) — 连「用户要求实现 X」都先核实是否已 landed；grep 现码+RFC/DESIGN 状态行
- [绝不推荐短期止血方案](feedback-never-propose-short-term-mitigation.md) — 有根因可修就只提根因；「打开 gated feature 绕过」也禁列
- [恢复是唯一出路而非风险取舍](feedback-recovery-is-only-path-not-risk-tradeoff.md) — 连接已死重连是唯一出路；沉没账与重试无关、别框成双计费取舍
- [结构重构提交前跑架构守卫/全 backend](methodology-run-architecture-guards-before-structural-refactor-commit.md) — grep 源码形状/schema 完备性守卫不在直接目录、只跑相关测试会漏红 master
- [现有代码无权威、别为将就它降格最佳方案](feedback-existing-code-has-no-authority-dont-accommodate.md) — 诡异症状=设计错证据；别把「现有架构可行吗」写进 subagent prompt 背书将就
- [剥离成可插拔前先核实抽取程度+缝位](methodology-verify-extraction-state-and-seam-before-pluginizing.md) — 先查是否已纯函数别重包装；N=1 别造 registry
- [恢复 agent 永远 SendMessage 绝不 Agent tool 重派](feedback-resume-agent-always-sendmessage-never-agent-tool.md) — 已终止/完成 subagent 接续永远 SendMessage；唯一 Agent 新派=真全新任务

## project 现状 stub（权威看正式归属；landed 项细节在 docs/DESIGN/git，此处仅触发指针）
- [领域包剥离执行技巧（token landed·telemetry landed 待合并）](methodology-domain-peel-execution-techniques.md) — 两型模板：token=SoT 反转型(setStateForTests-shim+snapshot-fold 吸收 137 测试零改动)·telemetry=只读消费+module-split 型(测试零 churn 白拿)；共通=ambient 端口 floor·peek/get 分层·foundation 裸包名需 tsconfig path；telemetry 新增=facade 插层让文件临时进 SCC 绊倒 ratchet·最后一条 core 边藏在默认参数·守卫要 allowlist 不要 denylist·前端 ~backend 类型需纯类型 barrel+双别名·split-commit 陷阱复发；契约模板见 plan-{token,telemetry}-package.md
- [续写重试（P2 Anthropic 续写 landed+验证+已合并 master de37feff，P3-P7 待续）](project-continuation-retry-sequential-anchor.md) — 首块后 cut 合成 continuation 轮缝合救回；SSOT continued verdict+runContinuation+driver 旁路缝合(wire-index offset≠ledger 长度·真 SDK e2e)；D2 反转退役空-text 保活→默认 ping；权威 plan-2b §11
- [max_tokens 续传 spec+plan+P0（P0 landed 3bb1262a，P1 待做）](project-max-tokens-continuation-spec.md) — 成功路径预算截断三分型 A=text可续/B=tool_use悬挂发散/C=thinking零产出；与续写 spec 正交(post-success 分支)、复用其 ledger；裁决=客户端 transparent 缝合(藏 max_tokens)但后端 history/telemetry 忠实；P0=独立 terminal observer(非复用 ledger)+分型观测层
- [History 搜索移出主进程 sidecar（landed 分支待合并）](project-history-search-out-of-process.md) — systemd 服务；tail 假绿两 blocker 见 [[methodology-append-log-tail-cursor-silent-loss-traps]]
- [合成/改写帧 forwarded 轨完整性（landed master 2026-07-20）](project-synthetic-frame-forwarded-track-completeness-spec.md) — Unit1 前提被 V3 实测推翻(只治瞬态快照)；reaper 两阶段待 backlog
- [Responses buffered-merge（landed 分支待合并）](project-responses-buffered-merge-landed.md) — 候选托管 reducer+两旋钮；承重=buffered 默认 ON→drop-delta 作用所有 Responses 流、纯 delta 累加者拿空文本；@ai-sdk 比官方宽容
- [transport 配置三轴归位（landed master 2c19c7cf）](project-transport-config-three-axis-reorg.md) — timeouts/upstream_transport/responses_ws；0 语义统一+SOCKS 拒 0；热重载 retire-and-replace
- [h2 池按容量选路 N=1 + pre-response 可重试（landed master 36cf45bf）](project-h2-pool-capacity-routing-and-pre-response-retry.md) — 消灭并发流 blast-radius；Map<origin,entry[]>+reservation+容量感知 pending+idle-reap；与并发 favor 3-way 合并落地；后续 ②per-origin 硬 cap(阻塞式+lease token) ③error tag ④Q5 埋点全落地
- [上游静默 commit 时机 spec（Q5 已实测闭合，B2 主线+Q6 高上限定，planner 写 plan 中）](project-upstream-silence-commit-timing-spec.md) — deferred-header 直读证伪等-header 判别(34 正样本 header@47-231s∩success，对抗审 HIGH-1/2 闭合)；B2 主线(post-commit pre-content 重试非 continuation 变体)+B3 Q6 高上限逃生舱；Q1=CC≥125s/Q2 未定论；MED-2=seal 边界 crash race 待与 B2 一并治；**接手看 [docs/plan/2026-07-23-handover-h2-pool-and-silence-spec.md]** + docs/plan/2026-07-23-upstream-silence-recovery.md
- [History 三层降温归档（landed master 27b65b89）](project-history-tiered-archive.md) — HOT→tier-1→sealed；move 永不真删；durable unit 协作停/续跑
- [对称四点 hook 架构（landed master 2a77bf7c）](project-symmetric-four-point-hooks.md) — client/upstream×in/out+exchange；data-URL 不解析别名·config-freshness 须 parse 前
- [请求生命周期 cancel/settle/quiesce（landed master）](project-request-lifecycle-cancel-settle-quiesce.md) — 多根因；承重=有界 grace+per-request 精确 timer>周期 scan；并发合并=等 peer 提交后 3-way 不 force
- [请求首包/时序埋点（landed master f982e0e3）](project-request-timing-instrumentation-landed.md) — 上游4刻/客户端3刻/DDSketch；两段显式投影+谓词收完整帧
- [AskUserQuestion 顶层 question 键抢救（landed）](methodology-plan-verify-interface-location-and-wiring-channel.md) — salvage→兜底 header→strip；诊断落盘唯一=pipelineInfo
- [block 级缓冲重试（landed 默认 OFF）](project-block-level-buffered-retry-execution.md) — merge master c2012555；P1 wire 缺陷被绿测放过→3轮修；翻默认前门=真 CLI
- [上游错误→客户端形态整形（spec+plan 评审中）](project-upstream-error-client-shaping.md) — 按 commit 阶段分治；权威 docs/spec+plan/2026-07-13
- [anthropic↔responses 直接桥（landed+收官）](project-anthropic-responses-direct-bridge.md) — lossless-per-pair 默认；per-pair 穷尽桥表+六腿直连+reasoning round-trip 两向；`model_overrides`→`model_mappings`
- [unknown HTTP endpoint 可配置日志（Task1-3 landed）](project-unknown-endpoint-logging.md) — 404/405 日志级别；影子 TrieRouter 绕中间件+三态分类
- [auto-truncate 移除+calibration 重定位（未合并）](project-remove-auto-truncate-keep-calibration.md) — worktree rebase 风险；权威 RFC/plan 2026-07-13
- [web_search 双跳退役（landed）](project-web-search-double-hop-retired.md) — 教训=称职实现≠有需求；权威 ADR 2026-07-13-server-tool-positioning
- [上游 hook 中间件（spec v2 定稿待审）](project-upstream-hook-middleware.md) — driver 三挂载点；hook 帧进上游轨必打 synthetic 标记
- [通用翻译矩阵（landed master）](project-universal-translation-matrix.md) — 4入站×3出站 hub-spoke；反向绝不合成 thinking、三反向 pump 须 streamError 门
- [GPT reasoning→Anthropic thinking 透传（landed）](project-reasoning-passthrough-synthetic-thinking.md) — summary:auto/标签封装签名 round-trip；前向哨兵≠反向绝不合成
- [codec cell-assembly 重构（landed）](project-inbound-outbound-cell-assembly-refactor.md) — (clientFormat×targetEndpoint) 双穷尽 Record；入口 docs/plan/inbound-outbound-split/
- [遥测分层持久化（landed master）](project-telemetry-tiered-storage.md) — telemetry.db 三层 rollup+DDSketch；cost防2^53·γ绑db·cumulative-cap DB-seeded
- [交互式 TUI live 面板（P0 merge，P1/P2 待做）](project-tui-interactive-live-panel.md) — 折叠 footer↔面板↔detail；权威 RFC/ADR/plan 2026-07-10
- [ui-v4 shadcn 重设计（未实施）](project-ui-v4-shadcn-redesign-decisions.md) — new-york+锐角+Amber+布局 A；代码 agent 写 [[feedback-ui-v4-code-authored-by-agents]]
- [ui-v4 代码由 agent 协作编写](feedback-ui-v4-code-authored-by-agents.md) — 不用"手搓"贬义；重构自由度放宽(守可恢复性)
- [Codex/Responses tier-1 硬化（landed）](reference-undici-websocket-runtime-split-bun-vs-node.md) — 关闭码1000+guardCallback+下游保活+opt-in buffered(默认 OFF)
- [runtime-split：undici WS Bun vs Node](reference-undici-websocket-runtime-split-bun-vs-node.md) — Bun→原生(有 ping)/Node→真 undici(无 ping、抛 invalid)；skill `bun-node-runtime-gotchas`
- [keepalive 无条件 timeout-safety（landed）](project-keepalive-unconditional-timeout-safety-landed.md) — 权威 ADR 2026-07-09 + spec §10
- [v4 流水线重构（landed）](project-v4-pipeline-rearchitecture.md) — v4 P0-P3 + response-pipeline Stage A/B；权威 DESIGN.md
- [GHC 三特性对齐（landed）](project-ghc-feature-alignment-landed.md) — tool-search default-allow/extended-cache-ttl/memory tool；现状 skill `ghc-api-reference`
- [history client/upstream 双腿重构（landed 5db1aff6）](project-history-client-upstream-legs-landed.md) — clientRequest/clientResponse+model{}+attempts[]；权威 DESIGN「类型架构」
- [thinking cannot-be-modified 400 三层修复（landed）](reference-undici-websocket-runtime-split-bun-vs-node.md) — 权威 spec/2026-07-07-thinking-signature-quarantine + skill `ghc-anthropic-upstream`(根因=相邻性)
- [反应式学习 TTL 生命周期+Learned 页（landed 67afa1af）](project-negotiation-learning-lifecycle-landed.md) — per-entry TTL+pin，单一判据 `isEntryActive`
- [后台 agent 结果 surfacing 故障规避](methodology-background-agent-result-surfacing-failure.md) — usage 有、result 正文空;SendMessage-resume 后期救不回;规避=自证具体断言别死等 + agent 结论写进产物文件 + 控制字符转义防 NUL 损坏

## 已删除记忆的话题去向
通用工作原则 → user-rule + CLAUDE.md + skill `session-closeout` / `git-preference`。已归档完成叙事 → `docs/archive/memory/`。散落调试参考收编为 on-demand skills：`bun-node-runtime-gotchas` / `debugging-{claude-client-connection,server-crashes,ghc-api-upstream-transport}` / `ghc-anthropic-upstream` / `ghc-api-reference`。
