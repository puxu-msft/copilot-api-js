# 记忆库索引（话题 → 归属引用地图）

纯引用层：实质在正式归属（skill / `docs/` / ADR / user-rule），下方每行 stub。合并/清理前 deep-read 正文，不只凭钩子。

## 已下沉到项目 skill 的方法论（记忆文件 = stub 指向）

- [sync→async 持久化不变量](methodology-sync-to-async-persistence-refactor-invariants.md) → skill `persistence-async-invariants` §1 — drain-before-close / pending Set 不靠 bus / re-entrancy 守卫 / never-throw / 全调用方 await
- [信号在 committed settle 点记录](methodology-record-signals-at-committed-outcome-not-per-attempt.md) → skill `persistence-async-invariants` §3 — per-attempt 累积 + onAttemptReset 清空 + committed flush；不丢 ≠ 不清
- [settle 冻结 history entry 快照](reference-settle-freezes-history-entry-record-before-fail.md) → skill `persistence-async-invariants` §2 — client-facing 数据须 settle 前 record；新顶层字段三处必改
- [可扩展遥测 registry 三支柱](pattern-extensible-telemetry-registry.md) → skill `telemetry-architecture` 一 — 下沉 sink 层 / 开放 counters bag / 不可重算因子拆最细
- [遥测 model key 成功失败分裂](reference-telemetry-model-key-split-success-vs-failure.md) → skill `telemetry-architecture` 二 — 成功腿=规范名、失败腿=客户端别名；双侧 normalizeModelId
- [迁移框架 Umzug hybrid](methodology-migration-framework-hybrid-forward-runner.md) → skill `history-sqlite-schema` — hybrid forward-runner / partial-DDL wedge / 跨-runtime e2e 需 bundle
- [内容寻址归一化边界剥离](methodology-content-addressed-normalization-boundary-strip.md) → skill `history-sqlite-schema` — config-无关 canonical 投影（递归剥 cache_control）/ 独立 oracle
- [可恢复 backfill 协作停 + keyset](methodology-recoverable-backfill-cooperative-stop-and-keyset.md) → skill `history-backfill` — 协作 stop / (started_at,id) keyset / dedup-ratio tripwire
- [派生列 backfill 靶向 + 非阻塞](methodology-derived-column-backfill-targeted-and-nonblocking.md) → skill `history-backfill` — 靶向解压别 `SELECT *` / 非阻塞后台 / 等价性 oracle
- [逐字节等价是代理按消费者校准](feedback-byte-equivalence-is-proxy-calibrate-by-consumer.md) → skill `large-refactor` §7 — 真 invariant = 对在意消费者无可观测变化；三层 oracle
- [sed 碰过的文件裹入在飞工作](sed-touched-files-bundle-inflight-work.md) → skill `large-refactor` §6 — `git diff --cached --stat` 逐文件对账（1 行改显 170 churn = 红旗）
- [声称完备前多维度自审](feedback-multidim-completeness-audit-before-claiming-done.md) → skill `empirical-verification` — 活路径 / 传输分层 / 可观测性（合成 vs 真实可区分）/ 副作用四维
- [UI 交付必跑 build:ui](feedback-verify-ui-with-build-not-just-typecheck.md) → skill `debugging-frontend-tests` — 根 typecheck 不覆盖 ui-v4;`~backend/*` 须纯;权威门 `typecheck:ui-v4`+rollup
- [改共享 mock 契约打爆 sibling 测试](methodology-shared-mock-contract-change-breaks-sibling-test-files.md) → 拟下沉 `debugging-frontend-tests` — 改 mock 签名只更新点名那个;grep 全 `vi.mock` 逐改 + 每 task 跑全量
- [动大工程前核实命名目标](feedback-verify-named-target-resolves-before-large-work.md) — 用户命名目标先 find/ls 核实解析到哪个真实产物;踩坑=做进 Vue `ui/` 实际是 React `ui-v4/`
- [测试绝不碰真实环境](feedback_tests_never_touch_real_env.md) → skill `test-isolation` — DI 注入临时目录（Bun 忽略 `env.HOME`）；地板 = bunfig preload 沙箱

## 已下沉到 ADR（记忆文件 = stub 指向）

- [richest-data-flow 后端完整存](feedback-richest-data-flow-store-complete-no-pruning.md) → ADR `2026-07-05-richest-data-flow` — 后端永不为 DRY/YAGNI 裁剪；"无数据源"常是没接线该建非删
- [合成帧必打可辨识标记](feedback-synthetic-data-must-be-distinguishable-from-real.md) → ADR `2026-07-05-richest-data-flow`（对称面）— 上游轨绝不含合成物、合成物只进 forwarded 轨打标记

## 精炼保留（verification 簇 / 独有教学价值）
- [通过/空/干净/自洽/doc-vs-code 不自证](feedback-pass-null-clean-not-self-validating.md) — verification 簇根;通用手法 user skill `verifying-authoritative-claims`；三陷阱钩子
- [reasoned-safe≠tested / producer wire-oracle 必断全序](methodology-reasoned-safe-not-tested-producer-wire-oracle.md) — 能干 reviewer「推理上安全无需测」也会错(opus 误判 enveloped_ping,golden 证伪);client-facing wire 缺陷须 producer oracle 断**完整帧序**+驱动 driver **真实产出**(非回放 ideal fixture);门改语义先问旧前提是否失效
- [client 源码 grep ≠ REST 上游能力](methodology-client-source-grep-not-rest-capability-probe-endpoint.md) — 源码 grep 只证 client 行为,代理型上游 REST 表面 > client 子集;须 curl 实测打端点;实例=「GHC 无 count_tokens」被证伪
- [从 primitive 推理别从流行 wrapper 泛化](methodology-reason-from-primitive-not-dominant-wrapper.md) — 干净 primitive(`setUpstreamFetchForTests`) vs 耦合全局 wrapper(`applyFetchMock`)并存,判风险从 primitive 实现推理
- [归 config 还是归代码：先辨丢信息 vs 等价变换](methodology-classify-lost-info-vs-equivalence-before-config-migration.md) — 「转换交给 config」别直译;丢信息→config 策略,拼写等价→回查 /models catalog;移隐式转换前追 resolvedName 定爆炸半径
- [面向用户永久只用中文、禁日语](feedback-chinese-only-never-japanese.md) — 输出层自检语言=中文;内部推理语言无所谓
- [写 plan 引用现有接线须核实位置与桥接](methodology-plan-verify-interface-location-and-wiring-channel.md) — 同名 interface 核实确切文件;**recordFeature 不落盘,持久化 prepare 诊断走 pipelineInfo**;新 union 打爆 ui-v4 穷尽 Record
- [畸形 tool_use 全人群扫描法](methodology-malformed-tooluse-full-population-scan.md) — 查全 decode error 别只看 error_message;扫 upstream blob 分真缺陷 vs abort 伪畸形;实例=\uXXXX 击中 opus-4.8
- [配置哲学独立：留兼容层 + 警告并继续](feedback-config-philosophy-separate-compat-and-warn-continue.md) — 配置**不**享代码「无向后兼容负担」;键重命名留旧键别名读时映射;运行时热重载绝不因配置问题杀进程
- [微改动别反射式派 subagent 评审](feedback-tier-subagent-review-skip-for-mechanical-micro-changes.md) — `subagent-explicit-rubric` 须与 user-rule 41 `tiered-review-by-risk` 合读;机械低风险走 TDD,微改攒批合并态审
- [eslint --cache 假绿](tooling-eslint-cache-false-pass.md) — `--cache` 对缓存过期文件假绿;`lint:all` 已去 cache、核单文件用 `bunx eslint <path>`
- [node_modules 存在 ≠ 锁文件事实](reference-node-modules-presence-not-lockfile-truth.md) — 可能是 `bun install` 会 prune 的 orphan;选依赖前 `grep '"<pkg>@' bun.lock`;提升传递依赖用 `bun add <name>@^<锁里版本>`
- [worktree bun add 后主树须补 install](reference-worktree-bun-add-needs-main-tree-install-after-merge.md) — 隔离 worktree `bun add` 只进该树;FF 合并后主树 node_modules 陈旧→Vite 解析失败;收尾动过 deps 须主树 `bun install`
- [编译错误：补符号 vs 删引用](methodology-broken-reference-supply-vs-delete.md) — 按消费者契约 + 独立 oracle 裁决,别反射式"让它编译"
- [修全部比较点](feedback-fix-all-comparison-sites.md) — 归一化键/id bug 多点复发;grep 全仓逐处修+抽共享 primitive;盲区=grep 漏分叉源腿,靠合并态审逮
- [变体路由既有 outcome + 穷尽 Record 审计](methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit.md) — 多站点加变体:路由既有 outcome 复用全 handler + 类型系统逼出全站点
- [新策略被更宽 matcher 首命中遮蔽](methodology-new-strategy-shadowed-by-broader-first-match.md) — 加 retry 策略前 grep 同错误子串既有 matcher(首命中即止);收紧旧正则+新策略排前
- [全套件红先分类再套污染 playbook](methodology-full-suite-red-classify-before-pollution-playbook.md) — 全套件红≠污染;单跑挂=oracle 漂移/flake,单跑过+全套件挂才真污染;`git log -S` 定 peer commit
- [架构图优化 Agent 上下文经济](feedback-architecture-map-optimize-agent-context-economy.md) — 价值轴=上下文经济+可信度非可推导性;目录级关系图+现状小节+L1 存在性守卫测试
- [交用户前先 subagent review（含 in-chat 提案）](feedback-subagent-review-before-any-user-facing-proposal.md) — 审查门适用任何交付物含对话里直接呈现的设计;present-design 前插对抗审查
- [git commit -- pathspec 取工作区非 index](git-commit-pathspec-commits-worktree-not-index.md) — 共享 worktree 最终提交一律 pathspec,免疫 peer 并发 `git add` 的 index race
- [eslint --fix 宽扫入并发既有 dirt](tooling-eslint-fix-broad-sweeps-concurrent-dirt.md) — 宽集只 check 不 fix;手排自己 import;显式 pathspec 只提交自己文件;[[sed-touched-files-bundle-inflight-work]] eslint 版
- [lint-staged 已移除](tooling-lint-staged-revert-blocks-edit.md) — 2026-06-29 起无 pre-commit 门禁;rollback 见 skill `git-preference:disarming-lint-staged-rollback`
- [覆写迁移前审计真实库原始字段](methodology-migration-audit-raw-fields-not-just-projection-oracle.md) — projection-等价 oracle 对已死字段是盲的;覆写 blob backfill 前只读探针枚举真库实际字段 vs 适配器映射
- [一次性 connected 快照须常驻根订阅](methodology-one-shot-connected-snapshot-needs-root-subscriber.md) — WS `connected` 携初始快照是一次性无缓存;snapshot-then-delta 消费者须挂常驻宿主(AppShell)
- [穷举可行方案面再择优](methodology-exhaust-then-choose-over-single-solution.md) — 单点方案常建于半对推断;流水线=并行 subagent 分层穷举→实测 supersede 源码推断→异模型审→exp/FINDINGS 择优
- [跨 phase 集成缝只在合并态审能抓](methodology-cross-phase-integration-seam-only-caught-at-merged-state.md) — Phase A 契约被下游漏接线逐 task 审看不到、只 whole-branch 逮;死枚举是红旗;查权威 ground truth 非凭 plan 假设
- [CLI e2e spawn+hook 两机制](reference-cli-e2e-spawn-and-hook-load-gotchas.md) — hook 经 data-URL 加载含 `JSON.stringify` 丢具名导出→帧存 base64;`proc.kill()` 漏杀真 server→端口精确 pkill;claude 认端点须 `ANTHROPIC_AUTH_TOKEN`;权威 `exp/cli-e2e-stall/FINDINGS.md`
- [Bun 忽略 import ?v= query、热重载须 data-URL](reference-bun-esm-cache-busting-query-fails-data-url-works.md) — Bun 按解析路径缓存 ESM,`?v=` 静默返旧;可行=`Bun.Transpiler.transformSync`→`import("data:...")`
- [picocolors 在 bun test 塌缩成恒等](reference-picocolors-collapses-to-identity-in-bun-test.md) — `isColorSupported===false` 使 color-fn 返原串测退化文本;改测**引用相等**+FORCE_COLOR 子进程 SGR
- [迁移副作用旧路径仍被 eager 求值→双触发](methodology-migrate-side-effect-old-path-still-eager-evaluated.md) — recordFeature 迁 leg 但 driver eager 求值 `deps.strategies` 仍触发→双记;live-only golden 抓不到;根因修=抽 lazy resolver
- [无疑问改进当场做](feedback-slam-dunk-fixes-do-immediately.md) — 更好+无取舍+无分叉三条全中就立即改,别以超范围推迟;有分叉别硬当无分叉

## project 现状 stub（权威看正式归属）
- [block 级缓冲重试（P0-P4 全 landed+reviewed，剩 gated 翻转+收尾）](project-block-level-buffered-retry-execution.md) — 4 端点非对称粒度(P2块级/P3CC+P4WS terminal-only/P1 已接线);**已 merge master c2012555(默认全 OFF)**;durable ledger .superpowers/sdd/progress.md;P1 四连 wire 缺陷全被绿测放过→3轮修+capstone([[methodology-reasoned-safe-not-tested-producer-wire-oracle]]);翻默认前门=真 CLI+scenario-B(记 backlog)
- [上游错误→客户端可行动形态整形（spec+plan，评审中，未实现）](project-upstream-error-client-shaping.md) — 按 commit 阶段分治,无单一万能手段;Phase 6 依赖 P1;权威 docs/spec+plan/2026-07-13-upstream-error-client-shaping;[[methodology-exhaust-then-choose-over-single-solution]]
- [auto-truncate 移除 + calibration 重定位（已实施，未合并）](project-remove-auto-truncate-keep-calibration.md) — 删截断保 calibration;worktree 有 rebase 风险;权威 RFC/plan 2026-07-13-remove-auto-truncate-keep-calibration
- [web_search 双跳退役（2026-07-13 全 landed）](project-web-search-double-hop-retired.md) — 双跳+config 键整套删;教训=称职实现≠有需求;权威 ADR 2026-07-13-server-tool-positioning-and-web-search-retirement
- [上游 hook 中间件（spec v2 定稿，待用户审→plan）](project-upstream-hook-middleware.md) — driver 三挂载点 ad-hoc hook;承重=hook 帧进 history 上游轨必打 synthetic 标记;热重载 data-URL;权威 docs/spec/2026-07-12-upstream-hook-middleware.md
- [通用翻译矩阵（Phase 0-7 全 landed master）](project-universal-translation-matrix.md) — 4入站×3出站 hub-and-spoke;承重=反向绝不合成 thinking 块、三反向 pump 须 streamError 门;权威 RFC v5 + DESIGN.md
- [codec 对象模型重构 cell-assembly（C0-C6 全 landed master + 全部清理项完成）](project-inbound-outbound-cell-assembly-refactor.md) — 集中化 (clientFormat×targetEndpoint) 双穷尽 Record 治两轴错配;结构核存活、策略半重设计;审 0BLOCK/1HIGH([[methodology-migrate-side-effect-old-path-still-eager-evaluated]]);**4 codec 出站方法/死 accessor 已删（死码靠「唯一写入方已删→恒 undefined」判定 + 删前核持久化通道已迁 ctx；测试迁 cell 新 owner 非删断言；byte-critical responses 段核实响应侧共享 fallbackScratch 同实例+reverseExchange 惰性重建）+ HIGH-1 hub 提取（renderResponsesFrameToCc→hub 工厂）+ gemini 剥前缀（目录/符号/dry-run 标签/doc，DESIGN.md 路径改动过 L1 存在性守卫）；gemini cc delegate 移除评估不采纳（出站删后收缩为合法响应侧复用、移除=重复）**;入口 docs/plan/inbound-outbound-split/
- [遥测分层持久化（P0-P7 全 landed + reviewed + 已 merge master）](project-telemetry-tiered-storage.md) — 单27MB JSON→独立 telemetry.db(三层 rollup+DDSketch+全可配);两用户决策(读源方案2 dimBuckets-live-cache/P7 单轨不保护旧UI);承重红线 cost micro防2^53·SQLite只存sketch无固定桶列·γ绑db防热重载wedge·cumulative-cap DB-seeded;教训 对抗审查逼出2静默持久化缺陷(MAJOR-1 db-null-OOM/MAJOR-2 γ-wedge)·合并态评审抓集成缝(backfill不cap/死钮/doc-sync漏)·stale-base分类·cwd漂移;权威 spec+plan+DESIGN活的架构现状
- [交互式 TUI live 面板（P0 merge，P1/P2 待做）](project-tui-interactive-live-panel.md) — 折叠 footer↔展开面板↔detail+行级动作;P0 终端层重组落地;权威 RFC/ADR/plan 2026-07-10-*;待用户真终端复验 Q2/Q3
- [ui-v4 shadcn 重设计决策（讨论中/未实施）](project-ui-v4-shadcn-redesign-decisions.md) — 切 shadcn new-york+锐角+Amber+布局 A;权威 ADR ui-v4/docs/decisions/2026-07-10-ui-v4-shadcn-adoption.md;**代码 agent 协作写** [[feedback-ui-v4-code-authored-by-agents]]
- [ui-v4 代码由 agent 协作编写（非手搓）](feedback-ui-v4-code-authored-by-agents.md) — 措辞不用"手搓"贬义;重构自由度放宽(守可恢复性底线)
- [Codex/Responses tier-1 硬化已落地](reference-undici-websocket-runtime-split-bun-vs-node.md) — 关闭码1000+guardCallback+下游保活+opt-in buffered(默认 OFF);已 FF 入 master;[[reference-undici-websocket-runtime-split-bun-vs-node]];权威 DESIGN.md Codex/Responses 行
- [runtime-split：undici WS Bun vs Node](reference-undici-websocket-runtime-split-bun-vs-node.md) — 裸 undici WS：Bun→原生(有 ping、容忍 1001)/Node→真 undici(无 ping、抛 invalid code);属 skill `bun-node-runtime-gotchas`
- [keepalive 无条件 timeout-safety 已落地](project-keepalive-unconditional-timeout-safety-landed.md) — 分支 MERGE-READY 待 user-run oracle+merge;权威 ADR 2026-07-09 + spec §10
- [v4 流水线重构](project-v4-pipeline-rearchitecture.md) — v4 P0-P3 + response-pipeline Stage A/B 全落地;权威 DESIGN.md + archive/2606-landed-rfcs/
- [GHC 三特性对齐已落地](project-ghc-feature-alignment-landed.md) — tool-search default-allow / extended-cache-ttl / memory tool;现状 skill `ghc-api-reference`
- [history client/upstream 双腿重构已落地](project-history-client-upstream-legs-landed.md) — clientRequest/clientResponse+model{}+attempts[];已 merge master 5db1aff6;权威 DESIGN.md「类型架构」
- [thinking「cannot be modified」400 三层修复（已并 master）](reference-undici-websocket-runtime-split-bun-vs-node.md) — 权威 docs/spec/2026-07-07-thinking-signature-quarantine + DESIGN.md + skill `ghc-anthropic-upstream`(根因=相邻性)
- [反应式学习记录 TTL 生命周期 + Learned 页](project-negotiation-learning-lifecycle-landed.md) — per-entry TTL+pin,单一判据 `isEntryActive`;门控只在 reader;已 merge master 67afa1af;权威 docs/spec/2026-07-08

## 已删除记忆的话题去向
通用工作原则 → user-rule + CLAUDE.md（方向明确别停/完成即提交/知识归类/subagent 核验/实验放 exp//git 暂存）+ skill `session-closeout` / `git-preference`。已归档完成叙事 → `docs/archive/memory/`。散落调试参考收编为 on-demand skills（无独立记忆条目）：`bun-node-runtime-gotchas` / `debugging-{claude-client-connection,server-crashes,ghc-api-upstream-transport}` / `ghc-anthropic-upstream` / `ghc-api-reference`。
