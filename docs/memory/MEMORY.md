# 记忆库索引（话题 → 归属引用地图）

纯引用层：实质在正式归属（skill / `docs/` / ADR / user-rule），下方每行 stub。合并/清理前 deep-read 正文，不只凭钩子。

**条目已升级为 skill 时**：钩子仍须带「何时触发」的症状词 + 一个**防漏的动作内核**，并写明「方法 → skill，证据 → memory」。只写「方法论已升为 skill」会退化成目录项——约 120 行钩子在竞争注意力，而 skill 万一没浮现时，这行是唯一的兜底。

## 已下沉到项目 skill 的方法论（记忆文件 = stub 指向）

- [收尾与跨会话交接](session-closeout-and-handover.md) → skill `session-closeout` — 收尾六步 + HANDOVER/KICKOFF 唯一归属
- [审自己测试类型错配派异模型 reviewer](methodology-audit-own-test-type-fit-via-cross-model-reviewer.md) → `choosing-test-type`
- [持久化 sync→async 三件套](methodology-sync-to-async-persistence-refactor-invariants.md) → skill `persistence-async-invariants` — §1 不变量 / §2 [settle 冻结快照](reference-settle-freezes-history-entry-record-before-fail.md)（新顶层字段三处必改）/ §3 [信号在 committed settle 点记录](methodology-record-signals-at-committed-outcome-not-per-attempt.md)
- [遥测 registry 三支柱 + model key 成功失败分裂](pattern-extensible-telemetry-registry.md) → `telemetry-architecture` 一/二 — 成功=规范名·失败=别名，见 [key-split](reference-telemetry-model-key-split-success-vs-failure.md)
- [迁移框架 Umzug hybrid + 内容寻址归一化边界剥离](methodology-migration-framework-hybrid-forward-runner.md) → `history-sqlite-schema` — partial-DDL wedge；另见 [boundary-strip](methodology-content-addressed-normalization-boundary-strip.md)
- [backfill 协作停+keyset / 派生列靶向非阻塞](methodology-recoverable-backfill-cooperative-stop-and-keyset.md) → `history-backfill` — 别 SELECT \*，另见 [derived-column](methodology-derived-column-backfill-targeted-and-nonblocking.md)
- [逐字节等价按消费者校准 / sed 碰过的文件裹入在飞工作](feedback-byte-equivalence-is-proxy-calibrate-by-consumer.md) → `large-refactor` §7/§6 — 逐文件对账，另见 [sed-touched](sed-touched-files-bundle-inflight-work.md)
- [声称完备前多维度自审 / 探针跑对结论仍可能错的三失效](feedback-multidim-completeness-audit-before-claiming-done.md) → `empirical-verification` — 四维；另见 [probe-scope](methodology-probe-conclusion-scope-and-peer-invalidation.md)
- [UI 交付必跑 build:ui / 改共享 mock 契约打爆 sibling 测试](feedback-verify-ui-with-build-not-just-typecheck.md) → `debugging-frontend-tests` — 根 typecheck 不覆盖 ui-v4，另见 [shared-mock](methodology-shared-mock-contract-change-breaks-sibling-test-files.md)
- [动大工程前核实命名目标](feedback-verify-named-target-resolves-before-large-work.md) — 踩坑=Vue `ui/` vs React `ui-v4/`
- [时间归因先点名时钟](methodology-time-base-errors-recur-name-the-clock.md) — 「早/晚 X」省略了相对谁
- [测试绝不碰真实环境](feedback_tests_never_touch_real_env.md) → `test-isolation` — DI 临时目录；bunfig preload 沙箱

## 已下沉到 ADR（记忆文件 = stub 指向）

- [richest-data-flow 后端完整存 / 合成帧必打可辨识标记](feedback-richest-data-flow-store-complete-no-pruning.md) → ADR `2026-07-05-richest-data-flow` — 永不为 DRY/YAGNI 裁剪；只进 forwarded 轨打标记，见 [synthetic-marker](feedback-synthetic-data-must-be-distinguishable-from-real.md)
- [读上游轨投影看不到 forwarded-only 产物](methodology-upstream-original-projection-misses-forwarded-only-rewrite.md) — side channel 旁路传名

## 精炼保留（verification 簇 / 独有教学价值；触发钩子，细节读正文）

- [通过/空/干净/自洽/doc-vs-code 不自证](feedback-pass-null-clean-not-self-validating.md) — verification 簇根
- [评审可能正犯它指控你的那个错](methodology-reviewer-may-commit-the-error-it-alleges.md) — 指控「逐项绑定错位」时先逐项复核再采纳；对照若恰是它没指控的那几项就检验不了指控，先写下影响集合再从集合内取样，争议交未卷入第三方
- [改文件·验证·提交绝不写在同一次调用](methodology-edit-then-verify-then-commit-never-one-call.md) — 编辑脚本的 assert 在写盘之前→失败即全丢而 commit 照跑，提交信息描述了没发生的事（一天内两次）；`bash -n`／smoke 绿在未编辑文件上同样通过、区分不了两种结果
- [连续多轮「修复引入新回归且照绿」→ 去找那条测试看不见的缝](methodology-each-fix-round-introduces-green-passing-regression-at-the-same-seam.md) — 判据=把修复改回完整原 bug 形态仍全绿即无裁决力；根因常是测试自造 sink/session 看不到 handler↔装饰器↔driver 缝，验收必须走真实 HTTP 入口；**转述评审意见时限定语与严重度是内容不是修辞**
- [plan 陈旧程度 ∝ 实现返工轮数，须逐契约对账](methodology-plan-drift-scales-with-rework-reconcile-per-contract.md) — 四轮返工的相位其 plan 积了 13 处旧契约、十四轮评审每轮还能再找出一处；**按已知形态 grep 结构性查不全**（用已知错误找未知错误），方向要从 types.ts 逐签名出发；五类藏身处（签名/散文/表格/mutation 对照/文件清单）逐类过；别用顶层一句兜住相反 checkbox；改文档用内容匹配非行号
- [别跨一条你没读过的缝规定行为](methodology-dont-specify-across-a-seam-you-havent-read.md) — 一天四次同形翻车（agent id 尚不存在／目标函数是 private／pump 返回 `Promise<void>`／owner 够不到 AnchorState）；**动机都是「定死以消除歧义」而假指令比留白更坏**；写形状前先答三问（导出了吗·调用方返回什么·那一刻它存在吗），答不上就只冻结性质 + 调查 task + 停下回报硬门；候选方案也要过同一道检查；证据不同就不能合并同类项。**缝不只是代码缝**——另有角色边界／数据可得性／数据格式三型（2026-08-03），推广三问：执行者有这权限吗·是行为拿不到还是数据拿不到·落到具体字段是哪个
- [降级自评闸门要有可达触发点](methodology-downgrading-a-gate-needs-a-reachable-trigger.md) — 判官与记录位置好补、**触发点最容易只写成一句陈述**（还要带 level + 说出来让用户可否决）；判据=未来会话在必经流程里会不会真走到；连打回**三轮**（①搬进 skill 只修好三分之二 ②指针不可达：字面只裁三条断言里的一条、且漏了 leaf 转交分支 ③触发点寄生在会被删除的宿主上）；**「永不闭合」不是安全的保守选项**。另含两条配套：**手工汇总+明细无对账门必漂**（指定明细为 SSOT、汇总降派生视图）·**写进文档的指纹要给可复跑命令别给裸值**
- [skill 里要实战检验的断言必须内置自验](feedback-skill-claims-needing-field-proof-must-self-verify.md) — 自验表+verification-log；作者不能给自己投证实票；范式=skill `session-closeout`
- [外部机制写进设计前先跑探针](methodology-probe-external-mechanism-before-writing-it-into-design.md) — 核实自己写下的机制（对偶于核实他人断言）
- [下完备性判断前先实测每个支撑事实](feedback-verify-facts-before-superlative-completeness-verdict.md) — absence/negative 断言最易凭结构推断而错
- [超时归因要逐层剥离、别信配置层自称值](methodology-timeout-attribution-strip-layers-not-config.md) — 真掐断的常在你配置那层之下(实为 undici headersTimeout ~300s)
- [测客户端何时放弃用服务端观测别跑阶梯](methodology-observe-client-giveup-serverside-not-ladder.md) — 静默超出容忍度+读 request.signal 一次给点位与重试 backoff
- [诊断日志是会撒谎的权威声音 / 从日志断代码前先核实运行进程含修复 / 工具输出反常先疑代理链路别编叙事](methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth.md) — 计数器可能只接部分路径恒打零；生产日志可能陈旧进程打，同类第二例先比 process 指纹，见 [stale-process](methodology-verify-running-server-has-fix-before-diagnosing-from-log.md)；工具输出异常先怀疑单条代理转发链路损坏、用磁盘/独立 oracle 复核、引用命令前确认真实 tool_use/result，见 [no-fabrication](feedback-dont-fabricate-evidence-or-tool-distrust-narratives.md)
- [我方产出会作为客户端历史回流](methodology-our-own-output-returns-as-client-history.md) — 「客户端原生不会发这形状」非安全论据；修复腿须能修自己昨天造的
- [V3 direct-driver 测试两 gotcha](methodology-v3-direct-driver-test-async-finalize-race-and-arena-enrichment-oracle.md) — getEntry 撞异步 finalize race(await whenModelOperationFinalized)
- [reasoned-safe≠tested / producer wire-oracle 必断全序](methodology-reasoned-safe-not-tested-producer-wire-oracle.md) — reviewer「推理安全」也错
- [client 源码 grep ≠ REST 上游能力](methodology-client-source-grep-not-rest-capability-probe-endpoint.md) — 代理型上游 REST 表面>client 子集须 curl 打端点
- [从 primitive 推理别从流行 wrapper 泛化](methodology-reason-from-primitive-not-dominant-wrapper.md) — 干净 primitive vs 耦合全局 wrapper 并存
- [归 config 还是代码：先辨丢信息 vs 等价变换](methodology-classify-lost-info-vs-equivalence-before-config-migration.md) — 丢信息→config
- [极度倾向全面 async/await 别围堵](feedback-prefer-async-await-uniform-over-sync-isolation.md) — 接口统一 async、爆炸半径主动铺开非规避
- **面向用户永久只用中文禁日语** — 输出层自检语言；内部推理无所谓。权威=user-rule `00-user/10-text-formatting`[hard] + `01-core-principles`（用户不懂日/韩/西语），在 `~/.claude/rules/` 不在仓库内、故无链接；本行只作触发指针、不另立 memory
- [闻到怪味永远大声报警绝不粉饰](feedback-never-paper-over-smells-warn-loudly.md) — 名实不符当场停下显眼报警
- [block-level 交付是项目公理绝不逐 token 流式](feedback-block-level-delivery-is-project-axiom.md) — 冲突方案要摧毁非并存；混合「只缓冲 tool_use」已被当场推翻
- [结论一律落盘绝不只活在对话里](feedback-conclusions-must-land-in-docs-not-chat.md) — 提议/spec/plan/review/investigation/交接草稿；草案与评审报告进 docs/tmp/
- [写 plan 引用现有接线须核实位置与桥接](methodology-plan-verify-interface-location-and-wiring-channel.md) — 同名 interface 核确切文件
- [畸形 tool_use 全人群扫描法](methodology-malformed-tooluse-full-population-scan.md) — 查全 decode error
- [GHC Responses item.id 每事件重加密](reference-ghc-responses-item-id-reencrypted-per-event.md) — 跨事件关联用 output_index/call_id
- [exactly-one-message_start 须覆盖两条转发腿](reference-exactly-one-message-start-both-forward-legs.md) — keepalive 注入器漏 live 早转发腿
- [配置哲学独立：留兼容层+警告继续](feedback-config-philosophy-separate-compat-and-warn-continue.md) — 配置不享代码「无向后兼容负担」
- [微改动别反射式派 subagent 评审](feedback-tier-subagent-review-skip-for-mechanical-micro-changes.md) — user-rule 41 `tiered-review-by-risk`
- [agent 后台连挂也绝不擅换模型](feedback-never-unilaterally-switch-agent-model-on-flakiness.md) — 永远 resume 原 agent
- [eslint 四坑](tooling-eslint-cache-false-pass.md) — ①`--cache` 对过期文件假绿(`lint:all` 已去 cache)②[no-restricted-imports 的 group 是 OR 写不出 allowlist](tooling-eslint-no-restricted-imports-group-is-or-not-allowlist.md)③[`--fix` 的 `.at()` autofix 破类型](tooling-eslint-fix-at-autofix-breaks-types.md)④[`--fix` 宽扫入并发既有 dirt](tooling-eslint-fix-broad-sweeps-concurrent-dirt.md)
- [config.schema.json 只由 .describe() 生成非 TSDoc](reference-config-schema-json-from-describe-not-tsdoc.md) — 改字段 TSDoc 是 no-op
- [gpt-tokenizer 对重复字符病态慢](reference-gpt-tokenizer-pathological-on-repeated-chars.md) — 60KB repeat=15s vs 真实词句 40ms
- [bun test 慢的三层根因与逐层解](reference-bun-test-parallel-breaks-single-process-superlinear-degradation.md) — 单进程超线性退化→`--parallel`→LPT 分片
- [History 端点慢先查 SQL 两缺陷](methodology-sqlite-read-path-unused-blob-and-orderby-index-mismatch.md) — 不用的大 BLOB 白读 + ORDER BY 末项不在索引→temp B-tree
- [测 elapsed 逻辑注入 clock seam 别用 setSystemTime](reference-elapsed-time-test-inject-clock-seam-not-setsystemtime.md) — bun setSystemTime 跨 await 不冻结
- [real codex 用 CODEX_HOME 隔离 / node_modules 存在≠锁文件事实](reference-codex-ephemeral-insufficient-use-codex-home.md) — `--ephemeral` 不够；后者可能是 prune orphan，见 [node_modules](reference-node-modules-presence-not-lockfile-truth.md)
- [worktree 的隔离性没你以为的强（五向）](reference-worktree-bun-add-needs-main-tree-install-after-merge.md) — ①bun add 只进该树②新树缺 gitignored 产物致假红③`.worktrees/` 内仍向上解析主树 node_modules④命令可能跑错树⑤不同基线 merge 会夹带无关祖先；树向 gate → skill `proving-where-a-command-ran`，集成单元/ancestry/恢复 → skill `git-preference:isolating-from-a-shared-git-worktree`
- [隔离 worktree 会话合不了主线，只能交付到「可 fast-forward」](worktree-isolated-session-cannot-merge-shared-master.md) — master 被主检出占用 + 护栏拒 `-C` 共享树且无放行前缀；判据=`merge-base --is-ancestor master HEAD`，最后一条命令交用户
- [server.ts 与 test-app.ts 双份 notFound 镜像](reference-server-vs-test-app-dual-notfound-mirror.md) — 改 server 中间件须真实 createServer 测
- [起测试服务器端口被 peer 占用会静默打到 peer mock](reference-spawn-fails-silently-hits-peer-server-verify-port-ownership.md) — launcher 静默失败 health 仍绿
- [编译错误：补符号 vs 删引用](methodology-broken-reference-supply-vs-delete.md) — 按消费者契约+独立 oracle 裁决，别反射式让它编译
- [复用共享原语选完整版非小版](methodology-full-primitive-not-partial-else-silent-field-drop.md) — 否则静默丢字段+单测假绿；映射测须构造每个非平凡字段
- [「别继承退化」只在目标真有对应值时成立](methodology-degradation-advice-scoped-to-target-has-equivalent.md) — 目标无对应值→诚实退化+marker
- [阻断式 guard 的目的／false-red 成本／粒度未决时先确认](feedback-confirm-guard-purpose-before-hardening.md) — 加固前先确认 guard 守什么，不替用户把未决粒度定死
- [守卫被合法写法绕过 / 新 oracle「一定咬得住」只是推理](methodology-relocate-invariant-when-guard-cannot-keep-up.md) — 又准备补一种等价写法时**停止补形态** → skill `reshaping-a-bypassed-guard`；**第三例新增**：信号是「几次 witness 利用同一事实」非次数、推断型判据要**加独立 intent 输入**而非换一种推断、**轴的选择本身也要交未卷入方**；[新 oracle](methodology-new-oracle-discriminating-power-is-experimental.md) 失效主形态是「相邻」非「离谱」
- [用例名集合 diff 必须运行时枚举 / mutation control 自身要自证改到了代码](methodology-test-name-audit-must-enumerate-at-runtime.md) — grep 扫 `test("...")` 对参数化+模板名结构性失明，方法不可靠而结论碰巧对时没有任何信号；[mutation 生效](methodology-verify-the-mutation-actually-applied.md) 「没变红」有两解=测试没咬住 vs mutation 根本没生效
- [迁 oracle 到生产构造时绝不顺手削断言](methodology-migrating-an-oracle-must-not-weaken-its-assertions.md) — 「新构造下不再产生」几乎总是驱动少了一拍；删既有断言须扫参数证性质不存在；注释与断言自相矛盾是最廉价探测器
- [spec 里的机制性解释必须有实验背书](methodology-mechanism-story-in-spec-must-be-experiment-backed.md) — 给现象配的合理机制别当事实写；**事后归因同形**（diff 只证明结果、区分不了三种机制），分辨判据=我的解释能预测出别的可观测后果吗；编出来的根因会连带产出不防复发的修法
- [ctx 共享可变裁决会被落败 hedge candidate 污染](methodology-request-scoped-mutable-verdict-poisoned-by-hedge-candidates.md) — hedge 默认开
- [「一个终态」≠「一个完整终止符」](reference-exactly-one-terminal-is-not-exactly-one-complete-terminus.md) — 合成 end_turn 不补 message_stop 真 SDK 抛 stream ended
- [中止成因在产生点打标签、别在边界猜](methodology-abort-provenance-tag-at-source-not-guess-at-boundary.md) — fall-through 猜原因=日志/History/客户端三处一致撒谎(609ms 报成 900s 超时)；AbortSignal.any 本就透传 reason 是传输层扔的；preflight 与 mid-wait 两分支须分别 mutation；边界写有序 precedence、每臂要正向证据
- [关机 Step 1 停的是新增工作还是在途资源](methodology-shutdown-step1-stop-new-vs-kill-inflight.md) — 拆在途请求正用的资源=用 Step 1 撕毁 Step 2 的 drain 承诺；同族不对称(WS 有 stopNew/closeAll 拆分而 h2 没有)即红旗；取证看同刻兄弟请求是否存活
- [appliesTo 命中 ≠ 链被驱动](methodology-appliesto-matches-but-chain-never-driven.md) — 先数驱动点的生产调用点再下「没生效」结论；缺驱动点=整条链全体落空，别按单钩子估波及面
- [config.yaml 每请求覆盖 setStateForTests](reference-config-yaml-overwrites-setstatefortests-per-request.md) — 全应用测试钉 config-managed 键是空操作；指纹=同一 policy 一半听测试一半听配置；mutation 要破坏生产代码别翻状态
- [修全部比较点](feedback-fix-all-comparison-sites.md) — 归一化键/id bug 多点复发；grep 全仓逐处修+抽共享 primitive
- [修一条约束别自造兄弟约束违规](methodology-fix-one-constraint-violates-sibling-constraint.md) — 对象级约束要一起断言
- [名实不符变量+双源值](methodology-lying-variable-name-dual-source-value.md) — 名字断言单一身份、值取自会撒谎的源(原始vs已变换)
- [变体路由既有 outcome + 穷尽 Record 审计](methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit.md) — 复用全 handler + 类型系统逼出全站点
- [穷尽 Record 全填≠活路径在读它](methodology-exhaustive-record-proves-table-not-that-live-path-reads-it.md) — 上一条的界限：formatError 无生产调用者时四张表全绿而 wire 照旧；消灭双份+从真实入口读字节+mutation 打在共享表上
- [新策略被更宽 matcher 首命中遮蔽](methodology-new-strategy-shadowed-by-broader-first-match.md) — 加 retry 策略前 grep 同错误子串既有 matcher
- [全套件红先分类再套污染 playbook](methodology-full-suite-red-classify-before-pollution-playbook.md) — 单跑过+全套件挂才真污染
- [随机 false-red 的另一半嫌疑：判据挂在进程全局量上](methodology-false-red-from-process-global-quantities-not-the-mechanism.md) — 「修完一条换一条」即信号；与污染并列查、可同时成立；全局 timer 集合当 retry oracle、wall-clock 预算当通过条件；换直接观测目标机制的 oracle 或按机制设文件级预算，别逐条打地鼠
- [收尾文档在合并落地那一刻变陈旧](methodology-closeout-doc-goes-stale-the-moment-the-merge-lands.md) — 写「待合并/尚未/下一步是 X」时就登记为会过期断言；用户说「已合并」是收尾中段不是终点；grep 全部携带者、把判定翻成正向可复跑命令（方向也要翻）；合并后新写的那批也要声明自己未合并
- [并发 agent 不得共享 worktree 做 mutation](methodology-concurrent-agents-must-not-share-worktree-for-mutation.md) — 主会话调度责任
- [transport-config 新字段：纯路由标志绝不进 change-detection](methodology-new-transport-config-field-routing-vs-connection-rebuild.md) — 任一追踪字段变化 fire 全体 listener(含 h2 session retire)
- [append 日志 tail 游标两静默丢失陷阱](methodology-append-log-tail-cursor-silent-loss-traps.md) — 同毫秒 tie-break 永久丢行+per-row hydrate 抛错卡死
- [响应改写器的 lookahead 不得吞协议有效空帧](../todo/2026-07-22-client-proxy-keepalive-300s.md) — 空载荷不等于无语义；先 curl -N 逐层抓字节
- [架构图优化 Agent 上下文经济](feedback-architecture-map-optimize-agent-context-economy.md) — 价值轴=上下文经济+可信度
- [交用户前先 subagent review（含 in-chat 提案）/ 用户对齐只证方向非细节最优](feedback-subagent-review-before-any-user-facing-proposal.md) — 审查门适用任何交付物含对话里直接呈现的设计；[用户对齐](feedback-user-alignment-confirms-direction-not-detail-optimality.md) 逐节点头≠细节最优
- [后台 agent 运维：瞬时抖动只 SendMessage；context-window 400 停旧 agent、从 transcript/commit/worktree 接力](feedback-backend-flakiness-must-sendmessage-resume-no-alternatives.md) — 强制单一路径 resume 原 agent、绝不重派或换模型；[dead check](feedback-proactive-liveness-dead-check-on-background-agents.md) mtime 只是**弱信号**、须配「远超合理时长」或明确失败信号；不为判活发空探测（收益低于风险），但**「探测会打断运行中 agent」是 2026-08-02 的误判、已被时间线证伪**（中断早于探测 118 秒且探测未送达）——**只证得了「不是探测」，真因未定**，别再补第二个猜测
- [网络失败强制原会话恢复，但完整成功样本不追溯失效](feedback-network-failure-resume-does-not-invalidate-success.md) — 失败尝试必须恢复；已完整交付并验证的成功批次不因后续网络错误自动作废
- [共享主线前进不是失败信号](feedback-moving-shared-head-is-not-failure.md) — 已合并且有验收证据后，无关 peer commit 不触发重复全量复验；真实失败或相关变化才升级
- [单一权威来源允许语境完整复述](feedback-one-authority-allows-contextual-restatement.md) — 一个权威裁决来源≠只能出现一次；各读者语境可完整复述并引用，真单写入源仍唯一
- [计划红绿 mutation 预测可能错、执行期真跑验证](methodology-plan-red-green-mutation-prediction-can-be-wrong-verify.md) — plan「注释 X→变红」可能不咬
- [git commit -- pathspec 取工作区非 index / 共享 worktree 绝不 amend](git-commit-pathspec-commits-worktree-not-index.md) — 共享 worktree 最终提交一律 pathspec；[amend](git-amend-in-shared-worktree-clobbers-peer-commit.md) peer 在你 commit 与 amend 之间提交→你静默改写对方 commit，reflog 取回原 message 立刻还原(先验 tree 一致)
- [语义合并冲突暴露对方 timing 潜伏 bug / 别合进 peer 多提交重构中间态](methodology-semantic-merge-conflict-exposes-latent-bug-via-timing.md) — 两边各绿合并却坏；[中间态](methodology-dont-merge-into-midflight-multicommit-refactor.md) rename/usages 跨提交
- [谁合并谁退让但必须合并 / 空 pathspec stash push 会误 pop 别人 WIP](feedback-merger-yields-but-merge-must-happen.md) — 退让=行级共存两份保+备份→选择性 stash→FF→pop 三方合并；[空 pathspec](git-stash-push-empty-pathspec-pops-peer-wip.md) 无改动 path 不建 stash → pop 误弹栈顶别会话 WIP
- [按 gitBranch 字段找并发 session](find-claude-session-by-git-branch.md) — ~/.claude/projects/<path>/\*.jsonl 的 gitBranch 字段精确命中=强信号(+100)
- [陈旧特性 re-merge 撞底座重写](methodology-remerge-stale-feature-across-subsystem-rewrite.md) — 取 master 结构+重放我的 delta
- [合并主线使分支冻结的测试地板失效](methodology-merge-invalidates-branch-frozen-test-floor.md) — 集合取并集、标量按合并态实跑重取（两侧数字都错）；JUnit 交叉验证只数叶节点、别按 suite 属性求和
- [eslint --fix 宽扫入并发既有 dirt](tooling-eslint-fix-broad-sweeps-concurrent-dirt.md) — 宽集只 check 不 fix
- [lint-staged 已移除](tooling-lint-staged-revert-blocks-edit.md) — 2026-06-29 起无 pre-commit 门禁
- [覆写迁移前审计真实库原始字段](methodology-migration-audit-raw-fields-not-just-projection-oracle.md) — projection-等价 oracle 对已死字段盲
- [一次性 connected 快照须常驻根订阅 / 消费者只在富快照上读到字段](methodology-one-shot-connected-snapshot-needs-root-subscriber.md) — WS connected 携初始快照无缓存；富/轻快照变体 + 高频轻量事件覆盖最后 ctx → 字段恒 undefined 且 injection 单测假绿，修法=字段放所有变体共有顶层 + 用真实 bus 高频事件 IT，见 [enriched-snapshot](methodology-consumer-reads-field-only-on-enriched-snapshot.md)
- [穷举可行方案面再择优](methodology-exhaust-then-choose-over-single-solution.md) — 并行 subagent 分层穷举→实测 supersede 源码推断→异模型审→exp/FINDINGS 择优
- [合并态审才抓得到的两类集成缝](methodology-cross-phase-integration-seam-only-caught-at-merged-state.md) — 跨 phase：Phase A 契约被下游漏接线，逐 task 审看不到；[环境/路径分支缝](methodology-merged-state-review-catches-env-branch-seam.md) per-task+全量都证不了，合并态审须点名每条路径第一人称走查
- [CLI e2e spawn+hook 两机制](reference-cli-e2e-spawn-and-hook-load-gotchas.md) — hook data-URL 丢具名导出→帧存 base64
- [Bun 忽略 import ?v= query；热重载用项目内唯一文件](reference-bun-esm-cache-busting-query-fails-data-url-works.md) — Bun 按路径缓存 ESM
- [picocolors 在 bun test 塌缩成恒等](reference-picocolors-collapses-to-identity-in-bun-test.md) — 改测引用相等 + FORCE_COLOR 子进程 SGR
- [迁移副作用旧路径仍被 eager 求值→双触发](methodology-migrate-side-effect-old-path-still-eager-evaluated.md) — driver eager 求值 deps.strategies 仍触发
- [无疑问改进当场做 / 写设计前先核实功能没被 peer 落地或删除](feedback-slam-dunk-fixes-do-immediately.md) — 更好+无取舍+无分叉三条全中立即改；[先核实](feedback-verify-deferred-task-not-already-landed-before-designing.md) 接手第一条命令=`git log <merge-base>..master -- <路径>`，grep 不到 ≠ 没做
- [一定规模项目按自洽批次迭代交付，不做 all-in-once](feedback-layered-iterative-delivery-not-all-at-once.md) — 每批可独立运行、验证与回滚，阶段间显式闭合
- [绝不推荐短期止血方案](feedback-never-propose-short-term-mitigation.md) — 有根因可修就只提根因；「打开 gated feature 绕过」也禁列
- [恢复是唯一出路而非风险取舍](feedback-recovery-is-only-path-not-risk-tradeoff.md) — 连接已死重连是唯一出路；沉没账与重试无关、别框成双计费取舍
- [结构重构提交前跑架构守卫/全 backend](methodology-run-architecture-guards-before-structural-refactor-commit.md) — grep 源码形状/schema 完备性守卫不在直接目录
- [现有代码无权威、别为将就它降格最佳方案](feedback-existing-code-has-no-authority-dont-accommodate.md) — 诡异症状=设计错证据
- [剥离成可插拔前先核实抽取程度+缝位](methodology-verify-extraction-state-and-seam-before-pluginizing.md) — 先查是否已纯函数别重包装
- [Agent 恢复与接力分界：可调用上下文用 SendMessage；context-window 终态用新 agent 读旧证据](feedback-resume-agent-always-sendmessage-never-agent-tool.md) — 已终止/完成 subagent 接续永远 SendMessage
- [Agent 两类容量终态：5 MiB 读取闸门可修；模型 context-window 400 必须换新 agent 接力](reference-subagent-transcript-5mib-gate-blocks-resume.md) — 报「No transcript found」但文件好端端在；`n7e=5242880` 闸门走 postBoundaryBuf 而子 agent 无 compact 边界→空；**单调越界非抖动**；治本设 `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` 重启、治标裁连续尾切片

## project 现状 stub（权威看正式归属；landed 项细节在 docs/DESIGN/git，此处仅触发指针）

- [领域包剥离执行技巧（token·telemetry landed）](methodology-domain-peel-execution-techniques.md) — 两型模板(SoT 反转 / 只读消费+module-split)+共通技巧+ratchet 与守卫两类坑
- [state 降 foundation 叶子（landed master `9ec79010`, 2026-07-29）](project-state-to-foundation-handover.md) — 环 70/63→43/50·state 零环；**实质产出是判据形状的演化**（十轮复评没改一行 state 代码、全在改守卫怎么判）；方法 → skill `reshaping-a-bypassed-guard`，事故取证 → [[methodology-relocate-invariant-when-guard-cannot-keep-up]]
- [续写重试（P2 landed master de37feff，P3-P7 待续）](project-continuation-retry-sequential-anchor.md) — 首块后 cut 合成 continuation 缝合
- [max_tokens 续传 + keepalive 边界（max_tokens P0 landed 3bb1262a，max_tokens P1 未开工）](project-max-tokens-continuation-spec.md) — 截断三分型 A/B/C；keepalive 现网边界=pre-content-only、**inter-block allocator 方案 A 实施中**（其 P1+P2 已完成待审、与 max_tokens P1 是两个不同的 P1，别混），见 [timeout-safety](project-keepalive-unconditional-timeout-safety-landed.md)；**接手先读 docs/plan/2026-07-27-handover-max-tokens-and-keepalive.md**
- [History 三件（搜索 sidecar landed 2026-07-21 / 三层归档 27b65b89 / client-upstream 双腿 5db1aff6）](project-history-search-out-of-process.md) — sidecar=独立常驻 systemd 服务·主进程从不 spawn/监管；[归档](project-history-tiered-archive.md) HOT→tier-1→sealed·move 永不真删；[双腿](project-history-client-upstream-legs-landed.md) clientRequest/clientResponse+model{}+attempts[]
- [合成/改写帧 forwarded 轨完整性（landed master 2026-07-20）](project-synthetic-frame-forwarded-track-completeness-spec.md) — Unit1 前提被 V3 实测推翻(只治瞬态快照)
- [Responses 三件（buffered-merge landed master / Codex tier-1 硬化 / runtime-split）](project-responses-buffered-merge-landed.md) — 托管 reducer+两旋钮·drop-delta 默认作用所有 Responses 流；[tier-1](reference-undici-websocket-runtime-split-bun-vs-node.md) 关闭码1000+guardCallback+**下游保活**+opt-in buffered(此处「默认 OFF」指 tier-1 原始 buffered retry、非 buffered-merge)、Bun→原生 WS 有 ping / Node→真 undici 无 ping
- [transport 配置三轴归位 2c19c7cf + h2 池按容量选路 N=1 36cf45bf](project-transport-config-three-axis-reorg.md) — timeouts/upstream_transport/responses_ws；[h2 池](project-h2-pool-capacity-routing-and-pre-response-retry.md) 消灭并发流 blast-radius
- [上游静默 commit 时机与 direct live B2（已本地集成；buffered／translated 待续）](project-upstream-silence-commit-timing-spec.md) — 证伪等-header 判别；**接手看 docs/plan/2026-07-23-handover-h2-pool-and-silence-spec.md**
- [对称四点 hook 架构 v3 2a77bf7c（v2 118a9c33 已被其取代）](project-symmetric-four-point-hooks.md) — client/upstream×in/out+exchange；[v2 中间件](project-upstream-hook-middleware.md) 三挂载点接口**已退役**、仅存历史；hook 帧进上游轨必打 synthetic 标记
- [请求生命周期 cancel/settle/quiesce + 首包时序埋点 f982e0e3（均 landed）](project-request-lifecycle-cancel-settle-quiesce.md) — 多根因；[埋点](project-request-timing-instrumentation-landed.md) 上游4刻/客户端3刻/DDSketch
- [AskUserQuestion 顶层 question 键抢救（landed）](methodology-plan-verify-interface-location-and-wiring-channel.md) — salvage→兜底 header→strip
- [block 级缓冲重试 c2012555 + 上游错误→客户端形态整形 5202f110（均 landed）](project-block-level-buffered-retry-execution.md) — **默认值分 vendor**：Anthropic `protect_streaming_generation` 默认 false / Responses·CC `buffered_retry` 默认 **true**（2026-07-14 翻转，`config.yaml` 为准；DESIGN.md 该行仍写「默认全 OFF」已漂移）；[整形](project-upstream-error-client-shaping.md) 按 commit 阶段分治·剩余敞口=MED-3 AUQ 交互式渲染未实测
- [翻译四件（矩阵 / 直接桥 / reasoning 透传 / codec cell-assembly，均 landed）](project-universal-translation-matrix.md) — 4入站×3出站 hub-spoke·反向绝不合成 thinking；[直接桥](project-anthropic-responses-direct-bridge.md) lossless-per-pair 默认；[reasoning](project-reasoning-passthrough-synthetic-thinking.md) summary:auto+**标签封装签名** round-trip(据此区分合成 signature 与真 Claude signature)；[codec](project-inbound-outbound-cell-assembly-refactor.md) **(clientFormat×targetEndpoint) 双轴**穷尽 Record·漏填某 cell 即缺陷
- [unknown endpoint 日志（landed，权威 spec）](../spec/2026-07-14-unknown-endpoint-logging.md) — 404/405/route-owned 三态分类 + 可配置日志级别；[auto-truncate 移除 landed 06c56644](project-remove-auto-truncate-keep-calibration.md)；[web_search 双跳退役](project-web-search-double-hop-retired.md) 教训=称职实现≠有需求
- [遥测分层持久化（landed master）](project-telemetry-tiered-storage.md) — telemetry.db 三层 rollup+DDSketch；cost防2^53
- [交互式 TUI live 面板（P0 merge，P1/P2 待做）](project-tui-interactive-live-panel.md) — 折叠 footer↔面板↔detail
- [ui-v4 shadcn 重设计（未实施）+ 代码由 agent 协作编写 + 样式分叉先问](project-ui-v4-shadcn-redesign-decisions.md) — new-york+锐角+Amber+布局 A；[agent 编写](feedback-ui-v4-code-authored-by-agents.md) 不用"手搓"贬义·重构自由度放宽(守可恢复性)；[样式先问](feedback-discuss-styling-before-deciding.md) 视觉分叉列选项+推荐再 AskUserQuestion（**待迁入 CLAUDE.md/ui ADR 后本行只留 stub**）
- [v4 流水线重构 / GHC 三特性对齐 / thinking 400 三层修复（均 landed）](project-v4-pipeline-rearchitecture.md) — v4 P0-P3+response-pipeline Stage A/B；[GHC 三特性](project-ghc-feature-alignment-landed.md) tool-search **手动列表→default-allow**·extended-cache-ttl·memory tool；[thinking 400](../spec/2026-07-07-thinking-signature-quarantine.md) + skill `ghc-anthropic-upstream`(根因=相邻性)
- [反应式学习 TTL 生命周期 67afa1af + 后台 agent 结果 surfacing 故障](project-negotiation-learning-lifecycle-landed.md) — per-entry TTL+pin；[surfacing](methodology-background-agent-result-surfacing-failure.md) result 正文空且救不回

## 已删除记忆的话题去向

通用工作原则 → user-rule + CLAUDE.md + skill `session-closeout` / `git-preference`。已归档完成叙事 → `docs/archive/memory/`。散落调试参考收编为 on-demand skills（`bun-node-runtime-gotchas` / `debugging-*` / `ghc-*`）。
**两个从未存在的 memory 文件已改指正式归属**（2026-08-02，避免制造双源）：语言规则 `feedback-chinese-only-never-japanese` → user-rule `10-text-formatting`/`01-core-principles`；`project-unknown-endpoint-logging` → [spec/2026-07-14-unknown-endpoint-logging.md](../spec/2026-07-14-unknown-endpoint-logging.md) + `DESIGN.md` 活架构表。
