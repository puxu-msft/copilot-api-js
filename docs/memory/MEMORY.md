# 记忆库索引（话题 → 归属引用地图）

纯引用层：实质在正式归属（skill / `docs/` / ADR / user-rule），下方每行 stub。合并/清理前 deep-read 正文，不只凭钩子。

**钩子写法**：症状词（何时触发）+ 一个防漏动作内核。只写「已升为 skill」会退化成目录项——skill 万一没浮现，这行是唯一兜底。**索引有加载上限、超出部分静默失效，钩子务必压到一行**；细节归主题文件。

## 已下沉到项目 skill 的方法论（记忆文件 = stub）

- [收尾与跨会话交接](session-closeout-and-handover.md) → skill `closing-a-development-session`（收尾编排）+ `writing-handover-docs`（HANDOVER/KICKOFF/进度文件/容量终态接力）
- [审自己测试类型错配派异模型 reviewer](methodology-audit-own-test-type-fit-via-cross-model-reviewer.md) → `choosing-test-type`
- [持久化 sync→async 三件套](methodology-sync-to-async-persistence-refactor-invariants.md) → `persistence-async-invariants`；另见 [settle 冻结快照](reference-settle-freezes-history-entry-record-before-fail.md)（新顶层字段三处必改）、[信号记在 committed settle 点](methodology-record-signals-at-committed-outcome-not-per-attempt.md)
- [遥测 registry 三支柱](pattern-extensible-telemetry-registry.md) → `telemetry-architecture`；[model key 成功=规范名·失败=别名](reference-telemetry-model-key-split-success-vs-failure.md)
- [迁移框架 Umzug hybrid](methodology-migration-framework-hybrid-forward-runner.md) → `history-sqlite-schema`（partial-DDL wedge）；[内容寻址归一化边界剥离](methodology-content-addressed-normalization-boundary-strip.md)
- [backfill 协作停+keyset](methodology-recoverable-backfill-cooperative-stop-and-keyset.md) → `history-backfill`（别 SELECT \*）；[派生列靶向非阻塞](methodology-derived-column-backfill-targeted-and-nonblocking.md)
- [逐字节等价按消费者校准](feedback-byte-equivalence-is-proxy-calibrate-by-consumer.md) → `large-refactor` §7（逐文件对账）；[sed 碰过的文件裹入在飞工作](sed-touched-files-bundle-inflight-work.md) §6
- [声称完备前多维度自审](feedback-multidim-completeness-audit-before-claiming-done.md) → `empirical-verification`（四维）；[探针跑对结论仍可能错](methodology-probe-conclusion-scope-and-peer-invalidation.md)
- [UI 交付必跑 build:ui](feedback-verify-ui-with-build-not-just-typecheck.md) → `debugging-frontend-tests`（根 typecheck 不覆盖 ui-v4）；[改共享 mock 打爆 sibling](methodology-shared-mock-contract-change-breaks-sibling-test-files.md)
- [动大工程前核实命名目标](feedback-verify-named-target-resolves-before-large-work.md) — 踩坑=Vue `ui/` vs React `ui-v4/`
- [时间归因先点名时钟](methodology-time-base-errors-recur-name-the-clock.md) — 「早/晚 X」省略了相对谁
- [测试绝不碰真实环境](feedback_tests_never_touch_real_env.md) → `test-isolation` — DI 临时目录；bunfig preload 沙箱

## 已下沉到 ADR（记忆文件 = stub）

- [richest-data-flow 后端完整存](feedback-richest-data-flow-store-complete-no-pruning.md) → ADR `2026-07-05-richest-data-flow`，永不为 DRY/YAGNI 裁剪；[合成帧必打可辨识标记](feedback-synthetic-data-must-be-distinguishable-from-real.md)
- [读上游轨投影看不到 forwarded-only 产物](methodology-upstream-original-projection-misses-forwarded-only-rewrite.md) — side channel 旁路传名

## 精炼保留（verification 簇 / 独有教学价值）

- [通过/空/干净/自洽/doc-vs-code 不自证](feedback-pass-null-clean-not-self-validating.md) — verification 簇根
- [评审可能正犯它指控你的那个错](methodology-reviewer-may-commit-the-error-it-alleges.md) — 先写下影响集合再从集合内取样；争议交未卷入第三方
- [改文件·验证·提交绝不写在同一次调用](methodology-edit-then-verify-then-commit-never-one-call.md) — assert 在写盘前→失败全丢而 commit 照跑；`bash -n` 绿区分不了两种结果
- [连续多轮「修复引入新回归且照绿」](methodology-each-fix-round-introduces-green-passing-regression-at-the-same-seam.md) — 判据=改回原 bug 仍全绿即无裁决力；验收必须走真实 HTTP 入口
- [plan 陈旧程度 ∝ 返工轮数，逐契约对账](methodology-plan-drift-scales-with-rework-reconcile-per-contract.md) — 按已知形态 grep 查不全；从 types.ts 逐签名出发；五类藏身处逐类过
- [别跨一条你没读过的缝规定行为](methodology-dont-specify-across-a-seam-you-havent-read.md) — 假指令比留白更坏；写形状前答三问（导出了吗·返回什么·那一刻存在吗）；缝含角色/数据可得性/格式三型
- [输出过滤会伪造失败](methodology-output-filter-fakes-a-failure.md) — `| rg`/`tail` 让退出码变成过滤器的且吞掉判据；要判成败就别过滤，嫌长先落盘再筛
- [我写的门总在执行接缝上失效](methodology-gates-i-write-fail-at-the-execution-seam.md) — 九形态；写完每条门问四问（谁在哪个未越过的时刻执行·判否回哪步·执行者拿得到输入吗·可逆吗）；对账到 diff 为空
- [`--ff-only` 被拒别按成因清单对号入座](methodology-ff-only-refusal-is-not-a-conflict.md) — 读 in-progress 状态+`ls-files -u`+实际 stderr 分流；别把「工作区干净」当前置；`ls-tree` 第二列是类型不是 OID
- [顺序前置先分型再判](methodology-ordering-gate-needs-a-trigger-that-reads-it.md) — 状态门 vs capability 门；验收须隔离目标门、核对阻断 provenance；反复被反向打回就去分型
- [降级自评闸门要有可达触发点](methodology-downgrading-a-gate-needs-a-reachable-trigger.md) — 触发点最易只写成陈述；判据=未来会话必经流程会不会真走到；汇总须降派生视图、指纹给命令别给裸值
- [skill 里要实战检验的断言必须内置自验](feedback-skill-claims-needing-field-proof-must-self-verify.md) — 自验表+verification-log；作者不能投证实票
- [领域知识归 skill 不归 always-on rules](feedback-domain-knowledge-belongs-in-skills-not-always-on-rules.md) — 分界=「无论做什么都成立的判据」留 rules，「做某类事才需要的做法」进 skill；搬迁属 B 级
- **写 skill 的元方法** → user-level skill `authoring-skills`（在 `~/.claude/skills/`、无仓库内链接）— 文本为主·schema 严谨度用于表达而非装门禁·概念给 kebab slug 别给流水号·拆文件按「是否必须常驻」不按大小
- [外部机制写进设计前先跑探针](methodology-probe-external-mechanism-before-writing-it-into-design.md) — 核实自己写下的机制
- [下完备性判断前先实测每个支撑事实](feedback-verify-facts-before-superlative-completeness-verdict.md) — absence 断言最易凭结构推断而错
- [收尾汇总的表述系统性强于其证据](methodology-closeout-summaries-overstate-their-evidence.md) — 六形态（数字无 selector·汇总压掉计数·写反方向·全称词没穷举·集合名词没定义·漏传播阻断）；定稿前逐个概括问六问
- [超时归因逐层剥离别信配置层自称值](methodology-timeout-attribution-strip-layers-not-config.md) — 真掐断的在你配置那层之下（undici headersTimeout ~300s）
- [测客户端何时放弃用服务端观测别跑阶梯](methodology-observe-client-giveup-serverside-not-ladder.md) — 静默超容忍+读 request.signal
- [诊断日志是会撒谎的权威声音](methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth.md) — 计数器可能恒打零；[先核实运行进程含修复](methodology-verify-running-server-has-fix-before-diagnosing-from-log.md)；[工具输出反常先疑代理链路别编叙事](feedback-dont-fabricate-evidence-or-tool-distrust-narratives.md)
- [我方产出会作为客户端历史回流](methodology-our-own-output-returns-as-client-history.md) — 「客户端不会发这形状」非安全论据
- [V3 direct-driver 测试两 gotcha](methodology-v3-direct-driver-test-async-finalize-race-and-arena-enrichment-oracle.md) — getEntry 撞异步 finalize race
- [reasoned-safe≠tested / producer wire-oracle 必断全序](methodology-reasoned-safe-not-tested-producer-wire-oracle.md) — reviewer「推理安全」也错
- [client 源码 grep ≠ REST 上游能力](methodology-client-source-grep-not-rest-capability-probe-endpoint.md) — 须 curl 打端点
- [从 primitive 推理别从流行 wrapper 泛化](methodology-reason-from-primitive-not-dominant-wrapper.md)
- [归 config 还是代码：先辨丢信息 vs 等价变换](methodology-classify-lost-info-vs-equivalence-before-config-migration.md) — 丢信息→config
- [极度倾向全面 async/await 别围堵](feedback-prefer-async-await-uniform-over-sync-isolation.md) — 爆炸半径主动铺开非规避
- **面向用户永久只用中文禁日语** — 权威=user-rule `10-text-formatting`[hard] + `01-core-principles`；在 `~/.claude/rules/`、无仓库内链接，本行只作触发指针
- [闻到怪味永远大声报警绝不粉饰](feedback-never-paper-over-smells-warn-loudly.md) — 名实不符当场停下
- [block-level 交付是项目公理](feedback-block-level-delivery-is-project-axiom.md) — 冲突方案要摧毁非并存
- [结论一律落盘绝不只活在对话里](feedback-conclusions-must-land-in-docs-not-chat.md) — 草案与评审报告进 docs/tmp/
- [写 plan 引用现有接线须核实位置与桥接](methodology-plan-verify-interface-location-and-wiring-channel.md) — 同名 interface 核确切文件
- [畸形 tool_use 全人群扫描法](methodology-malformed-tooluse-full-population-scan.md) — 查全 decode error
- [GHC Responses item.id 每事件重加密](reference-ghc-responses-item-id-reencrypted-per-event.md) — 关联用 output_index/call_id
- [exactly-one-message_start 须覆盖两条转发腿](reference-exactly-one-message-start-both-forward-legs.md) — keepalive 注入器漏 live 早转发腿
- [配置哲学独立：留兼容层+警告继续](feedback-config-philosophy-separate-compat-and-warn-continue.md) — 配置不享「无向后兼容负担」
- [微改动别反射式派 subagent 评审](feedback-tier-subagent-review-skip-for-mechanical-micro-changes.md) — `tiered-review-by-risk`
- [agent 后台连挂也绝不擅换模型](feedback-never-unilaterally-switch-agent-model-on-flakiness.md) — 永远 resume 原 agent
- [eslint 四坑](tooling-eslint-cache-false-pass.md) — ①`--cache` 假绿②[group 是 OR 写不出 allowlist](tooling-eslint-no-restricted-imports-group-is-or-not-allowlist.md)③[`.at()` autofix 破类型](tooling-eslint-fix-at-autofix-breaks-types.md)④[`--fix` 宽扫入并发 dirt](tooling-eslint-fix-broad-sweeps-concurrent-dirt.md)
- [config.schema.json 只由 .describe() 生成](reference-config-schema-json-from-describe-not-tsdoc.md) — 改字段 TSDoc 是 no-op
- [gpt-tokenizer 对重复字符病态慢](reference-gpt-tokenizer-pathological-on-repeated-chars.md) — 60KB repeat=15s
- [bun test 慢的三层根因](reference-bun-test-parallel-breaks-single-process-superlinear-degradation.md) — 单进程超线性退化→`--parallel`→LPT 分片
- [提前建 `.rejects` 断言挂死整个测试文件](reference-bun-test-eager-rejects-assertion-hangs-file.md) — 零输出、5s 超时不触发；`-t` 匹配不到时能跑完＝判据；改 `.then(ok,err)` 捕获
- [History 端点慢先查 SQL 两缺陷](methodology-sqlite-read-path-unused-blob-and-orderby-index-mismatch.md) — 不用的大 BLOB 白读 + ORDER BY 末项不在索引
- [Tantivy 读路径等值比 ordinal](methodology-fastfield-ordinal-not-per-doc-dictionary-lookup.md) — 逐文档 `ord_to_str` 慢 16 倍；基线须含无过滤场景
- [测 elapsed 注入 clock seam 别用 setSystemTime](reference-elapsed-time-test-inject-clock-seam-not-setsystemtime.md) — 跨 await 不冻结
- [real codex 用 CODEX_HOME 隔离](reference-codex-ephemeral-insufficient-use-codex-home.md) — `--ephemeral` 不够；[node_modules 存在≠锁文件事实](reference-node-modules-presence-not-lockfile-truth.md)
- [worktree 隔离性没你以为的强（五向）](reference-worktree-bun-add-needs-main-tree-install-after-merge.md) — bun add 只进该树·缺 gitignored 产物假红·向上解析主树 node_modules·可能跑错树·夹带无关祖先
- [隔离 worktree 会话合不了主线](worktree-isolated-session-cannot-merge-shared-master.md) — 判据=`merge-base --is-ancestor master HEAD`，最后一条命令交用户
- [server.ts 与 test-app.ts 双份 notFound 镜像](reference-server-vs-test-app-dual-notfound-mirror.md) — 须真实 createServer 测
- [起测试服务器端口被 peer 占用会静默打到 peer mock](reference-spawn-fails-silently-hits-peer-server-verify-port-ownership.md) — health 仍绿
- [编译错误：补符号 vs 删引用](methodology-broken-reference-supply-vs-delete.md) — 按消费者契约+独立 oracle 裁决
- [复用共享原语选完整版非小版](methodology-full-primitive-not-partial-else-silent-field-drop.md) — 否则静默丢字段+单测假绿
- [「别继承退化」只在目标真有对应值时成立](methodology-degradation-advice-scoped-to-target-has-equivalent.md) — 无对应值→诚实退化+marker
- [阻断式 guard 加固前先确认它守什么](feedback-confirm-guard-purpose-before-hardening.md) — 不替用户把未决粒度定死
- [守卫被合法写法绕过就停止补形态](methodology-relocate-invariant-when-guard-cannot-keep-up.md) → skill `reshaping-a-bypassed-guard`；推断型判据要加独立 intent 输入；[新 oracle 失效主形态是「相邻」](methodology-new-oracle-discriminating-power-is-experimental.md)
- [用例名集合 diff 必须运行时枚举](methodology-test-name-audit-must-enumerate-at-runtime.md) — grep 对参数化/模板名失明；[mutation 要自证改到了代码](methodology-verify-the-mutation-actually-applied.md)「没变红」有三解
- [迁 oracle 到生产构造时绝不顺手削断言](methodology-migrating-an-oracle-must-not-weaken-its-assertions.md) — 注释与断言矛盾是最廉价探测器
- [spec 里的机制性解释必须有实验背书](methodology-mechanism-story-in-spec-must-be-experiment-backed.md) — 判据=我的解释能预测出别的可观测后果吗
- [ctx 共享可变裁决会被落败 hedge candidate 污染](methodology-request-scoped-mutable-verdict-poisoned-by-hedge-candidates.md) — hedge 默认开
- [「一个终态」≠「一个完整终止符」](reference-exactly-one-terminal-is-not-exactly-one-complete-terminus.md) — 合成 end_turn 不补 message_stop 会抛
- [中止成因在产生点打标签别在边界猜](methodology-abort-provenance-tag-at-source-not-guess-at-boundary.md) — fall-through 猜=三处一致撒谎；每臂要正向证据
- [关机 Step 1 停新增工作不拆在途资源](methodology-shutdown-step1-stop-new-vs-kill-inflight.md) — 同族不对称即红旗；取证看同刻兄弟请求是否存活
- [appliesTo 命中 ≠ 链被驱动](methodology-appliesto-matches-but-chain-never-driven.md) — 先数驱动点的生产调用点
- [config.yaml 每请求覆盖 setStateForTests](reference-config-yaml-overwrites-setstatefortests-per-request.md) — 全应用测试钉 config-managed 键是空操作
- [修全部比较点](feedback-fix-all-comparison-sites.md) — 归一化键/id bug 多点复发；grep 全仓+抽共享 primitive
- [修一条约束别自造兄弟约束违规](methodology-fix-one-constraint-violates-sibling-constraint.md) — 对象级约束要一起断言
- [名实不符变量+双源值](methodology-lying-variable-name-dual-source-value.md) — 值取自会撒谎的源（原始 vs 已变换）
- [变体路由既有 outcome + 穷尽 Record 审计](methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit.md) — 类型系统逼出全站点
- [穷尽 Record 全填≠活路径在读它](methodology-exhaustive-record-proves-table-not-that-live-path-reads-it.md) — 从真实入口读字节+mutation 打在共享表上
- [新策略被更宽 matcher 首命中遮蔽](methodology-new-strategy-shadowed-by-broader-first-match.md) — 加 retry 前 grep 同错误子串
- [全套件红先分类再套污染 playbook](methodology-full-suite-red-classify-before-pollution-playbook.md) — 单跑过+全套件挂才真污染
- [随机 false-red 另一半嫌疑：判据挂在进程全局量上](methodology-false-red-from-process-global-quantities-not-the-mechanism.md) — 「修完一条换一条」即信号；换直接观测目标机制的 oracle
- [收尾文档在合并落地那一刻变陈旧](methodology-closeout-doc-goes-stale-the-moment-the-merge-lands.md) — 写「待合并/下一步」即登记会过期断言（五字段）；自身合并状态改给判定命令
- [并发 agent 不得共享 worktree 做 mutation](methodology-concurrent-agents-must-not-share-worktree-for-mutation.md) — 主会话调度责任
- [transport-config 纯路由标志绝不进 change-detection](methodology-new-transport-config-field-routing-vs-connection-rebuild.md) — 任一追踪字段变化 fire 全体 listener
- [append 日志 tail 游标两静默丢失陷阱](methodology-append-log-tail-cursor-silent-loss-traps.md) — 同毫秒 tie-break 丢行+hydrate 抛错卡死
- [响应改写器 lookahead 不得吞协议有效空帧](../todo/2026-07-22-client-proxy-keepalive-300s.md) — 先 curl -N 逐层抓字节
- [架构图优化 Agent 上下文经济](feedback-architecture-map-optimize-agent-context-economy.md) — 价值轴=上下文经济+可信度
- [交用户前先 subagent review（含 in-chat 提案）](feedback-subagent-review-before-any-user-facing-proposal.md) — 审查门适用任何交付物；[用户对齐只证方向非细节最优](feedback-user-alignment-confirms-direction-not-detail-optimality.md)
- [后台 agent 运维：抖动只 SendMessage，context-window 400 才接力](feedback-backend-flakiness-must-sendmessage-resume-no-alternatives.md) — 绝不重派或换模型；[dead check](feedback-proactive-liveness-dead-check-on-background-agents.md) mtime 只是弱信号、真因未定别再补猜测
- [网络失败强制原会话恢复但成功样本不追溯失效](feedback-network-failure-resume-does-not-invalidate-success.md)
- [共享主线前进不是失败信号](feedback-moving-shared-head-is-not-failure.md) — 无关 peer commit 不触发重复全量复验
- [单一权威来源允许语境完整复述](feedback-one-authority-allows-contextual-restatement.md) — 权威≠只能出现一次；真单写入源仍唯一
- [计划的红绿 mutation 预测可能错](methodology-plan-red-green-mutation-prediction-can-be-wrong-verify.md) — 执行期真跑验证
- [git commit -- pathspec 取工作区非 index](git-commit-pathspec-commits-worktree-not-index.md) — 共享树最终提交一律 pathspec；[共享树绝不 amend](git-amend-in-shared-worktree-clobbers-peer-commit.md) 会静默改写 peer commit
- [语义合并冲突暴露对方 timing 潜伏 bug](methodology-semantic-merge-conflict-exposes-latent-bug-via-timing.md) — 两边各绿合并却坏；[别合进 peer 多提交重构中间态](methodology-dont-merge-into-midflight-multicommit-refactor.md)
- [谁合并谁退让但必须合并](feedback-merger-yields-but-merge-must-happen.md) — 退让=行级共存；边界：「两份都保」只对两侧纯新增成立，看 diff3 `|||||||` 段；[空 pathspec stash 会误 pop 别人 WIP](git-stash-push-empty-pathspec-pops-peer-wip.md)
- [按 gitBranch 字段找并发 session](find-claude-session-by-git-branch.md) — `~/.claude/projects/<path>/*.jsonl`
- [陈旧特性 re-merge 撞底座重写](methodology-remerge-stale-feature-across-subsystem-rewrite.md) — 取 master 结构+重放我的 delta
- [合并主线使分支冻结的测试地板失效](methodology-merge-invalidates-branch-frozen-test-floor.md) — 集合取并集、标量按合并态实跑；JUnit 只数叶节点
- [eslint --fix 宽扫入并发既有 dirt](tooling-eslint-fix-broad-sweeps-concurrent-dirt.md) — 宽集只 check 不 fix
- [lint-staged 已移除](tooling-lint-staged-revert-blocks-edit.md) — 2026-06-29 起无 pre-commit 门禁
- [覆写迁移前审计真实库原始字段](methodology-migration-audit-raw-fields-not-just-projection-oracle.md) — projection-等价 oracle 对已死字段盲
- [一次性 connected 快照须常驻根订阅](methodology-one-shot-connected-snapshot-needs-root-subscriber.md) — 无缓存；[消费者只在富快照上读到字段](methodology-consumer-reads-field-only-on-enriched-snapshot.md) 字段放所有变体共有顶层+真实 bus IT
- [穷举可行方案面再择优](methodology-exhaust-then-choose-over-single-solution.md) — 并行 subagent 分层穷举→实测→异模型审→exp/FINDINGS
- [合并态审才抓得到的两类集成缝](methodology-cross-phase-integration-seam-only-caught-at-merged-state.md) — 跨 phase 契约漏接线；[环境/路径分支缝](methodology-merged-state-review-catches-env-branch-seam.md) 须点名每条路径第一人称走查
- [CLI e2e spawn+hook 两机制](reference-cli-e2e-spawn-and-hook-load-gotchas.md) — hook data-URL 丢具名导出→帧存 base64
- [Bun 忽略 import ?v= query](reference-bun-esm-cache-busting-query-fails-data-url-works.md) — 按路径缓存 ESM；热重载用项目内唯一文件
- [picocolors 在 bun test 塌缩成恒等](reference-picocolors-collapses-to-identity-in-bun-test.md) — 改测引用相等 + FORCE_COLOR 子进程
- [迁移副作用旧路径仍被 eager 求值→双触发](methodology-migrate-side-effect-old-path-still-eager-evaluated.md)
- [无疑问改进当场做](feedback-slam-dunk-fixes-do-immediately.md) — 更好+无取舍+无分叉三条全中；[先核实功能没被 peer 落地或删除](feedback-verify-deferred-task-not-already-landed-before-designing.md) 第一条命令=`git log <merge-base>..master -- <路径>`
- [按自洽批次迭代交付不做 all-in-once](feedback-layered-iterative-delivery-not-all-at-once.md) — 每批可独立运行验证回滚
- [绝不推荐短期止血方案](feedback-never-propose-short-term-mitigation.md) — 「打开 gated feature 绕过」也禁列
- [恢复是唯一出路而非风险取舍](feedback-recovery-is-only-path-not-risk-tradeoff.md) — 沉没账与重试无关
- [结构重构提交前跑架构守卫/全 backend](methodology-run-architecture-guards-before-structural-refactor-commit.md) — 守卫不在直接目录
- [现有代码无权威别为将就它降格最佳方案](feedback-existing-code-has-no-authority-dont-accommodate.md) — 诡异症状=设计错证据
- [剥离成可插拔前先核实抽取程度+缝位](methodology-verify-extraction-state-and-seam-before-pluginizing.md) — 先查是否已纯函数
- [Agent 恢复与接力分界](feedback-resume-agent-always-sendmessage-never-agent-tool.md) — 可调用上下文永远 SendMessage
- [Agent 两类容量终态](reference-subagent-transcript-5mib-gate-blocks-resume.md) — 5 MiB 读取闸门可修（报「No transcript found」但文件在）·模型 context-window 400 必须换新 agent 接力

## project 现状 stub → 独立文件

**接手一个在飞特性、或要判断某功能是否已落地时，读 [MEMORY-projects.md](MEMORY-projects.md)**（各特性 landed/待续状态 + 接手该读哪份 handover）。分出去是因为本索引有加载上限，超出部分会被静默丢弃，而项目状态段位于尾部、首当其冲。

## 已删除记忆的话题去向

通用工作原则 → user-rule + CLAUDE.md + user-level skill `closing-a-development-session` / `writing-handover-docs` / `git-preference`。已归档完成叙事 → `docs/archive/memory/`。散落调试参考收编为 on-demand skills（`bun-node-runtime-gotchas` / `debugging-*` / `ghc-*`）。
**两个从未存在的 memory 文件已改指正式归属**（2026-08-02）：语言规则 → user-rule `10-text-formatting`/`01-core-principles`；`project-unknown-endpoint-logging` → [spec](../spec/2026-07-14-unknown-endpoint-logging.md) + `DESIGN.md` 活架构表。
