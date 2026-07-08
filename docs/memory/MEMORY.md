# 记忆库索引（话题 → 归属引用地图）

记忆库已降为**纯引用层**：每条教训的实质已搬进正式归属（项目 skill / `docs/` / ADR / user-level 规则），下方每个记忆文件是指向归属的 stub（正文一句钩子 + `→ 归属`）或去厚叙事的精炼实例。合并近义 / 清理陈旧前 **deep-read 正文**比对，不只凭本索引钩子。

## 已下沉到项目 skill 的方法论（记忆文件 = stub 指向）

- [sync→async 持久化不变量](methodology-sync-to-async-persistence-refactor-invariants.md) → skill `persistence-async-invariants` §1 — drain-before-close / pending Set 不靠 bus / fixture teardown 先 drain / re-entrancy 守卫 / never-throw / 全调用方 await
- [信号在 committed settle 点记录](methodology-record-signals-at-committed-outcome-not-per-attempt.md) → skill `persistence-async-invariants` §3 — L2 buffered-retry per-attempt 累积 + onAttemptReset 清空 + committed flush；不丢 ≠ 不清
- [settle 冻结 history entry 快照](reference-settle-freezes-history-entry-record-before-fail.md) → skill `persistence-async-invariants` §2 — client-facing 数据须 settle 前 record；新顶层字段三处必改（toHistoryEntry + onTerminal 投影 + updateEntry allowlist）
- [可扩展遥测 registry 三支柱](pattern-extensible-telemetry-registry.md) → skill `telemetry-architecture` 一 — 提取下沉 sink 层 / 开放 counters bag + 泛型复制器（零版本 bump）/ 不可重算因子拆最细
- [遥测 model key 成功失败分裂](reference-telemetry-model-key-split-success-vs-failure.md) → skill `telemetry-architecture` 二 — 成功腿=规范名、失败腿=客户端别名；双侧 normalizeModelId + unmatched 可见
- [迁移框架 Umzug hybrid](methodology-migration-framework-hybrid-forward-runner.md) → skill `history-sqlite-schema` — hybrid forward-runner（幂等地板不动 + 只追 001+）/ partial-DDL wedge / 跨-runtime e2e 需 bundle
- [内容寻址归一化边界剥离](methodology-content-addressed-normalization-boundary-strip.md) → skill `history-sqlite-schema` — config-无关 canonical 投影（递归剥 cache_control）/ own-line 边界正则容 `\r` / 独立 oracle
- [可恢复 backfill 协作停 + keyset](methodology-recoverable-backfill-cooperative-stop-and-keyset.md) → skill `history-backfill` — 协作 stop 匹配 shutdown phase / (started_at,id) keyset / meta-flag 守卫 / dedup-ratio tripwire
- [派生列 backfill 靶向 + 非阻塞](methodology-derived-column-backfill-targeted-and-nonblocking.md) → skill `history-backfill` — 靶向解压别 `SELECT *`（4.2G 库卡 3m53s）/ 非阻塞后台 / 等价性 oracle
- [逐字节等价是代理按消费者校准](feedback-byte-equivalence-is-proxy-calibrate-by-consumer.md) → skill `large-refactor` §7 — 真 invariant = 对在意消费者无可观测变化；三层 SSE / GHC wire oracle / history tripwire
- [sed 碰过的文件裹入在飞工作](sed-touched-files-bundle-inflight-work.md) → skill `large-refactor` §6 — `git diff --cached --stat` 逐文件对账 tripwire（1 行 cosmetic 显 170 churn = 红旗）
- [声称完备前多维度自审](feedback-multidim-completeness-audit-before-claiming-done.md) → skill `empirical-verification` — 活路径 / 传输分层 / 可观测性（合成 vs 真实可区分，最易漏）/ 副作用四维
- [UI 交付必跑 build:ui](feedback-verify-ui-with-build-not-just-typecheck.md) → skill `debugging-frontend-tests` — ui-v4 两条正交盲区:① 根 typecheck 不覆盖 ui-v4 子项目 + build:ui-v4(esbuild)不做类型检查 → 前端类型错双绿,权威门 `typecheck:ui-v4`;② `~backend/*` 模块须纯(不 import `~/lib/state`),typecheck+vitest 假绿只 rollup 暴露
- [动大工程前核实命名目标](feedback-verify-named-target-resolves-before-large-work.md) — 用户命名的目标（"ui-v4"）先 find/ls 核实解析到哪个真实产物，别凭记忆/plan 命名假设；踩坑：整套做进 Vue `ui/`、实际是 React `ui-v4/`（5173）；名字歧义 + 用户重复词 + 端口/URL = 必查锚点；同仓常多前端并存
- [测试绝不碰真实环境](feedback_tests_never_touch_real_env.md) → skill `test-isolation` — DI 注入临时目录（Bun `os.homedir()` 忽略 `env.HOME`）；地板 = bunfig preload 沙箱 + 守卫测试

## 已下沉到 ADR（记忆文件 = stub 指向）

- [richest-data-flow 后端完整存](feedback-richest-data-flow-store-complete-no-pruning.md) → ADR `docs/decisions/2026-07-05-richest-data-flow.md` — 后端永不为 DRY/YAGNI/无消费者裁剪；"无数据源"常是没接线该建非删
- [合成帧必打可辨识标记](feedback-synthetic-data-must-be-distinguishable-from-real.md) → ADR `docs/decisions/2026-07-05-richest-data-flow.md`（对称面）— 上游轨绝不含合成物、合成物只进 forwarded 轨打标记

## 精炼保留（无 skill 域 / 独有教学价值 / 只读 skill 不覆盖）

- [通过/空/干净/自洽/doc-vs-code 不自证](feedback-pass-null-clean-not-self-validating.md) — 通用手法见 user skill `verifying-authoritative-claims`；本条是 verification 簇（合并原 self-consistent / verify-doc-vs-code）在本项目的高发实例 + 三陷阱钩子
- [eslint --cache 假绿](tooling-eslint-cache-false-pass.md) — `--cache` 对缓存过期文件假绿（实测掩盖 P2 5 error + 后来 44 存量债）；2026-07-07 起 `lint:all` 已去 --cache（全量权威可信）、`lint` targeted 仍带缓存故核单文件须无缓存 `bunx eslint <path>`；`.tsx` 测试不在 test-relaxation glob；ui-v4 现有 react-hooks/jsx-a11y
- [编译错误：补符号 vs 删引用](methodology-broken-reference-supply-vs-delete.md) — 独有 oracle 裁决教学；按消费者契约 + 独立 oracle 裁决，别反射式"让它编译"
- [修全部比较点](feedback-fix-all-comparison-sites.md) — 归一化键/id bug 多比较点复发；grep 全仓逐处修 + 抽单一共享 primitive
- [变体路由既有 outcome + 穷尽 Record 审计](methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit.md) — 多站点联合加变体的正向版：路由到既有 outcome 复用全 handler + 类型系统前置逼出全站点
- [新策略被更宽 matcher 首命中遮蔽](methodology-new-strategy-shadowed-by-broader-first-match.md) — 加反应式 retry 策略前先 grep 同错误子串既有 matcher（driver 首命中即止）；实例 tool-field vs body-field "Extra inputs" 抢先认领 → 收紧旧正则 + 新策略排前 + 认领归属回归测试
- [架构图优化 Agent 上下文经济](feedback-architecture-map-optimize-agent-context-economy.md) — 价值轴 = 上下文经济 + 可信度非可推导性；目录级关系图 + 现状小节 + L1 存在性守卫测试
- [git commit -- pathspec 取工作区非 index](git-commit-pathspec-commits-worktree-not-index.md) — 共享 worktree 最终提交一律 pathspec 免疫 peer 并发 `git add` 的 index race；user skill `git-preference` 未强调这层
- [lint-staged 已移除](tooling-lint-staged-revert-blocks-edit.md) — 本项目 2026-06-29 起无 pre-commit 门禁；通用 rollback 见 skill `git-preference:disarming-lint-staged-rollback`
- [覆写迁移前审计真实库原始字段(oracle 盲区)](methodology-migration-audit-raw-fields-not-just-projection-oracle.md) — projection-等价 oracle 对「已死字段」是盲的；覆写 blob 的 backfill 前须只读探针枚举真实库实际字段 vs 适配器映射，任何被 drop 的除非可派生一律当丢失；实例=history 双腿适配器丢 outbound_response.error，审计真库才抓到、修=路由 attempts[].error

## project 现状 stub（权威看正式归属）

- [v4 流水线重构](project-v4-pipeline-rearchitecture.md) — v4 P0-P3 + response-pipeline Stage A/B 全落地；权威看 `docs/DESIGN.md`「活的架构现状」+ `docs/archive/2606-landed-rfcs/`
- [GHC 三特性对齐已落地](project-ghc-feature-alignment-landed.md) — tool-search default-allow / extended-cache-ttl / memory tool；现状看 skill `ghc-api-reference`；memory_tool pending 见 `docs/todo/deferred-backlog.md`
- [history client/upstream 双腿重构已落地](project-history-client-upstream-legs-landed.md) — inbound/outbound/wire/effective → clientRequest/clientResponse + model{} + attempts[].{effectiveSource,upstreamRequest,upstreamResponse} + _index{derived,aux}；两正交轴（upstreamResponse.success vs entry.state）；旧库行经 adaptLegacyLegsInPlace 读时适配。**已 merge 入 master `5db1aff6`（含 P6 legacy-stage backfill + 审计 fix：适配器保留 outbound_response.error→attempts[].error）**；P6b 删适配器达单轨待运行期 backfill 跑完（no-auto-server）；权威看 `docs/DESIGN.md`「类型架构」+ RFC `docs/rfc/2026-07-07-history-data-model-restructure.md`；Group-B 标量迁移见 `docs/todo/deferred-backlog.md`
- thinking「cannot be modified」400 三层修复（已并 master）→ 权威全在正规文档：`docs/spec/2026-07-07-thinking-signature-quarantine.md` + `docs/DESIGN.md` 活的架构现状（L1/L2/L3 行 + 4 config 键）+ skill `ghc-anthropic-upstream`（根因=相邻性）；待办 thinking_block_sanitize 重命名见 `docs/todo/deferred-backlog.md`
- [反应式学习记录 TTL 生命周期 + Learned 页面](project-negotiation-learning-lifecycle-landed.md) — feature-negotiation 缓存加 per-entry TTL meta + 分类可配 TTL(默认30d) + pin，单一判据 `isEntryActive`(新 leaf negotiation-lifecycle.ts)，`/api/negotiation` 管理 API + ui-v4 Learned 页；承重不变量 meta刷新≠changed返回值(H3)/门控只在reader/v1→v2迁移/config五触点；**分支 feat/negotiation-lifecycle 待 merge**（并发会话隔离于 worktree）；权威看 `docs/spec/2026-07-08-negotiation-learning-lifecycle.md` + plan 同名目录 + DESIGN.md

## 已删除记忆的话题去向（实质并入正式归属，无独立文件）

通用工作原则由 user-level 规则 + 项目 CLAUDE.md 覆盖，不再单列项目记忆：
- 方向明确别停问 / 全面行动完成即提交 / 当下内聚优先 future-use → user-rule 60 + CLAUDE.md `no-premature-stop` / `scope-ambiguity-then-ask` / `architecture-health-first`
- 知识归类 docs vs 记忆 / 边界提炼经验维护库 → user-rule 70 + skill `session-closeout`
- 完成时同步文档 → skill `session-closeout` 步 ②（doc-sync 跨文档 grep）
- 主线实现 subagent 核验 / subagent 给全量工具 → user-rule 40 + CLAUDE.md `subagent-explicit-rubric`
- 测试跨高度重叠允许 → 通用测试金字塔原则（user-rule 60 Testing）
- 实验放 exp/ 不放 /tmp → CLAUDE.md 一句 + user-rule 60 poc-first
- git 暂存 + 本地提交默认允许 → 项目决策史 + skill `git-preference`
- 自洽需独立 oracle / doc-vs-code 方向须先证 → 并入上方 pass-null 合并记忆
- context-edits 回执 telemetry 暂缓 / 新 config 键写进 bundled config.yaml → `docs/todo/deferred-backlog.md` + `docs/DESIGN.md` 配置节

已归档完成叙事（迁 `docs/archive/memory/`）：pre-response-abort RFC、audit-rfcs 数据模型裁剪。

散落调试参考已收编为 on-demand skills（靠 skill 描述发现，无独立记忆条目）：`bun-node-runtime-gotchas` / `claude-code-connection` / `debugging-server-crashes` / `bun-upstream-transport` / `ghc-anthropic-upstream` / `ghc-api-reference`；TS6 延期见 `docs/decisions/` ADR。
