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
- [改共享 mock 契约打爆 sibling 测试文件](methodology-shared-mock-contract-change-breaks-sibling-test-files.md) → 拟下沉 skill `debugging-frontend-tests` — 多测试文件各自 `vi.mock("react-virtuoso")`;改 itemContent 加第三参 context 只更新点名那个 mock → 其余 fake 传两参致 `context.runs` 崩;per-task review 看不到、只全量 vitest 抓;grep 全 `vi.mock` 逐个改 + 每 task 跑全量 + 「peer/基线」定性须在 master 独立核实
- [动大工程前核实命名目标](feedback-verify-named-target-resolves-before-large-work.md) — 用户命名的目标（"ui-v4"）先 find/ls 核实解析到哪个真实产物，别凭记忆/plan 命名假设；踩坑：整套做进 Vue `ui/`、实际是 React `ui-v4/`（5173）；名字歧义 + 用户重复词 + 端口/URL = 必查锚点；同仓常多前端并存
- [测试绝不碰真实环境](feedback_tests_never_touch_real_env.md) → skill `test-isolation` — DI 注入临时目录（Bun `os.homedir()` 忽略 `env.HOME`）；地板 = bunfig preload 沙箱 + 守卫测试

## 已下沉到 ADR（记忆文件 = stub 指向）

- [richest-data-flow 后端完整存](feedback-richest-data-flow-store-complete-no-pruning.md) → ADR `docs/decisions/2026-07-05-richest-data-flow.md` — 后端永不为 DRY/YAGNI/无消费者裁剪；"无数据源"常是没接线该建非删
- [合成帧必打可辨识标记](feedback-synthetic-data-must-be-distinguishable-from-real.md) → ADR `docs/decisions/2026-07-05-richest-data-flow.md`（对称面）— 上游轨绝不含合成物、合成物只进 forwarded 轨打标记

## 精炼保留（无 skill 域 / 独有教学价值 / 只读 skill 不覆盖）
- [畸形 tool_use 全人群扫描法](methodology-malformed-tooluse-full-population-scan.md) — 查全 decode error 别只看 error_message（漏被修好/原样转发的）；扫 upstream_response blob 的 sseEvents + content_block_stop 分真缺陷 vs abort 伪畸形；实例=AskUserQuestion 中文 \uXXXX 转义击中 opus-4.8，20 真缺陷 18 无损修+2 丢hex位 unicode-lossy

- [配置哲学独立：留兼容层 + 警告并继续](feedback-config-philosophy-separate-compat-and-warn-continue.md) — 配置**不**享代码「无向后兼容负担」；键重命名 / 收窄作用域须留旧键别名读时映射，加载遇弃用 / 未知 / 无效键默认警告并继续（唯启动期可 fail-fast，运行时热重载绝不因配置问题杀进程）；触发场景=改配置 schema / 迁移配置键
- [通过/空/干净/自洽/doc-vs-code 不自证](feedback-pass-null-clean-not-self-validating.md) — 通用手法见 user skill `verifying-authoritative-claims`；本条是 verification 簇（合并原 self-consistent / verify-doc-vs-code）在本项目的高发实例 + 三陷阱钩子
- [eslint --cache 假绿](tooling-eslint-cache-false-pass.md) — `--cache` 对缓存过期文件假绿（实测掩盖 P2 5 error + 后来 44 存量债）；2026-07-07 起 `lint:all` 已去 --cache（全量权威可信）、`lint` targeted 仍带缓存故核单文件须无缓存 `bunx eslint <path>`；`.tsx` 测试不在 test-relaxation glob；ui-v4 现有 react-hooks/jsx-a11y
- [node_modules 存在 ≠ 锁文件事实](reference-node-modules-presence-not-lockfile-truth.md) — node_modules 里有某包可能是 `bun install` 会 prune 的游离 orphan（不在 bun.lock）；选依赖前 `grep '"<pkg>@' bun.lock` 证真被锁定；提升传递依赖为直接依赖须 `bun add <name>@^<锁里现版本>` 钉版号（裸 bun add 拉最新 major）；实例 footer 弃 cli-truncate 改钉 string-width@^7.2.0
- [worktree bun add 后主树须补 install](reference-worktree-bun-add-needs-main-tree-install-after-merge.md) — 隔离 worktree 里 `bun add` 只进该树 node_modules；FF 合并把 package.json+bun.lock 带回 master 但主树 node_modules 陈旧 → Vite「dependencies could not be resolved」；worktree SDD 收尾若动过 deps 须主树补 `bun install` + `typecheck:ui-v4` 验解析；实例 dnd-kit reorder 合并后
- [编译错误：补符号 vs 删引用](methodology-broken-reference-supply-vs-delete.md) — 独有 oracle 裁决教学；按消费者契约 + 独立 oracle 裁决，别反射式"让它编译"
- [修全部比较点](feedback-fix-all-comparison-sites.md) — 归一化键/id bug 多比较点复发；grep 全仓逐处修 + 抽单一共享 primitive
- [变体路由既有 outcome + 穷尽 Record 审计](methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit.md) — 多站点联合加变体的正向版：路由到既有 outcome 复用全 handler + 类型系统前置逼出全站点
- [新策略被更宽 matcher 首命中遮蔽](methodology-new-strategy-shadowed-by-broader-first-match.md) — 加反应式 retry 策略前先 grep 同错误子串既有 matcher（driver 首命中即止）；实例 tool-field vs body-field "Extra inputs" 抢先认领 → 收紧旧正则 + 新策略排前 + 认领归属回归测试
- [架构图优化 Agent 上下文经济](feedback-architecture-map-optimize-agent-context-economy.md) — 价值轴 = 上下文经济 + 可信度非可推导性；目录级关系图 + 现状小节 + L1 存在性守卫测试
- [交用户前先 subagent review（含 in-chat 提案）](feedback-subagent-review-before-any-user-facing-proposal.md) — 审查门适用任何交付物，包括对话里直接呈现的设计分节非只书面 spec/plan；brainstorming 的 present-design 前须插 subagent 对抗审查
- [git commit -- pathspec 取工作区非 index](git-commit-pathspec-commits-worktree-not-index.md) — 共享 worktree 最终提交一律 pathspec 免疫 peer 并发 `git add` 的 index race；user skill `git-preference` 未强调这层
- [lint-staged 已移除](tooling-lint-staged-revert-blocks-edit.md) — 本项目 2026-06-29 起无 pre-commit 门禁；通用 rollback 见 skill `git-preference:disarming-lint-staged-rollback`
- [覆写迁移前审计真实库原始字段(oracle 盲区)](methodology-migration-audit-raw-fields-not-just-projection-oracle.md) — projection-等价 oracle 对「已死字段」是盲的；覆写 blob 的 backfill 前须只读探针枚举真实库实际字段 vs 适配器映射，任何被 drop 的除非可派生一律当丢失；实例=history 双腿适配器丢 outbound_response.error，审计真库才抓到、修=路由 attempts[].error
- [一次性 connected 快照须常驻根订阅](methodology-one-shot-connected-snapshot-needs-root-subscriber.md) — WS `connected` 携初始在途快照是一次性事件、无缓存;页面级 `useLiveRequests` 晚挂载漏掉 → 「只显示打开后新请求」;修=订阅提升到常驻 `AppShell`(连接建立前必已注册),附带修 Overview 同 bug + 重连重同步;通用:snapshot-then-delta 的快照消费者须挂连接前就位的常驻宿主
- [picocolors 在 bun test 塌缩成恒等](reference-picocolors-collapses-to-identity-in-bun-test.md) — `pc.isColorSupported===false` 使 `pc.dim/yellow/red/bold` 全返原串，`expect(fn(x)).toBe(pc.red("x"))` 退化成文本断言、配色分支全错也过（变异 always-red 30/30 照过）；改测 color-fn **引用相等**（具名档 `.toBe(pc.white)`、组合档 `.not.toBe`）+ FORCE_COLOR 子进程集成测真 SGR + 变异自证；verification 簇 [[feedback-pass-null-clean-not-self-validating]]

## project 现状 stub（权威看正式归属）
- [通用翻译矩阵大特性（设计定稿4轮review+Phase 0 landed，Phase 1-6 待做）](project-universal-translation-matrix.md) — 4 入站×3 出站 hub-and-spoke，让任意客户端用任意 GHC 模型；源起 Claude Code subagent 想用 gpt-5.5 但 Anthropic /v1/messages 拒非-Anthropic vendor；3 ADR（codec 纯化 decideRoute→router 自由函数 / 全矩阵一对 Anthropic↔CC 翻译器接入 CC hub / 缝合模型二维门控 clientFormat定render心跳·targetEndpoint定改写策略wire）；权威 RFC v5 + 三层 plan + 探针 exp/；Phase 0 已 landed master（decideRoute→router golden 锁等价，两自觉偏离 env签名/DI seam 记 plan）；承重约束：反向绝不合成 thinking 块(GHC signature 400)、反向逐帧表覆盖 server_tool_use/content_block_stop、Google /responses force-fallback 按 targetEndpoint 拦；RFC-first 实证四轮 FAIL 5→3→2→2 递减、2 隐蔽承重 FAIL(handler崩坏/reasoning撞300s断连)写码前挡下
- [block 级缓冲重试执行中（spec+plan 就绪、P0T1 landed）](project-block-level-buffered-retry-execution.md) — 整响应缓冲→block 级延迟提交、4 端点默认开、退役整响应；源起 req_484；隔离 worktree feat/block-level-buffered-retry + durable ledger .superpowers/sdd/progress.md（权威进度）；下一步 P0 Task 2；冻结契约在 plan README；P1 有 2 处须用户跑 PoC 门；Gemini/web_search 本轮排除
- [交互式 TUI live 面板（P0 已 merge，P1/P2 待做）](project-tui-interactive-live-panel.md) — 折叠分组 footer ↔ 展开逐条面板 ↔ detail + 行级动作（abort/复制 req_id）；P0 终端层重组已落地（ConsoleSink→`src/lib/tui/` 的 TerminalUi，footer/syslog 抽 `tui/render/`，行为逐字等价 golden oracle）；权威看 RFC/ADR/plan `2026-07-10-*`（ADR Accepted：呈现/逻辑/控制三分）；PoC pty 实测 Q1/Q2(DECSTBM)/Q4 闭合，待用户真终端复验 Q2 视觉+Q3 剪贴板
- [ui-v4 shadcn 重设计决策（讨论中/未实施）](project-ui-v4-shadcn-redesign-decisions.md) — 全面切 shadcn/ui new-york + 锐角 + tokenized 可调色默认 Amber + 标准密度 + 布局形态 A（整页详情+prev/next）；本轮加：默认页 /overview、LiveDock 提全局、详情抽屉共用组件；否 antd（PoC 可行但错配）；权威看 ADR `ui-v4/docs/decisions/2026-07-10-ui-v4-shadcn-adoption.md`（重访 adopt-radix-primitives「弃 shadcn 样式」旧结论）；**代码是 agent 协作写的非人类手搓** [[feedback-ui-v4-code-authored-by-agents]]
- [ui-v4 代码由 agent 协作编写（非手搓）](feedback-ui-v4-code-authored-by-agents.md) — 用户要求记住；措辞不用"手搓"贬义、重构自由度放宽（agent 创建可自由重写、守可恢复性底线）
- [Codex/Responses tier-1 硬化已落地](reference-undici-websocket-runtime-split-bun-vs-node.md) — 关闭码 1000（closeUpstreamWs）+ guardCallback 崩溃防护 + 下游 SSE/WS 保活（responsesKeepaliveFrame 20s）+ opt-in buffered 重试（responsesBufferedRetry 默认 OFF，driver runResponseBufferedSink 第二消费者）+ 上游保活 PoC（WS ping Bun-only/prevention-only→buffered 承重）+ idle 余量锁定；**已 rebase+FF 合入 master（feat/codex-responses-tier1，34 commits 于 concurrent master 之上）**；关键教训 [[reference-undici-websocket-runtime-split-bun-vs-node]]（runtime-split）+ 联合审查裁决（3.2 streamError 双帧/误标，亲手读代码定 BLOCK 方对）；权威看 `docs/DESIGN.md`「活的架构现状」Codex/Responses 行 + spec `2026-07-09-codex-responses-tier1-hardening` + plan 同名目录
- [runtime-split：undici WS Bun vs Node](reference-undici-websocket-runtime-split-bun-vs-node.md) — 裸 `import{WebSocket}from"undici"`：Bun→原生 WS（有 ping()、容忍 close(1001)）；Node→真 undici（无 ping、抛 "invalid code"）；影响关闭码 bug（runtime-conditional）+ WS 保活可行性；属 skill `bun-node-runtime-gotchas`
- [keepalive 无条件 timeout-safety 已落地](project-keepalive-unconditional-timeout-safety-landed.md) — 分支 feat/keepalive-timeout-safety 19 commits、MERGE-READY 待 user-run oracle（live empty_text >300s）+ merge；权威看 ADR 2026-07-09 + spec §10

- [v4 流水线重构](project-v4-pipeline-rearchitecture.md) — v4 P0-P3 + response-pipeline Stage A/B 全落地；权威看 `docs/DESIGN.md`「活的架构现状」+ `docs/archive/2606-landed-rfcs/`
- [GHC 三特性对齐已落地](project-ghc-feature-alignment-landed.md) — tool-search default-allow / extended-cache-ttl / memory tool；现状看 skill `ghc-api-reference`；memory_tool pending 见 `docs/todo/deferred-backlog.md`
- [history client/upstream 双腿重构已落地](project-history-client-upstream-legs-landed.md) — inbound/outbound/wire/effective → clientRequest/clientResponse + model{} + attempts[].{effectiveSource,upstreamRequest,upstreamResponse} + _index{derived,aux}；两正交轴（upstreamResponse.success vs entry.state）；旧库行经 adaptLegacyLegsInPlace 读时适配。**已 merge 入 master `5db1aff6`（含 P6 legacy-stage backfill + 审计 fix：适配器保留 outbound_response.error→attempts[].error）**；P6b 删适配器达单轨待运行期 backfill 跑完（no-auto-server）；权威看 `docs/DESIGN.md`「类型架构」+ RFC `docs/rfc/2026-07-07-history-data-model-restructure.md`；Group-B 标量迁移见 `docs/todo/deferred-backlog.md`
- thinking「cannot be modified」400 三层修复（已并 master）→ 权威全在正规文档：`docs/spec/2026-07-07-thinking-signature-quarantine.md` + `docs/DESIGN.md` 活的架构现状（L1/L2/L3 行 + 4 config 键）+ skill `ghc-anthropic-upstream`（根因=相邻性）；待办 thinking_block_sanitize 重命名见 `docs/todo/deferred-backlog.md`
- [反应式学习记录 TTL 生命周期 + Learned 页面](project-negotiation-learning-lifecycle-landed.md) — feature-negotiation 缓存加 per-entry TTL meta + 分类可配 TTL(默认30d) + pin，单一判据 `isEntryActive`(新 leaf negotiation-lifecycle.ts)，`/api/negotiation` 管理 API + ui-v4 Learned 页；承重不变量 meta刷新≠changed返回值(H3)/门控只在reader/v1→v2迁移/config五触点；**已 merge 入 master `67afa1af`**（rebase 零冲突 + FF，隔离 worktree 避并发会话）；权威看 `docs/spec/2026-07-08-negotiation-learning-lifecycle.md` + plan 同名目录 + DESIGN.md

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
