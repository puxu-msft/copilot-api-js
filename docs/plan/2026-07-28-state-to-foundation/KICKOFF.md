# KICKOFF：`state` + `state-defaults` 降为 foundation 叶子

> 贴给新会话/agent 的启动提示词。**先读 [HANDOVER.md](HANDOVER.md) 全文**，本文只是启动指令与红线。

## 工作方式（硬性要求，放最前）

1. **代码改动走隔离 worktree**：`git worktree add .worktrees/state-foundation -b feat/state-foundation`。注意 `.worktrees/` 建在仓库内部，**向上解析主树的 `node_modules`，不是依赖隔离环境**——实测无 `node_modules` 的新树里 eslint 照样 exit 0（本条订正自 skill 里一句已被证伪的「否则 eslint exit 127」）；真正会咬的是新树缺 gitignored 构建产物导致的稳定假红。
2. **文档例外**：HANDOVER/KICKOFF/plan/spec 这类入口文档**在主树直接改并即时提交**——滞留在特性分支上等于没写。
3. **合并前先查 peer**：`git log --oneline -20` + `git worktree list`。本仓库常有并发会话；本交接成稿前 peer 就已经把 S1 的工作量砍掉了三分之一。
4. **一律显式 pathspec 提交**（`git commit -F <msgfile> -- <精确路径>`）。主树现有十几个 peer 未提交文件，`git add -A` 会把它们卷进来——**绝对禁止**。
5. **测试命令**：用 `bun scripts/parallel-test.ts unit it http`。**别用 `bun run test:backend`**——它的前置 rust 构建在本机必挂（无 rustup toolchain），与本任务无关。
6. **绝不碰用户跑在 4141 端口的主服务器**。要验端点就起别的端口，用完按 PID 精确清理。

## 任务

把 `src/lib/state.ts` + `src/lib/state-defaults.ts` 降成 **只依赖语言/系统内置** 的 foundation 叶子。按 HANDOVER §4 的 S1→S6 顺序做，每步一个提交、每步终态绿。

**用户已批准的范围**（别重开议题）：
- ✅ state + state-defaults 进 foundation，前提是只依赖内置
- ✅ **简单 setter（约 30 个 `setXConfig`）留在 state** ——原话「简单的 setters 留在 state 上没问题」
- ✅ state 本身不需要测试
- ✅ 寄居的领域逻辑（models 缓存/过滤/索引、4 个 `resolve*`）回各自的域
- ❌ 不建独立 `config-vocabulary` 模块（多余：叶子无出边，state 自己就是词汇的家）
- ❌ 不把 30 个 config setter 拆到各域（那是范围扩大）

**需用户先裁决、别自己拍**（HANDOVER §5）：
- `Model` / `ModelsResponse`（GHC 上游 wire 类型）是下沉 foundation，还是给 state 的模型缓存换结构型 + 可赋值性 oracle。我倾向前者，但要用户认可 foundation 承载 GHC API 形状。

## 优先级

**S1 单独就值得先做**（两个字符串常量挪进 peer 已建好的零依赖叶子 `refusal-policy.ts`，实测 **70 环/63 成员 → 30/43**）。它风险极低、收益最大，**可以独立 land、不必等后面几步**。

S2–S6 顺序依赖，按 HANDOVER 走。

## 这轮反复踩的坑（读完再动手）

1. **SCC 数字只认实测**。用 `computeCircularSnapshot()`，**禁止**从 `circular-deps-baseline.json` 的环列表推算——我推算 70→21，实际 70→29，高估 8 条。
2. **守卫"绿"不自证**。S6 的边界守卫必须做变异实验（故意加一条违规 import，确认它真的变红）。刚过去的六轮评审里，每一轮我"验证过"的守卫都被下一轮用**合法语法**绕过；两次真正的转折都是换判据形状（blocklist→allowlist）或换不变量位置，而不是把排除名单写得更长。
3. **`export … from` 不绑定本地名**。S1 把常量搬走后，`recover-refusal.ts` 若自己还要用，得**另外再 import 一次**。
4. **注释写错，照着注释写的代码就看起来是对的**。我在一个守卫文档里写错一句关于 `catch` 的话，导致一个真实的假绿。写不变量注释时逐字确认语义。
5. **`"key" in patch` 门控**（S4）：要区分「显式 undefined→清空」与「缺席→不动」，token peel 记忆里明确写过。

## 禁区与门禁现状（**核验于 2026-07-28 / `847f8bc8`；接手第一件事是复验而非采信**）

- 别去修 typecheck 里 peer 在飞的报错（`PostCommitAbortKind` / `retry-giveups`）——不是你引入的，只确认自己没新增。
- 别改 `tests/` 下的 165 个 `setStateForTests` 调用点。S4 的反转方案就是为了让它们零改动；**如果你发现要改测试，说明反转做错了**。
- 别把 `models` / `modelIndex` / `disabledModels` 等**字段**搬走（本次只搬逻辑，字段留 state）。
- `bun run test:backend` 在本机跑不起来（rustup 无 toolchain），**不是你的问题、也别顺手修**；用 `bun scripts/parallel-test.ts unit it http`。
