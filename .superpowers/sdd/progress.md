# upstream-error-client-shaping — 进度 ledger

plan: docs/plan/2026-07-13-upstream-error-client-shaping/
spec: docs/spec/2026-07-13-upstream-error-client-shaping.md（v2.3，四轮评审全闭合）
worktree: .worktrees/upstream-error-client-shaping (branch feat/upstream-error-client-shaping)
BASE: 2526f42f（master，含已提交的 exp/spec/plan）
模式: 隔离 worktree + subagent-driven（fresh implementer per task + task-reviewer + 终局 whole-branch review）

## 承重约束（贯穿）
- 仅 Anthropic Messages 路径接线；OpenAI/Gemini 不碰（非目标守卫测试）。
- error-shaping.ts 是 lib 纯模块、不依赖 routes；输入 ApiError+config+commitPhase+clientVisibleStopEmitted。
- G-3 终局尾帧唯一所有权=error-shaping buildCanonicalErrorFrame，收编 4 终点（565/568-570/1193/1295）+ 明确排除 3 处（579/1270/1317）。
- G-4 排序：Phase 0-5 独立可交付、不依赖 block-level；Phase 6 GATED（依赖 block-level P1 落地 master，仅记契约不实现）。
- HIGH-3：Phase 3/4/5 共享 error-shaping.ts + handler-v4.ts，本 worktree 内串行 3→4→5。
- 显式 pathspec commit；无 pre-commit 门禁，lint 靠手动 + review。
- 待裁决点 D-0（AUQ 门控=纯 config，已采推荐）/ D-0.5（Phase 3 与 block-level P1 冲突，buildCanonicalErrorFrame 单函数收窄）。

## Phase DAG
Phase 0（config）→ Phase 1（纯决策引擎+canonical构造）→ Phase 2/3/4/5（2独立；3→4→5 串行共享文件）→ Phase 6（GATED）

## 进度
- [x] Phase 0: config 三触点 4 键 — complete (commits 170340fb..fa5ebefe, spec✅ quality Approved 0 blocker; 6/6+310/310 绿, typecheck 净; implementer 多发现第 5 触点 config-hot-reload 完整性守卫 + cloneState/cloneStatePatch Record 浅拷贝, reviewer git show 佐证 prettier 债存量不清正确)
  - 收尾待办(记): DESIGN.md「活的架构现状」配置键表在特性收尾 doc-sync 时补 4 新键（现不加——键未被消费, 过早写失真）
- [x] Phase 1: error-shaping.ts 决策引擎 + buildCanonicalErrorFrame + AuqQuestion 构造 + 类型扩展 — complete (commits 26e51e23..c6a03ba1, spec✅ quality Approved 0 blocker; 36 测试绿, typecheck 两套净, 纯模块无 routes import, G-3 字节等价 anthropicStreamErrorType, 契约签名字对字对齐 README §4, 类型逼出 5 消费站点无 as any/default 绕过)
  - **跨阶段 carry-forward（下游 phase 必做）**：
    - CF-1 → Phase 2：401/403 分流押在「token-refresh RetryStrategy 先于 error-shaping pre-commit catch」不变量；Phase 2 须加集成断言「未耗尽 401 从不产生 ApiError 走到 decide()」。
    - CF-2 → Phase 2/3：decide() 不读 config.enabled；call-site 调 decide() 前须判 `state.errorShapingEnabled`，disabled 走既有行为；各加「enabled=false→不调 decide()」测试。
    - CF-3 → Phase 3：`anthropicErrorTypeForApiError` 把 402→wire "rate_limit_error"；用 CC oracle 核该 canonical event:error 帧不引发非预期客户端重试（含 retry_after 带出）；冲突则 spec-wins。
  - 报告偏差全核: 3 task 合 1 提交合理/类型逼出方向正确/新增映射表必要无过建
- [x] Phase 2: pre-commit retry-signal（error-shaping-glue.ts + route.ts，不改 forward.ts） — complete (commits 2dcebc76..bb89b9ab, spec✅ quality Approved 0 blocker; 21新+164回归绿, typecheck 净, forward.ts+6非-Anthropic路由零diff; reviewer 从源码结构独立证实 CF-1 token-refresh 时机不变量 + CF-2 enabled 门控先于 decide())
  - Minor(交终局 review): ① glue isAbortError 双判冗余；② 测试深相对路径 import 应改 `~/` 别名(全仓 420 vs 1)；③ retry_after:0 边界未测
  - **收尾待办(记，reviewer 提醒别丢)**：forward.ts↔classify.ts 既有分类分歧(503+精确 `code:"rate_limited"` → forward.ts:424 强改 429 wire)须写进 `docs/todo/deferred-backlog.md`，否则只存 commit message 会丢
- [x] Phase 3: post-commit canonical 尾帧（S5 rewrite errorFrameCanonical order=50 + 4 终点收编） — complete (commits 04c88acd..c727d151, 含 fix 循环; spec✅ quality Approved 0 blocker)
  - 实现 04c88acd..bdebda73 + fix 92301bb8..c727d151（FIX-1 refusal 二次整形回归锁 / FIX-2 translate 反向腿收编统一 shapeRawStreamErrorFrame 4 终点 / FIX-3 backlog 2 条）
  - review: concern 2 (server_error/529→api_error) 裁**刻意正确**(spec B-1 兑现、disabled golden lock 留 legacy overloaded_error)；fix 复审 3 项闭合、字节等价字符级核、1866 回归独立重跑绿、stream-accumulator/openai codec 零改动
  - CF-2 ✅(四终点 + S5 rewrite enabled 门控 golden lock) / CF-3 ✅(rate_limit_error/api_error 均不命中 CC post-commit 重试判据, 按 FINDINGS 分析未跑真 CC live)
  - backlog 已记: accumulator H2 双帧缺陷 + 403/404/529 保真差异
- [x] Phase 4: AskUserQuestion 合成（streaming + non-streaming）+ CC 消费 oracle 门（MED-3） — complete (commits 5b64050e..9dd2f1c4, 含崩溃 resume + Critical fix + 复审; spec✅ quality Approved 0 blocker; 71/71 绿)
  - **Critical wire bug 已修**：AUQ options `ReadonlyArray<string>`→`ReadonlyArray<AuqOption{label,description}>`（CC schema，app.pretty.js:318507 + fixture debug-dry-run-pipeline.http.test.ts:108 双证）；FIX-B 补 options 形状 oracle（reviewer 突变实验验证非空过：改回字符串→3 例红、revert→50/50 绿）；FIX-C README D-2
  - **MED-3 敞口仍在（交付时必告知用户）**：AUQ 只交互式有效、CC 渲染合成 AUQ 为交互式问句的假设**未实测**（headless 无用户可问）；fix 只加强 options wire 形状对齐、未验 CC 真渲染；上线前需人工验收或交互式 PoC
  - D-1 记录: AUQ 200 响应不落 history clientResponse(ctx.fail 先冻结快照)、真实 402 仍在 attempts[].upstreamResponse 保真, 未擅改 settle 生命周期
  - Minor(交终局): FIX-B oracle 用手写 fixture 非经 optionsForErrorType 真实路径(现状等效覆盖, 可选让它也直调)
  - 教训: 跨-Phase 契约 bug——plan 探查假设 options:string[] 没核 CC schema 是根因; empirical(查 CC 源码 ground truth) + subagent 三层防线逮住
- [x] Phase 5: 自愈委派 filterDelegatedStrategies + 6 腿映射 — complete (commits d89741e3..f03e3fbb, spec✅ quality Approved 0 blocker; 10/10+6/6+1877 回归绿, 禁改文件零 diff)
  - reviewer 追正则确认 quarantine 对照组 poisoned-thinking-retry 未委派时 canHandle 真 true(排除通过性不自证)；委派只过滤反应式 RetryStrategy 数组、quarantine 是独立 requestRewrites 数组(order 250)天然碰不到
  - 偏差全核: ①effort-learning(非 -retry) ②驱动真实 buildAnthropicStrategies() 非硬编码 15 名列表(判**更优**、自免疫漂移) ③strategies.ts 注释 14→实际 16
  - Minor(交终局 doc-sync): spec §97 示例键 `adaptive-thinking-rejection`/`tool-field-rejection` 无 `-retry` 后缀与真实 .name 不符(用户照抄委派静默无效)；strategies.ts:12 注释 14→16；plan 标题重复行
- [x] Phase 6: GATED post-commit 截断类 — complete (commit 61bf5d31, 7 skip/0 pass/0 fail, 无生产代码; P1 未合 master merge-base 确认 GATED 正确; 骨架锚 anthropicCommitBoundaries/partial-degrade 真实契约; describe.each 双 keepalive 模式=LOW-1)
