# Kick-off Prompt：上游错误 → 客户端可行动形态整形（upstream-error-client-shaping）

> 把下面这段话原样复制给新会话 / subagent 即可开工。

---

我要实现 `docs/spec/2026-07-13-upstream-error-client-shaping.md`（v2.3，三轮对抗评审全闭合）描述的特性："把 GHC 上游错误按 `ApiError` 分类 × commit phase（pre-commit/post-commit）× `clientVisibleStopEmitted` 三维决策，整形为对 Claude Code 客户端更可行动的形态（触发原生重试 / 合成 AskUserQuestion / 委派 CC 自愈 / 保持 canonical 错误帧），而非现状的一律拍平成错误帧"。

实施计划已经写好，在 `docs/plan/2026-07-13-upstream-error-client-shaping/` 目录下：

- `README.md` —— 总体架构、Phase DAG、类型草图、spec 验收标准覆盖映射表、自审记录。**先读这个文件，尤其第 0 节的待裁决项**。
- `phase-0-config-scaffolding.md` 到 `phase-5-selfheal-delegation.md` —— 六个实施阶段（Phase 0-5 全部不依赖外部 spec，可以在本次会话内全部完成；Phase 2 相对独立，Phase 3/4/5 共享 `error-shaping.ts`/`handler-v4.ts`、建议串行或隔离 worktree，详见执行要求第 3 条与 README 第 3 节）。
- `phase-6-gated-postcommit-truncation.md` —— **GATED**，依赖另一个 spec（`docs/spec/2026-07-11-block-level-buffered-retry.md`）的 P1 落地 master 才能开工，**本轮不要做这个 Phase**，除非你确认 block-level P1 已经落地（可以先跑 `git log --oneline --all | grep -i "block-level\|buffered-retry"` 或询问确认）。

## 执行要求

1. **先读 README.md 第 0 节**："D-0：交互式/headless 检测信号不存在——AUQ 的仅交互式有效门控如何落地"与"D-0.5：Phase 3 与 block-level P1 Task 6 的跨 worktree 编辑冲突风险"。两项均已给出推荐值（D-0 推荐"纯配置门控，不做运行时探测"；D-0.5 是排序建议，非阻塞）。如果你是主会话在执行前确认过这两项、或认为可以直接采纳推荐值，可以不再等待用户逐项确认，直接按推荐值推进；如果你是被派发执行的 subagent，且主会话没有明确说"两项待裁决已确认"，请先向主会话报告这两项，不要自行拍板架构级选择（D-0 属于"是否需要新增运行时探测机制"这类可能改变实现方向的分叉，不是纯局部实现细节）。

2. **严格按 TDD 执行每个任务**：每个 Phase 文档里的每个任务都是"写失败测试 → 跑测试确认红 → 最小实现 → 确认绿 → 提交"的完整循环，任务清单里的 checkbox 就是执行顺序，不要跳过"确认红"这一步（哪怕看起来测试"显然会失败"）。

3. **Phase 0-5 的依赖顺序**：Phase 0 必须先做（其余 Phase 都需要读 `state.errorShapingEnabled` 等字段）。Phase 1 必须在 Phase 0 之后、Phase 2/3/4/5 之前（后四者都依赖 `error-shaping.ts` 的 `decide()`/`buildCanonicalErrorFrame`/`renderAuqQuestion` 等导出）。**订正（评审 HIGH-3，原"Phase 2/3/4/5 四者互相独立、可以并行执行"的表述不成立）**：Phase 2 与其余三者相对独立，可以并行；但 Phase 3/4/5 **都会共同追加/编辑同一批共享文件**——`error-shaping.ts`（Phase 1/3/4/5 四方共同追加）、`handler-v4.ts`（Phase 3/4/5 三方共同编辑），因此 Phase 3/4/5 **建议串行执行（推荐顺序 3→4→5）**，如果确实要并行，必须放在**隔离 worktree**里各自开工、合并前人工核对 diff（同文件不相邻函数级新增可以安全并行，但不能假设"文件不重叠"）——如果你是主会话在编排多个 subagent，可以把 Phase 2 单独派给一个 subagent 并行，Phase 3/4/5 依次派给同一 subagent 串行做，或各自开隔离 worktree，这是编排层面的判断，本 kickoff 不替你决定由谁在哪并行，详见 README 第 3 节 Phase DAG。

4. **判据轴（写代码/评审时必须坚持，不得用 ROI/YAGNI 静默削减）**：
   - 长远正确 + 完整性 > 最小可交付——spec 的每条验收标准（AC1-6 + 3 条非目标 + 配置面 + 遥测）都已经在 README 第 5 节映射到具体 Phase/任务，不要因为"看起来这条不重要"就跳过对应任务或简化测试覆盖。
   - `error-shaping.ts` 必须保持纯 `lib` 层模块——**不得** `import` 任何 `~/routes/*` 路径，每个 Phase 完成检查清单里都有一条 grep 断言这一点，务必执行。
   - **Golden 字节锁**是最高优先级的回归防线：`error_shaping_enabled=false` 时，pre-commit（`forward.ts`/route.ts glue）、post-commit 终点①（pre-pump catch）、post-commit 终点②（H2/H3/truncation 三分支）都必须与当前行为逐字节等价。每个涉及这些路径的 Phase（0/2/3）完成后都要重新跑一遍 golden 测试确认零回归。
   - 只接入 Anthropic Messages 路径——每个 Phase 完成检查清单里都有一条"确认未改动 `openai-cc`/`openai-responses`/其余非-Anthropic 路由目录"，务必执行，不要图省事跳过。

5. **遇到 Phase 文档里标注"门控问题"/"待裁决"/"需要实现者二次确认"的地方**（例如 Phase 2 任务 2.2 提到的 `classify.ts` 是否已回填 `retryAfter`、Phase 4 任务 4.2 提到的 `resolvedName`/`requestId` 精确获取方式），**先动手核实**（`grep`/`Read` 实际代码），能自解的直接自解并在提交信息或代码注释里留一句结论；如果核实后发现确实是需要修改计划外文件/扩大架构改动面的真分叉，停下来记录清楚（发现了什么、为什么是分叉、影响面多大），报告给主会话，不要擅自扩大改动范围。

6. **完成 Phase 0-5 全部任务后**：
   - 重新过一遍 README 第 5 节的 spec 覆盖映射表，确认每一行都已经有对应的、真正落地的测试（不是"计划里写了"而是"跑过、绿了"）。
   - 跑一遍全量 `bun run typecheck` + `bunx eslint`（无缓存全量，参照项目 `tooling-eslint-cache-false-pass` 记忆教训，不要用带缓存的 `lint` 命令做最终确认）。
   - 按项目 `session-closeout` skill 收尾：subagent audit（review-merged-state，尤其关注 Phase 3/4/5 三方共同编辑 `error-shaping.ts`/`handler-v4.ts` 后有没有互相踩线、覆盖彼此的追加内容）、doc-sync（`docs/DESIGN.md`"活的架构现状"补一行、`docs/API.md` 如果 AUQ/canonical 帧改变了任何对客户端可见的响应形状需要补充说明）、把本计划目录标注实施状态、提炼教训进项目记忆库。
   - 是否要开始 Phase 6，取决于 block-level P1 当时是否已落地——如果没有，Phase 0-5 就是本轮的完整交付，这是一个**可接受的、spec 明确认可的中间状态**（G-4），不要因为"整个 spec 还没 100% 做完"而焦虑或强行做 Phase 6 的占位实现。

## 参考资料

- Spec：`docs/spec/2026-07-13-upstream-error-client-shaping.md`
- 探索证据：`exp/cc-error-retry-surface/FINDINGS.md` + `REPORT.md`
- 相关既有代码（评审/实现时会反复用到）：`src/lib/error/forward.ts`、`src/lib/error/classify.ts`、`src/routes/messages/post-commit-error.ts`、`src/routes/messages/handler-v4.ts`、`src/routes/messages/streaming-pump.ts`、`src/lib/anthropic/recover-refusal.ts`、`src/lib/anthropic/keepalive-anchor.ts`、`src/lib/pipeline/types.ts`（`RetryStrategy`）、`src/lib/pipeline/rewrite-registry.ts`（`ResponseRewrite`）、`src/lib/codec/anthropic/strategies.ts`（`buildAnthropicStrategies`）
- 相关已完成特性（同源/同类模式，可参照其实现手法）：`docs/spec/2026-07-13-refusal-recovery-text-configurable.md`（已实现，`renderRefusalTemplate`/`buildSyntheticTextFrames` 的先例）、`docs/spec/2026-07-11-block-level-buffered-retry.md`（Phase 6 的外部依赖，进行中）
