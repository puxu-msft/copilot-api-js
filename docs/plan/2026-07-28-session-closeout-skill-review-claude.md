# session-closeout skill 合并——使用者视角评审（Claude）

> 评审对象：`1fa01c6b`（本轮教训折进 conventions/skill/memory）与 `ed455b9d`（session-closeout 新增 §6 跨会话交接）。
> 视角：**未来的会话在真实压力下读这份 skill，能不能照着做对**。裁判轴：长远正确 + 完整；「太细/用不上」不构成批评，「会误导 / 无法执行 / 与别处冲突 / 陈述不实 / 遗漏」才是。
> 只读评审，除本报告外未修改任何文件。

## 结论摘要

- **总体 verdict：修复 major 后可进入下一阶段。blocker 数 = 0；major = 6，minor = 7，nit = 2。**
- **Q1 触发可靠性**：部分命中。`description` 有「任务跨会话」+ 字面量 `HANDOVER`/`KICKOFF`，但**缺「上下文将满 / compact / 接手 / 新会话 / 续作」这些在触发时刻真正会冒出来的词**；写法也比同仓 `choosing-test-type` / `client-proxy-e2e-testing` / `upstream-hook-mocking` 少了「触发症状：「…」」「即使用户只说「…」也用本 skill」这一层（见主观建议）。
- **Q2 可执行性**：§6 的「HANDOVER 必含」「KICKOFF 写法」可直接执行；**「产物必须进仓库并提交」给的动作是裸 `git add`，与本节标题（提交）不一致，且在共享树里正是 §5 收窄的形态（F7）**；**「写之前先 `git log --oneline -20`」只给检测不给动作，且弱于同轮写进 `empirical-verification` 的同源指导（F5）**；HANDOVER↔KICKOFF 分工无判据，四条对四条里两条实质重复，读者会写重（F11）。
- **Q3 顺序与位置**：§6 放在 §5 之后**不**形成提交回环（§6 自带「即时提交」，自洽）；但**「按序走完六步」与 §6 的触发条件（上下文将满）直接冲突——上下文剩 10% 的会话会把预算烧在 §1/§2，走不到 §6（F2，major）**。§3 收进实验产物**归属正确**（它是归档动作、不是交接动作），但 §3 标题未同步（F8）、CLAUDE.md 的压缩表述误导（F9）。
- **Q4 真实性核验**：`[[slug]]`、skill 名、`exp/keepalive-escalation-wire/README.md` 是宣称范式、「三份研究报告」、「早 6 小时」、`1fa01c6b` 的全部引用——**逐条实测为真**。**唯一被证伪的是「新 worktree 不 `bun install` 则 eslint exit 127」（F3，major，附正样本对照）**；另有一条 fatal 命令 `git log --oneline master ..`（F4，major）。
- **Q5 自洽**：**SKILL.md:8 仍写「五步名」，而同一提交已把 CLAUDE.md:54 改成六步（F1，major）**；§3 标题 / CLAUDE.md ③ 表述 / 交接文档位置约定 / MEMORY.md 归类各有一处不一致（F8/F9/F10/F14）。

### 双视角覆盖证据

**机械核对做了哪些扫描/对账/查证**：① `ls docs/memory/` 逐个核 `[[slug]]`（含否定对照）；② `ls .claude/skills/ ~/.claude/skills/ ~/.claude/my/*/skills/` 核 6 个被引用 skill 名；③ 对 SKILL.md 引用的 8 个 CLAUDE.md 锚点逐个 `grep -c`，配 `protect-user-main-server` 正样本；④ `cat exp/keepalive-escalation-wire/README.md` + `git ls-files` 核「范式」与入库状态；⑤ `git log --format=%ai/%ci` 核 `883e0533` 与「早 6 小时」；⑥ `1fa01c6b` 引用的 spec 文件 / ratchet 测试 / sanitize 目录 / `compat.ts` / 两个 config 键 / `30_000` 预算逐个 `ls`/`grep`；⑦ `git log -L` 追 `test:backend` 脚本变更时刻，与 `ed455b9d` 时间戳对账；⑧ 扫全仓 21 份 handover/kickoff 文件的命名形态与状态注解覆盖率；⑨ 横向对照全部项目 skill 的 `description` 写法。

**第一人称执行模拟了哪些流程/分支/用户路径**：① 扮演「上下文剩 10%、任务未完」的会话，从 `description` 检索 → CLAUDE.md:54 → SKILL.md 从 §1 顺序执行，观察在哪一步耗尽预算（→ F2）；② 扮演接手会话，按 §6「位置与分工」在**无 node_modules** 的 `.worktrees/anchor-flaky` 里真跑 `bun run lint`（→ F3）；③ 扮演接手会话在 worktree 里执行 KICKOFF:21 的 `git log --oneline master ..`（→ F4）；④ 扮演写交接的人执行「写之前先 `git log --oneline -20`」，跑完后追问「看到 peer 动过之后要做什么」（→ F5）；⑤ 扮演写交接的人在共享主树上按「先 `git add`」保护产物，对照 §5 与 `git-preference:coordinating-a-shared-git-worktree` 的黑白名单（→ F7）；⑥ 扮演接手会话按 KICKOFF「测试门禁现状」跑 `bun run test:backend`（→ F12）；⑦ 扮演写交接的人决定文件放哪，比对 §6 约定与仓库现存 21 份的实际形态（→ F10）；⑧ 逐条读 §6 的 HANDOVER 四条与 KICKOFF 四条，模拟「我该把这段写进哪一份」（→ F11）。

---

## 核验取证（命令 + 输出）

### V1 memory slug 存在性（含否定对照）

```
$ ls docs/memory/ | grep -i 'background-agent'
feedback-proactive-liveness-dead-check-on-background-agents.md
methodology-background-agent-result-surfacing-failure.md     ← SKILL.md:59 引用的正是这条 ✓
$ ls docs/memory/ | grep -i 'probe-conclusion'
methodology-probe-conclusion-scope-and-peer-invalidation.md  ✓
$ ls docs/memory/ | grep -i 'session-closeout'
session-closeout-and-handover.md                             ✓
$ ls docs/memory/ | grep -i 'this-slug-does-not-exist'
exit=1   ← 否定对照：检索式在「确实不存在」时会空，证明上面三条命中不是假阳性
```

### V2 skill 名存在性

```
$ ls .claude/skills/
… choosing-test-type … empirical-verification … session-closeout …          ✓
$ ls ~/.claude/skills/
… verifying-authoritative-claims …                                          ✓
$ ls ~/.claude/my/git-preference/skills/
coordinating-a-shared-git-worktree
disarming-lint-staged-rollback
isolating-from-a-shared-git-worktree                                        ✓
$ ls .claude/skills/session-closeout/
SKILL.md  complete-plan.md                                                  ✓（§3 引用的模板存在）
```

SKILL.md 引用的全部 skill 名与模板均可解析。

### V3 CLAUDE.md 锚点对账（正样本已过）

```
always-on-not-background                      -> hits=0   ✗ (SKILL.md:8)
knowledge-routing                             -> hits=0   ✗ (SKILL.md:37)
fine-grained-staging-per-phase-commit         -> hits=0   ✗ (SKILL.md:41)
concurrent-sessions-line-coexistence          -> hits=0   ✗ (SKILL.md:41)
subagent-explicit-rubric                      -> hits=1   ✓
docs-merge-before-execute                     -> hits=1   ✓（§6 新增段落引用的这条是好的）
empirical-verification                        -> hits=2   ✓
session-closeout                              -> hits=1   ✓
--- 正样本对照 ---
protect-user-main-server                      -> 1        ← 证明 grep 确实触达了 CLAUDE.md
```

### V4 「eslint exit 127」证伪（第一人称 + 正样本对照）

```
$ cd /home/xp/src/copilot-api-js/.worktrees && for d in */; do …; done
anchor-flaky/           node_modules=NO  .bin/eslint=NO      ← 恰好等价于「刚建好的 worktree」
（其余 7 个 worktree 都有 node_modules）

$ sh -c 'cd .worktrees/anchor-flaky && bun run lint --version; echo EXITCODE=$?'
$ eslint --cache --version
v9.39.4
EXITCODE=0                ← 证伪：没有 node_modules，eslint 照样跑通

$ sh -c 'cd /tmp/eslint-127-control && bun run lint --version; echo EXITCODE=$?'   ← 正样本对照
/usr/bin/bash: line 1: eslint: command not found
error: script "lint" exited with code 127
EXITCODE=127              ← 127 是真实存在的失败态，只是发生在**仓库外**，不在 .worktrees/
```

根因与佐证：

```
$ git config core.hooksPath        → exit=1（未设）
$ ls .husky                        → No such file or directory
$ grep -n 'simple-git-hooks\|lint-staged\|husky' package.json  → exit=1（无命中）
$ ls .git/hooks/ | grep -v sample  → 空
```

即本仓**已无 pre-commit hook**（与 CLAUDE.md「2026-06-29 起无 pre-commit 门禁」一致）。而 127 这条声称的唯一真实出处是 user-level skill：

```
$ grep -n '127' ~/.claude/my/git-preference/skills/isolating-from-a-shared-git-worktree/SKILL.md
21: A freshly-added worktree has no `node_modules`, so its pre-commit hook fails and the merge commit aborts.
43: **A fresh `git worktree` has no `node_modules` → pre-commit hook exits 127.** … its `lint-staged → eslint` pre-commit hook dies …
```

——它明确限定在 **pre-commit hook** 语境（hook 的 PATH 只含本 worktree 的 `node_modules/.bin`，不向上解析）。本仓已无该 hook，手工调用则会向上解析到仓库根。

本仓自己的记忆已写下相反结论：

```
$ cat docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md
## 第三方向（2026-07-28 新增）：仓库内的 worktree 不是依赖隔离环境
… `git worktree add .worktrees/<name>` 建在仓库目录**内部**，而 node/bun 的模块解析是逐级向上找
`node_modules`：`.worktrees/x/ui/` → `.worktrees/x/` → `.worktrees/` → **仓库根（有完整 node_modules）**。
```

### V5 `git log --oneline master ..` 是 fatal（第一人称执行 + 语义对照）

```
$ git log --oneline master ..
fatal: ..: '..' is outside repository at '/home/xp/src/copilot-api-js'
exit=128
--- 正样本对照 ---
$ git log --oneline -3
d3a2f546 …   ← git log 本身工作正常，上面的 fatal 来自参数而非环境
```

即便按最可能的意图修成 `master..`，方向仍是反的（在 worktree `debug/anchor-flaky` 上实测）：

```
$ git log --oneline master..   （= master..HEAD）
79551d06 docs(plan): record completed allocator phases                 ← 这是**我自己**的提交
$ git log --oneline ..master   （= HEAD..master）
d3a2f546 docs(plan): name the two clocks the ingress change created    ← 这才是 **peer** 落的
```

### V6 exp README 是否真是宣称的范式

```
$ cat exp/keepalive-escalation-wire/README.md
# 探针：升级期的空 content_block_delta 到底上不上 wire
## 它回答的问题                              ✓
## 结论（2026-07-27 实测）                   ✓
## 复跑（~20 秒，不打真上游、不碰 4141）      ✓
## 这发探针**没有**证明什么（重要）           ✓  ← SKILL.md:33 的必填项确实存在且写得实
## 未闭合的问题                              ✓（额外一节，超出 skill 要求）
$ git ls-files exp/keepalive-escalation-wire/
exp/keepalive-escalation-wire/README.md
exp/keepalive-escalation-wire/hook.ts
exp/keepalive-escalation-wire/wire-capture-2026-07-27.txt   ← 已入库，与 §6「产物必须进仓库」自洽
```

**结论：这条声称属实。** 唯一差异是节序（skill 写「回答什么问题 / 结论 / 它没有证明什么 / 复跑配方」，README 是「… / 结论 / 复跑 / 没有证明什么」），不影响执行。

### V7 「三份研究报告」「早 6 小时」

```
$ ls docs/plan/2026-07-27-keepalive-and-separator/
research-keepalive-options.md  research-order-invariant-audit.md  research-separator-options.md   ← 恰 3 份 ✓
HANDOVER.md  KICKOFF.md  review-c3-round2.md  review-merged-state.md  review-q1-preheader.md

$ git log --format='author-date=%ai%ncommit-date=%ci' -1 883e0533
author-date=2026-07-27 15:20:57 +0000
commit-date=2026-07-27 20:40:09 +0000
```

探针跑在 21:10（README 自述）。以 `git log` 默认显示的 **author date 15:20** 计，差 5h50m ≈「早 6 小时」——**声称成立**（附带观察见 F16）。

### V8 `1fa01c6b` 的引用逐条可解析

```
$ ls docs/spec/2026-07-26-thinking-terminal-block-layout.md       ✓
$ ls tests/architecture/circular-deps-ratchet.unit.test.ts        ✓
$ grep -n '}, [0-9]' tests/architecture/circular-deps-ratchet.unit.test.ts
67:  }, 30_000)                                                   ✓ 与 conventions 写的 `}, 30_000)` 一致
$ ls -d src/lib/anthropic/sanitize/                               ✓
$ find src -name 'compat.ts' → src/lib/config/compat.ts           ✓
$ grep -rln 'separator_accept_extra\|separator_carrier\|assistant_block_layout_strategy' src/
src/lib/config/{compat,config,schema}.ts  src/lib/anthropic/sanitize/block-layout-contract.ts  src/lib/state.ts   ✓
$ git log -1 883e0533 → fix(anthropic): preserve empty streaming deltas   ✓（§② 引用的 commit 真实且主旨相符）
```

### V9 `test:backend` 门禁陈述已失真（时间对账）

```
$ grep -n '"test:backend"\|"test:ci"' package.json
56:    "test:backend": "bun scripts/parallel-test.ts unit it http",
59:    "test:ci": "bun run build:history-search && bun run test:backend && …",

$ git log -L '/"test:backend"/,+1:package.json'
COMMIT 1b8bdf2f 2026-07-28 09:30:35 +0000  build: stop building history-search by default…
-    "test:backend": "bun run build:history-search && bun scripts/parallel-test.ts unit it http",
+    "test:backend": "bun scripts/parallel-test.ts unit it http",

$ git log --format='%h %ci' -1 ed455b9d
ed455b9d 2026-07-28 11:10:41 +0000        ← 比 1b8bdf2f 晚 1 小时 40 分
```

而 KICKOFF.md:27 仍写「`bun run test:backend` 在本机跑不起来（先跑 `build:history-search`…）。用 `bun scripts/parallel-test.ts unit it http` 替代」——**两者现在是同一条命令**。

### V10 交接文档位置约定 vs 仓库现状

```
$ find docs/plan -name 'HANDOVER.md' -o -name 'KICKOFF.md'
docs/plan/2026-07-27-keepalive-and-separator/HANDOVER.md
docs/plan/2026-07-27-keepalive-and-separator/KICKOFF.md          ← 目录式，全仓仅此 1 例
$ ls docs/plan/ | grep -i 'handover\|kickoff' | wc -l
21                                                               ← 扁平式 21 份
$ git log --format='%h %ci %s' -1 <peer 提交>
b3c98681 2026-07-28 11:01:34  /  b3dc851d 11:14:05  /  d3a2f546 11:22:31
   ← docs/plan/2026-07-28-handover-open-work.md（扁平式）在 ed455b9d(11:10) 前后仍被 peer 继续写
```

状态注解覆盖率（`head -6` 内是否含 实施状态 / 已完成 / 未实施 / 部分完成 / 仅研究 / 已归档 / 已失效）：

```
HAS-STATUS: 5 / 29     no-status: 24 / 29
（本轮新写的 HANDOVER.md 与 KICKOFF.md 均为 no-status）
正样本对照：docs/plan/monorepo-split/plan-token-package.md 头部确有状态/指引块，检索式能命中该形态
```

### V11 description 写法横向对照

```
$ for f in .claude/skills/*/SKILL.md; do grep -m1 '^description:' "$f"; done
choosing-test-type：      …触发症状：「这个该不该用 e2e / 真 SDK」「这条 e2e 是不是冗余、能删吗」…
client-proxy-e2e-testing：…即使用户只说「测客户端行为」「e2e」「claude 会不会卡住」也用本 skill。
upstream-hook-mocking：   …即使用户没说「hook」二字，只要意图是「测代理行为但不想真打上游」就用本 skill。
session-closeout：        当 copilot-api-js 会话/阶段收尾时使用（交付/报告/ExitPlanMode/提交前/任务跨会话）——…
```

session-closeout 的 description 里出现的词：交付、报告、ExitPlanMode、提交前、任务跨会话、HANDOVER、KICKOFF。**未出现**：上下文将满 / 快满 / compact / 接手 / 新会话 / 续作 / 交棒。

### V12 记忆库归类与 frontmatter

```
$ grep -c 'node_type' docs/memory/*.md → 97 有 / 45 无（含 MEMORY.md）
   → 新增两条 stub 缺 node_type，属既有混合惯例内，不单列为发现。
MEMORY.md 归类：
  methodology-probe-conclusion-scope-and-peer-invalidation → 放在「精炼保留（…触发钩子，细节读正文）」
  而其正文写：「实质与防法在 skill `empirical-verification` §「探针的三个失效模式」，这里只留触发钩子」
  → 与上方「已下沉到项目 skill 的方法论（记忆文件 = stub 指向）」段的定义更吻合。
```

---

## 发现

### 事实性发现

**[major] F1 —— `.claude/skills/session-closeout/SKILL.md:8` —— 同一句里「六步」与「五步名」并存，且「五步名」已被同一提交证伪**

事实：第 8 行为「按序走完下面**六步**……CLAUDE.md `session-closeout` 是 always-on 触发器（**五步名** + 指向本 skill）」。而 `ed455b9d` 已把 `CLAUDE.md:54` 改成「① … ⑤ 细粒度阶段提交 ⑥ **跨会话交接**」。

为什么是问题：读者按正文描述去 CLAUDE.md 求证 always-on 触发器的覆盖范围，会得到「CLAUDE.md 只列到第五步 ⇒ 第六步不在 always-on 触发范围 ⇒ 只有主动读 skill 才需要做交接」的错误推论——而交接恰恰是最需要 always-on 提醒的一步。这属于「主句写默认 A、子点标 B」的形态：机械核对信息齐全，第一人称走查才暴露。

建议：改为「（六步名 + 指向本 skill）」。

---

**[major] F2 —— `SKILL.md:8` 与 `SKILL.md:43` —— 「按序走完六步」与 §6 的触发条件互斥，压力场景下必然走不到 §6**

事实：§6 的触发之一是「上下文将满」。而第 8 行要求「**按序**走完下面六步」，顺序上 §1 是「派 subagent 多视角对抗核验 + 读它引用的每个 `file:line`」、§2 是「跨文档 grep 扫描 + broken-link/L1 守卫」——这两步是六步里上下文开销最大的两步。

失败场景（第一人称走查）：会话剩约 10% 上下文、任务未完 → 按序执行 §1 派 reviewer、读回报告、逐条复核 `file:line` → §2 跑三组 grep 并逐个核对 → 上下文耗尽或触发 auto-compact → **§6 从未执行**。而在这个触发条件下，§6 是六步里唯一不可失去的产物：§1–§5 的成果丢了还能重做，交接丢了则整轮工作无法被接手。

为什么是问题：skill 明文要求「按序」，且没有任何例外说明；读者若自行跳到 §6，等于违反本 skill 的显式纪律。这不是冗余问题，是**顺序会误导执行**。

建议：在第 8 行或 §6 首段加优先级例外，例如「**触发原因是『上下文将满』时，§6 优先于 §1–§5 执行**——交接是唯一不可重做的产物；其余步骤在交接落盘并提交后按剩余预算继续，做不完的写进 HANDOVER 待办」。

---

**[major] F3 —— `SKILL.md:45` —— 「`bun install`，否则 eslint exit 127」对本仓的 `.worktrees/` 布局为不实陈述，且与本仓记忆直接矛盾**

事实（见 V4）：在无 `node_modules` 的 `.worktrees/anchor-flaky` 中 `bun run lint --version` → `v9.39.4`、`EXITCODE=0`；正样本对照在仓库外的 `/tmp` 才复现 127。本仓 `core.hooksPath` 未设、无 `.husky`、`package.json` 无 `lint-staged`/`simple-git-hooks`、`.git/hooks` 只有 sample——即 127 唯一的真实出处（user-level skill 里限定的 `lint-staged → eslint` **pre-commit hook**）在本仓已不存在。`docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md` 第三方向明写 `.worktrees/` 会向上解析到仓库根 `node_modules`。

为什么是问题：三重。① 陈述不实；② 它教给读者一个**错误的心智模型**（「仓库内 worktree 是依赖隔离环境」），而该记忆整节存在的意义就是纠正这个模型——按错模型做「裸装能不能跑」的验证会假绿；③ 它**挤掉了真正该在这里说的两条**：新建 worktree 缺 gitignored 构建产物（`native/history-search/*.node`）会稳定红 14 条、极易误判为既有失败；以及分支里 `bun add` 的依赖 FF 回主树后主树须补 `bun install`。按「遗漏比冗余严重」，②③ 比 ① 更重。

建议：把括号内的理由换掉，例如「（`.worktrees/` 内仍向上解析主树 `node_modules`，**不是**依赖隔离环境；真正会咬的是：新树缺 gitignored 构建产物 → 测试假红，以及分支内 `bun add` 的依赖 FF 后主树要补装——见 [[reference-worktree-bun-add-needs-main-tree-install-after-merge]]）」。

---

**[major] F4 —— `docs/plan/2026-07-27-keepalive-and-separator/KICKOFF.md:21` —— `git log --oneline master ..` 是 fatal 命令，且最可能的修正方向也是反的**

事实（见 V5）：`git log --oneline master ..` → `fatal: ..: '..' is outside repository`，exit 128；正样本 `git log --oneline -3` 正常。修成 `master..`（= `master..HEAD`）列出的是**我自己的**提交；要看 peer 落了什么应是 `..master`（= `HEAD..master`），实测两者输出集合相反。

为什么是问题：`ed455b9d` 删掉了 HANDOVER 里的同一条，却把 KICKOFF 里的这条留下了——而 KICKOFF 第一行就是「**复制下面整段作为新会话的第一条消息**」，这是**最会被逐字执行**的那份。接手会话粘贴执行 → fatal → 极可能直接跳过这一步，而「合并前查 peer」正是本轮教训的核心（同一行的下半句就在讲这个教训）。

建议：改为 `git log --oneline ..master -- <你改动的路径>`（或 `git fetch` 后的等价形式），并把这条命令写成 skill §6 的正式配方，避免各 KICKOFF 各自发明。

---

**[major] F5 —— `SKILL.md:63` —— 「写之前先 `git log --oneline -20`」只给检测不给动作，且弱于同轮写进 `empirical-verification` 的同源指导**

事实：整条只有「并发会话可能已经落地或推翻了你要交接的内容……交接一旦陈旧，危害大于没有」，**没有一句说看到 peer 动过之后要做什么**。对照 `1fa01c6b` 写进 `.claude/skills/empirical-verification/SKILL.md:74` 的同源条目：「先 `git log --oneline -20` **+ `git log -S<关键符号>`** 看这块最近有没有被动过」——§6 丢掉了 `-S` 这一半，而 `-S` 才是真正能定位「我这条结论对应的代码被谁动过」的检索。此外 `-20` 无 path 限定：本仓 8 个活跃 worktree 并发，20 条提交可能只覆盖两三小时，且大多与本主题无关。

失败场景（第一人称）：我跑了 `git log --oneline -20`，看到 5 条 peer 提交都在 `docs/plan/`——然后呢？skill 没说要逐条判断它是否触及我 HANDOVER 里的哪条硬事实/待办，也没说命中后是「重新核验并改写」还是「删掉该条」还是「降级证据等级并标注」。结果是这条纪律停留在提醒，不构成可执行动作。

建议：补三件事——① 检索式升级为 `git log --oneline ..master -- <相关路径>` + `git log -S<你结论里的关键符号>`；② 命中后的动作（受影响的硬事实重新核验或降级为「待验证假设」、受影响的待办改写或标注「已被 `<sha>` 作废」）；③ 落盘时写上「本交接核验于 `<sha>`」，让接手会话能一眼判断新鲜度。

---

**[major] F6 —— `SKILL.md:43-63` —— §6 没有交接文档的生命周期纪律（状态注解 / 失效 / 归档），而 §3 对 plan 与 exp 都给了**

事实（见 V10）：§3 强制 plan 有「四档头部实施状态注解」、强制 exp README 有四段模板；§6 对 HANDOVER/KICKOFF **零要求**。实测仓库内 29 份 handover/kickoff/research/review 文档中 24 份无任何状态注解，包括本轮新写的 HANDOVER.md 与 KICKOFF.md。

为什么是问题：§6 自己写下「**交接一旦陈旧，危害大于没有**」，却没有给出防止陈旧的任何机制。接手会话面对 `docs/plan/` 下 21 份 handover/kickoff，无法判断哪份是活的——这正是 §6 自述的危害在仓库尺度上的实现。属遗漏，按裁判轴较重。

建议：§6 补一条与 §3 对称的规定——HANDOVER/KICKOFF 头部必须带状态行（进行中 / 已被接手（会话或分支）/ 已完成（落地 commit）/ 已失效（原因）+ 最后核验的 `<sha>` 与日期）；完成后按 §3 的归档纪律加注解，不删。

---

**[minor] F7 —— `SKILL.md:57` —— 小节标题说「进仓库并**提交**」，给出的动作却是裸 `git add`；且裸 `git add` 正是 §5 与 `git-preference` 收窄的形态**

事实：小节标题「**产物必须进仓库并提交**（这一条踩过实亏）」，末句动作是「**先 `git add` 再写引用它们的交接**」。而 §5 明确「严格细粒度暂存、绝不整仓暂存」；`git-preference:coordinating-a-shared-git-worktree` 的黑白名单是「`git add -- <your exact paths>`，**Never** `git add -A`/`.`/`-u`/`commit -am`」；本仓 CLAUDE.md 更进一步要求「一律显式 pathspec（`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`）」，理由是 pathspec commit「取工作区当前内容、免疫 peer 并发 `git add` 的 index TOCTOU race」。

为什么是问题：① `git add` 确实能挡住 `git clean`（已入 index 即非 untracked），所以本条不是错的，但它**只做到一半**——留在共享 index 里的文件会被 peer 的无-pathspec `git commit` 卷走，这是本仓已记录过的事故形态；② 压力下的读者会逐字执行「先 `git add`」，写成裸 `git add` 或 `git add .`；③ 标题（提交）与动作（暂存）不一致，读者不知道以哪个为准。

建议：动作写全并显式 pathspec：「**先 `git add -- <精确路径> && git commit -F <msgfile> -- <精确路径>` 落一个提交，再写引用它们的交接**——只 `git add` 会把文件留在共享 index，peer 的无-pathspec 提交会把它卷走」。

---

**[minor] F8 —— `SKILL.md:24` —— §3 标题未随内容扩展同步**

事实：标题仍是「## 3. 归档 plan —— 迁 docs/plan + 头部实施状态注解」，而 `ed455b9d` 已在正文加入「实验/探针产物同样归档」，`description` 与 `CLAUDE.md:54` 也都改成了「plan 与实验产物」。

为什么是问题：读者做「我这轮有 exp/ 产物要不要处理」的检索时，靠标题扫描会漏掉这一步（标题是 skill 内导航的主索引）。

建议：标题改为「## 3. 归档 plan 与实验产物 —— 迁 docs/plan、exp/<topic> + 状态/边界注解」。

---

**[minor] F9 —— `CLAUDE.md:54` —— 「（迁 `docs/plan/`、`exp/<topic>/` + 头部实施状态注解）」把两套不同模板压成一句，产生误读**

事实：skill §3 对两类产物的要求**不同**：plan 是「迁入 `docs/plan/` + 四档头部实施状态注解」；exp 是「**就地** `exp/<topic>/` + 四段 README（回答什么问题 / 结论 / 它没有证明什么 / 复跑配方）」。CLAUDE.md 的压缩表述读起来是「把东西迁进 `exp/<topic>/` 并加头部实施状态注解」。

为什么是问题：CLAUDE.md 是 always-on、被读到的频率远高于 skill 正文；一个不打开 skill 的会话会照着错误的动作执行——给 exp README 加四档状态注解，而漏掉「它没有证明什么」这个必填项，后者正是 `1fa01c6b` 整轮教训的核心。

建议：「③ 归档 plan（迁 `docs/plan/` + 四档状态注解）与实验产物（`exp/<topic>/` README 须含「它没有证明什么」）」。

---

**[minor] F10 —— `SKILL.md:45` —— 交接文档位置约定与仓库现存 21 份的形态冲突，且未声明取代关系**

事实（见 V10）：§6 规定 `docs/plan/<date>-<topic>/HANDOVER.md` + `KICKOFF.md`（目录式，全仓仅本轮这 1 例）；仓库现有 21 份用扁平式 `docs/plan/<date>-handover-<topic>.md` / `-kickoff.md`，MEMORY.md 索引里多条也指向扁平式路径（如 `docs/plan/2026-07-27-handover-max-tokens-and-keepalive.md`、`docs/plan/2026-07-23-handover-h2-pool-and-silence-spec.md`）。`ed455b9d` 落地前后，peer 会话仍在写扁平式的 `docs/plan/2026-07-28-handover-open-work.md`。

为什么是问题：读者面对「这是新约定还是只是本轮的做法？旧的 21 份要不要迁？」没有答案；MEMORY.md 的既有指针也不会自动跟着走。本项目「无向后兼容负担」允许强制迁移，但**必须写明**，否则两种形态长期并存、检索不到。

建议：§6 显式声明「目录式为**新约定**，旧扁平式不追溯迁移」或「分批迁移并同步更新 MEMORY.md 指针」，二选一并写下理由。

---

**[minor] F11 —— `SKILL.md:49-61` —— HANDOVER 与 KICKOFF 的分工缺判据，四条对四条里两条实质重复**

事实：HANDOVER 必含第 3 条「每条待办带验收判据 + 证伪方式……用户已批准的、已裁决的、仍待裁决的分叉分开标」≈ KICKOFF 第 ② 条「待办含用户批准状态与优先级，未裁决的明确标『需用户先定』」；HANDOVER 第 4 条「自己犯过的错与其成因」≈ KICKOFF 第 ③ 条「这一轮反复踩的坑」。skill 从未说出两者的区分原则。实证：本轮 KICKOFF.md 的「待办与优先级」「这一轮反复踩到的坑」两节，正文里都写着「交接文档 §3 有 T1–T6」「交接 §5 有完整版」——即事实上是 HANDOVER 的摘录。

为什么是问题：没有判据的读者有两种错法——写重（同一内容维护两处，其中一处必然先陈旧），或写漏（以为 KICKOFF 写了 HANDOVER 就不用写）。user-rule `40-dev-workflow` 其实给了区分（「each plan should include a kick-off prompt doc **for the user to copy**」），但 §6 没引。

建议：§6 开头补分工判据，例如「**HANDOVER = 完整档案**，按需查阅、是唯一事实源；**KICKOFF = 可整段复制为新会话第一条消息的提示词**，只放『不先知道就会做错』的东西，其余一律指向 HANDOVER 的小节号，**绝不复述内容**」。

---

**[minor] F12 —— `KICKOFF.md:27` —— §6 ④ 要求写的「测试门禁现状」在示范物里当天即失真，而 §6 未要求标注核验时点**

事实（见 V9）：KICKOFF 写「`bun run test:backend` 在本机跑不起来（先跑 `build:history-search`，而 rustup 没配默认 toolchain）。用 `bun scripts/parallel-test.ts unit it http` 替代」。`1b8bdf2f`（2026-07-28 09:30:35，早于 `ed455b9d` 11:10:41 共 1 小时 40 分）已把 `test:backend` 改成 `bun scripts/parallel-test.ts unit it http`——**建议的替代命令与被判死刑的命令现在是同一条**。

为什么是问题：这是 §6 ④「测试门禁现状与禁区」这类**易腐信息**的必然结局，而 §6 没有配套的保鲜要求。接手会话读到后会绕开一条其实可用的门禁命令（并因此错过 CLAUDE.md 规定的「交付前用 `test:backend`」），或反过来怀疑整份 KICKOFF 的可信度。

建议：§6 ④ 补「门禁现状必须标『核验于 `<日期>` / `<sha>`』，接手会话第一件事是复验而非采信」。本轮 KICKOFF 该条本身建议一并修正（不在本次评审的改动授权内，故只提出）。

---

**[minor] F13 —— `SKILL.md:8,37,41` —— 4 个 CLAUDE.md 锚点不存在（预存缺陷，两提交未引入）**

事实（见 V3，正样本已过）：`always-on-not-background`(:8)、`knowledge-routing`(:37)、`fine-grained-staging-per-phase-commit`(:41)、`concurrent-sessions-line-coexistence`(:41) 在 CLAUDE.md 中 hits=0。CLAUDE.md 现有对应条目名分别是（无对应）、「文档路由」小节、「细粒度、每阶段提交」、「concurrent-sessions 行级共存」。

为什么是问题：§5 明确说「具体命令黑白名单……见 CLAUDE.md `fine-grained-staging-per-phase-commit`/`concurrent-sessions-line-coexistence`（单一源，勿在此复述以免漂移）」——即 §5 把可执行细节全部外包给了两个**查不到的锚点**。读者要么放弃、要么凭印象。这直接放大 F7：§6 说「先 `git add`」，§5 说「细节见 X」，而 X 不存在。

建议：改为实际存在的锚点（「细粒度、每阶段提交」「concurrent-sessions 行级共存」）或直接给 CLAUDE.md 的小节名。虽为预存，但 §5/§6 是本轮重点，值得一并修。

---

**[nit] F14 —— `docs/memory/MEMORY.md` —— 新增的 probe 条目归类与其正文自述不符**

事实：`methodology-probe-conclusion-scope-and-peer-invalidation` 被放进「## 精炼保留（verification 簇 / 独有教学价值；触发钩子，**细节读正文**）」，而其正文首段写「实质与防法在 skill `empirical-verification` §「探针的三个失效模式」，**这里只留触发钩子**」——按 MEMORY.md 自己的分类定义，它属于上方「## 已下沉到项目 skill 的方法论（记忆文件 = stub 指向）」。

为什么是问题：MEMORY.md 是引用层，分类段本身承载「去哪读正文」的语义；归错段会让读者去读一份声明自己不是正文的 stub。

建议：移到「已下沉到项目 skill」段，格式对齐该段（`→ skill 'empirical-verification' — <钩子>`）。

---

**[nit] F16 —— 「早 6 小时」用的是 author date，而该修复对主线可见是在探针前 30 分钟**

事实（见 V7）：`883e0533` author date 15:20:57、commit date 20:40:09，探针 21:10。「早 6 小时」按 author date 成立（`git log` 默认显示 author date，读者复验会看到 15:20，不会觉得文档错）。

为什么记一笔：本轮自己的教训第 1 条正是「`offsetMs` 是 commit 相对的——做时间归因前先确认时间基」，而这个「6 小时」同样**时间基敏感**：若将来有人用它论证「有足够长的窗口本该发现」，按 commit date 只有 30 分钟。不构成缺陷，仅提示若要保留该数字可加「（author date）」。

### 主观建议

**[建议] `.claude/skills/session-closeout/SKILL.md:3`（frontmatter description）—— 补入触发时刻真正会出现的词**

改进点：description 是 skill 被检索到的唯一线索。现有触发词是**收尾语义**的（交付 / 报告 / ExitPlanMode / 提交前 / 任务跨会话），但 §6 的高价值触发场景是**上下文压力**的。一个「上下文快满、任务没做完」的会话，脑内出现的词更可能是「上下文」「compact」「快满」「接手」「新会话」「交棒」「继续这个任务」，这些词一个都不在 description 里。CLAUDE.md:54 是 always-on 常驻，理论上能兜底，但它同样只列了「任务跨会话」。

预期影响：命中率提升集中在最需要它的那一次；且与同仓 `choosing-test-type` / `client-proxy-e2e-testing` / `upstream-hook-mocking` 的写法一致（那三条都带「触发症状：「…」」或「即使用户只说「…」也用本 skill」）。

推荐做法：在 description 尾部加同风格的触发症状串，例如「触发症状：「上下文快满了」「这轮做不完了」「给下一个会话写个交接」「新会话怎么接手」「compact 前要做什么」——即使用户只说「先记一下进度」也用本 skill」。同步把 CLAUDE.md:54 的触发括号扩成「（交付/报告/ExitPlanMode/提交前/任务跨会话/上下文将满）」。

**[建议] `SKILL.md` §6 —— 给 HANDOVER 一个可照抄的骨架文件，与 §3 的 `complete-plan.md` 对称**

改进点：§3 把格式外包给同目录模板 `complete-plan.md`，§6 只有散文描述的 8 条要求。写交接的人在上下文紧张时最需要的是「照抄这个骨架、逐节填空」，而不是从 8 条要求反推结构。

预期影响：降低每次交接重新发明结构的成本；使「每条待办带验收判据 + 证伪方式」「证据等级标注」「自己犯过的错」这三条最易漏的要求变成模板里的空槽（空着就显眼），而不是靠记忆。

推荐做法：新增 `.claude/skills/session-closeout/handover.md`（HANDOVER 骨架 + 一份填好的短样例 + KICKOFF 骨架），§6 改为指向它，正文只留判定纪律，与 §3 的处理方式一致。

---

## 我判定合格的点

以下各条均经上文取证，**不是凭读**：

1. **所有 `[[slug]]` 引用真实存在**（V1，含否定对照）：`methodology-background-agent-result-surfacing-failure`、`methodology-probe-conclusion-scope-and-peer-invalidation`、`feedback-pass-null-clean-not-self-validating`、`feedback-verify-deferred-task-not-already-landed-before-designing`。
2. **所有被引用的 skill 名与模板真实存在**（V2）：`empirical-verification`、`verifying-authoritative-claims`、`git-preference:coordinating-a-shared-git-worktree`、`git-preference:isolating-from-a-shared-git-worktree`，以及 §3 引用的同目录模板 `complete-plan.md`。
3. **`exp/keepalive-escalation-wire/README.md` 确实是它被声称的范式**（V6）：四段齐全，「这发探针**没有**证明什么」写得具体（点名 buffered 配置只覆盖 pre-content 路径、W3 仍是活缺口），还多一节「未闭合的问题」；且三份文件均已 `git ls-files` 入库，与 §6「产物必须进仓库」自洽。
4. **「本轮三份研究报告」属实**（V7）：`research-keepalive-options.md` / `research-order-invariant-audit.md` / `research-separator-options.md`，恰 3 份。
5. **「早 6 小时」属实**（V7）：`883e0533` author date 15:20:57 vs 探针 21:10，差 5h50m；`git log` 默认显示 author date，读者复验不会矛盾。
6. **`1fa01c6b` 引入 `docs/coding-conventions.md` 的全部引用可解析**（V8）：`docs/spec/2026-07-26-thinking-terminal-block-layout.md`、`tests/architecture/circular-deps-ratchet.unit.test.ts`（第 67 行确为 `}, 30_000)`，与文中写的一致）、`src/lib/anthropic/sanitize/`、`src/lib/config/compat.ts`、`separator_carrier`/`separator_accept_extra`/`assistant_block_layout_strategy` 三个键均在源码中存在。
7. **`empirical-verification` §② 引用的 commit 真实且主旨相符**（V8）：`883e0533 fix(anthropic): preserve empty streaming deltas`。
8. **§3 的 `-review`/`-research` 后缀约定与 §6 的目录布局互洽**：`docs/plan/2026-07-27-keepalive-and-separator/` 下确实是 `research-*.md` + `review-*.md`，两节没有互相打架。
9. **记忆确实只留 stub、没有复制**（正面回应用户「不要散落在其他地方」的原话）：`docs/memory/session-closeout-and-handover.md` 通篇是指针 + 触发钩子，六步只列名字，how-to 全部指回 skill；HANDOVER.md §4 也从 19 行 how-to 缩成「how-to 不在这里 → 见 skill」+ 只保留本轮证据。这一点做得干净，是本轮的主要价值。
10. **§6「产物必须进仓库」这条纪律在机制上成立**：`git add` 后文件不再是 untracked，`git clean -fd/-fdx` 确实不会删——事故叙述与补救动作在因果上对得上（缺的只是 F7 说的「只做到一半」）。

---

*评审者：Claude（使用者/可执行性视角）。本报告的每条事实性发现都附有可复跑的命令与输出；否定性结论均配了正样本对照。*
