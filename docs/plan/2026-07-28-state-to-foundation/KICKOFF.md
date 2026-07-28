# 新会话 kick-off 提示词

复制下面整段作为新会话的第一条消息。**本文只放"不先知道就会立刻做错"的东西**，其余一律指向 HANDOVER 小节号——两份文档重复同一件事，只会在其中一份被改时留下自相矛盾的交接。

---

接手 copilot-api-js 上一轮未完的工作：把 `src/lib/state.ts` + `src/lib/state-defaults.ts` 降成**只依赖语言/系统内置**的 foundation 叶子。

**唯一入口是 [HANDOVER.md](./HANDOVER.md)，请先完整读它**，再按它 §1 的指引读相关材料。

## 硬性工作方式

1. **代码改动走隔离 worktree**：`git worktree add .worktrees/state-foundation -b feat/state-foundation`。注意 `.worktrees/` 建在仓库内部，**向上解析主树的 `node_modules`，不是依赖隔离环境**——实测无 `node_modules` 的新树里 eslint 照样 exit 0；真正会咬的是新树缺 gitignored 构建产物导致的稳定假红。
2. **文档例外**：HANDOVER/KICKOFF/plan/spec 这类入口文档**在主树直接改并即时提交**——滞留在特性分支上等于没写。
3. **一律显式 pathspec 提交**（`git commit -F <msgfile> -- <精确路径>`）。主树现有十几个 peer 未提交文件，`git add -A` 会把它们卷进来——**绝对禁止**。
4. **绝不碰用户跑在 4141 端口的主服务器**。要验端点就起别的端口，用完按 PID 精确清理。
5. **测试命令用 `bun scripts/parallel-test.ts unit it http`**，别用 `bun run test:backend`（本机无 rustup toolchain，前置 rust 构建必挂，与本任务无关、也别顺手修）。

## 动工第一件事：复验，不是采信

本仓库并发提交频繁，交接一旦陈旧危害大于没有。按顺序跑完这三样再动手（详见 HANDOVER §6 第 4 条）：

1. **§3.1 的环数**（`computeCircularSnapshot()`，**禁止**从 `circular-deps-baseline.json` 推算）；
2. **§3.7 的出边枚举**——**必须用 AST**（调 `tests/architecture/source-ast.ts` 的 `allModuleSpecifiers()`），**别用 `rg`**：`rg '^import'` 会静默漏掉全部多行 import，`rg 'from "'` 也漏 side-effect / dynamic / `import = require` 等形态。**差集非空就先补表再动手。**
3. **§3.5 的消费者计数**。

**行号一律以符号名为准**，文档里的行号只作参考。

## 待办与优先级

按 HANDOVER §4 的 **S1 → S7** 顺序做，每步一个提交、每步终态绿。

- **S1 可以独立 land、不必等后面几步**（风险极低、削环收益最大）。
- **S2–S6 顺序依赖**；**S7（doc-sync）是交付的一部分，不是可选项**。
- **用户已批准的范围见 HANDOVER §2**（6 条，含 2 条明确的「不做」）。**别重开这个议题。**
- **动手前的 gate：HANDOVER §5 有 4 条待裁决分叉，需用户先定、别自己拍。** 其中第 3 条（`~/lib/token/types` 的包分层反转）会挡住 S6，第 4 条（spec 阶段 0d 与 S2 的关系）会决定 S2 要不要做。

## 这一轮反复踩的坑（各一行，完整版在 HANDOVER §6）

1. **SCC 数字只认实测**——我从基线环列表推算，高估 8 条。→ §6 第 1 条
2. **守卫"绿"不自证**，且**变异实验的正样本要有鉴别力**——S6 只用 `~/lib/x` 做正样本证明不了任何东西，新旧判据都咬它。→ §6 第 3 条
3. **`export … from` 不绑定本地名**——S1 搬走常量后原文件若自用需另 import。→ §6 第 3 条相邻
4. **注释写错，照着注释写的代码就看起来是对的**——S3 之后有 5 处注释会变成谎言。→ §6 第 5 条
5. **别把"削环视角"的结论当"叶子化视角"的前提**——这是第一版最严重的缺陷，§3.7 就是为它加的。→ §6 第 6 条

## 禁区

- **别在 `state.ts` 里留 re-export 来免改测试**（S2）。那不是纪律问题而是拓扑问题：`models/cache.ts` 必然 import state，立刻重建两节点环。详见 HANDOVER S2。
- **别改 S4 的 164 个 `setStateForTests` 调用点**；但**S2 相反**——S2 需要批量改写约 100 个测试文件的 models 符号 import，那是**已批准**的（无向后兼容负担）。两步的纪律别互相污染。
- **别把 `models` / `modelIndex` / `disabledModels` 等字段搬走**（本次只搬逻辑，字段留 state）。
- **别去修 typecheck 里 peer 在飞的报错**（`PostCommitAbortKind` / `retry-giveups`）——不是你引入的，只确认自己没新增。
- **别为了让 S6 的守卫变绿而把守卫改弱**。守卫红通常说明 S1–S5 还没做完，不说明守卫太严。
  - **唯一具名例外**：package-wide madge oracle 会咬到 `state.ts ↔ state-defaults.ts` 这条两节点环。**它是已知的、预期内的、S1–S5 碰不到的**（详见 HANDOVER §3.7 的 ⚠️ 与 S6 的预案，有两个正当选项）。**别因为这条红回头去找不存在的漏网边**——此时 §3.7 的差集是空的，你会转而怀疑枚举命令又漏了什么，那是死路。
