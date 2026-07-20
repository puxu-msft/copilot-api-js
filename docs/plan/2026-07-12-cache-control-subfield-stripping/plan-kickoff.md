# Kickoff 提示词（cache_control 子字段剥离）

各阶段复制对应提示词开新会话（或 subagent-driven 逐 task 派发）。执行前先读 [README.md](README.md)（冻结契约 + 红线 + DAG）。

---

## 通用前置（所有阶段）

```
你在 copilot-api-js 项目实施一个已定稿的三阶段计划。先读这些（按序）：
1. docs/plan/2026-07-12-cache-control-subfield-stripping/README.md —— 冻结的跨 task interface 契约 + 5 条红线 + 阶段 DAG。这是你的合同，签名逐字不变。
2. docs/spec/2026-07-12-cache-control-subfield-stripping.md —— 单一事实源（为什么这么做）。
3. 项目 CLAUDE.md —— 工程纪律（TDD / commit invariants / no-auto-server / 显式 pathspec 提交 / 相对路径导入）。

纪律要点：
- 严格 TDD：每 task 先写失败测试 → 跑到红 → 最小实现 → 跑到绿 → typecheck → 提交。
- commit invariants：每个 commit 终态满足不变量、中间态绝不半坏。
- no-auto-server：绝不 bun run dev/start、绝不 kill/pkill；可跑 bun test / bun run typecheck / bunx eslint <单文件>。
- 显式 pathspec：git add -- <精确路径>、git commit -F <msgfile> -- <精确路径>，不加模型署名。
- 遇到 plan 与实际代码不符（file:line 漂移、签名对不上），停下报告，不要凭猜硬改。
```

---

## Phase 0（sanitize 收窄，可最先做，与 Phase 1 正交）

```
[粘贴通用前置]

执行 docs/plan/2026-07-12-cache-control-subfield-stripping/plan-0-sanitize-narrowing.md 的 Task 0.1→0.5，逐 task 逐 step。

承重注意：
- Task 0.2 的 resolveSanitizedTtls 是 TTL 决策单一 owner，算法见 README 契约（per-layer max 后必须跨层单调化 tools≥system≥messages）。C1 非法组合（system=5m + messages=1h）必须把 messages 降到 5m——这是红线2。
- Task 0.4 改 sanitize 分支后，若 tests/anthropic/anthropic-request-preparation.it.test.ts 有断言假设旧的"ttl 降 5m"行为，一并更新为新行为并在 commit 说明（这是预期的行为变更，非回归）。
- 完成后跑全量 bun test tests/anthropic/ 确认无回归。
```

---

## Phase 1（passthrough 过滤，独立消除 scope 400）

```
[粘贴通用前置]

执行 docs/plan/2026-07-12-cache-control-subfield-stripping/plan-1-passthrough-filter.md。

执行顺序（README DAG + plan 内注记）：Task 1.3（config+state 落点）→ 1.1（读取端）→ 1.2（filter 原语）→ 1.4（接线 passthrough）→ 1.5（history 标记）。1.3 先于 1.1 是因为读取端引用 state.stripCacheControlSubfields。

承重红线：
- 红线1：filterCacheControlSubfields 的 handler 绝不返回 undefined（那会删整个 cache_control），必须 delete cc[field] 后 return cc。
- 红线5：内置 {scope} 在读取端注入、不在 config 默认值（config 默认 {}）。
- Task 1.3 的 state 五处落点严格对齐 stripBetaHeaders：先 grep 'stripBetaHeaders' src/lib/state.ts 得所有落点，逐处平行加 stripCacheControlSubfields。
- Task 1.4 完成后，用 spec §1.1 实测形态（system[1] 带 scope）验证 passthrough 后 scope 已剥、system[2] 不变。
```

---

## Phase 2（reactive 学习，依赖 Phase 1）

```
[粘贴通用前置]

前置：Phase 1 必须已合并（Phase 2 用 PrepareHints.excludeCacheControlSubfields + 读取端源③注入点）。

执行 docs/plan/2026-07-12-cache-control-subfield-stripping/plan-2-reactive-learning.md 的 Task 2.1→2.3。

承重红线：
- 红线3：Task 2.1 新增 NegotiationCategory "cacheControlSubfields" 必须补全所有 never 穷尽守卫。先 grep '_exhaustive: never' src/lib/anthropic/feature-negotiation.ts 得所有 switch，逐处加 case。十点扇出清单见 plan Task 2.1 Step 3，一处不漏否则编译失败。
- 红线4：Task 2.2 的三路径遮蔽回归测试必须含 system.N / tools.N / messages.N.content.M 三条 cache_control 路径，尤其最险的 tools.N.cache_control.*（共享 tools. 前缀）。断言：新腿认领全部三条 + tool-field 腿对全部三条返 null。
- 完成后跑 bun test tests/pipeline/ 全量确认 tool-field 不回归。
```

---

## 收尾（全部 phase 完成后）

```
三阶段全部合并后做 session-closeout（skill session-closeout）：
① subagent 合并态审查（跨 phase 集成缺口：passthrough 与 sanitize 双路径、reactive→proactive 收敛、history 标记 end-to-end）
② doc-sync：更新 docs/DESIGN.md「活的架构现状」cache_control 行；README.md 实施状态勾选；spec 头部加实施状态注解
③ 归档 plan（本目录头部标 landed + commit hash）
④ 提炼教训维护记忆库（若有新战例，如三路径遮蔽的实测手法）
⑤ 细粒度阶段提交已随各 task 完成
```
