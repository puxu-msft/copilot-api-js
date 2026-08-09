# Task 37 —— `acceptTerminal` failed-terminal 分流：撤回复核

评审者：全新独立 reviewer（未参与此前任何一轮）。
原范围：`src/lib/pipeline/delivery/grammar.ts` 的 `acceptTerminal`（`git show b8ab9dbb`）。
**中途改派**：主会话已撤回该分支，改问「撤回是否干净 / 归属判定是否站得住 / gate 处置是否正确 / 既有守卫是否完整」。本报告按新范围组织。

HEAD 全程 `b2048227`。工作树含主会话**未提交**的撤回改动。我用冻结 patch 做变异对照，复原后逐字节校验。

## 总体 verdict

**撤回本身正确、干净，归属判定成立。** 无阻断性问题。留下 2 条需要处理的残留（1 MAJOR、1 MINOR）与 1 条更优处置建议。

## 双视角覆盖证据

**机械核对**：`git diff` 冻结 patch + `apply --reverse --check`；`b8ab9dbb^:grammar.ts` 与当前工作树文件全文 `diff -u`；`rg` 全仓查 `responseFrames` / `discard-open-unit` / outcome 消费者；核对注释里那条 `docs/todo/deferred-backlog.md` 引用是否真的存在；核对 `entry-test-discovery-baseline.json` 新增条目与文件内实际用例数是否一致；核对 `[GATED — ...]` 前缀确为仓库既有惯用法。

**第一人称执行**：以「照这份产物去执行的人」走真实 HTTP 入口——把 `i9-followup-midblock-error.http.test.ts` 逐字复制成临时探针（只删断言、加打印），对同一个上游 fixture 在**分支生效态**与**撤回态**各跑一次，逐字读客户端实际收到的 SSE 字节；另用 `bun -e` 直接驱动 grammar 状态机走 unit / response-terminal 两种 mode；实跑 `delivery-grammar.unit.test.ts`、`test-discovery-matrix.unit.test.ts`、`h2-committed-block-delivery.http.test.ts`；实测 `test.failing` 在本仓 bun 版本下的行为。

临时探针 `tests/pipeline/zzz-reviewer-probe.http.test.ts` 与 `tests/pipeline/zzz-committed-i9.http.test.ts` **已删除**（`git status` 已确认工作树只剩你自己的 WIP 与本报告）。

## 事实性发现

### 新问题 1 —— 撤回是否干净、运行时是否与改前逐字节等价

**判定**：干净。运行时行为与 `b8ab9dbb^` **完全等价**，差异只有 5 行注释。没有漏撤的部分。
**严重级别**：INFO（无问题）

**证据**

```
git show b8ab9dbb^:src/lib/pipeline/delivery/grammar.ts > /tmp/pre.ts
diff -u /tmp/pre.ts src/lib/pipeline/delivery/grammar.ts
```

唯一 hunk 在 `grammar.ts:66` 之后，全部是 `+` 注释行（`// A failed terminal ...` 起 5 行）。没有任何可执行语句差异：`enterError([...])` 那一段与改前逐字节相同。

**范围提醒（不是缺陷，但请确认这是有意的）**：b8ab9dbb 改了两个 `src/` 文件，撤回只覆盖了 `grammar.ts`。`src/lib/pipeline/delivery/adapters/anthropic.ts` 的 SSE `event:` 行回退分类**保留未动**（`git status -- src/` 只列出 `grammar.ts`）。这半边与 grammar 分支正交、且是 clean-drain 形态的真实修复，保留是对的——但 b8ab9dbb 的 commit message 现在只有一半仍然成立，后续若整理提交历史需要注意。

### 新问题 2 —— 「半块泄漏是该分支引入的」这个归属判定

**判定**：**成立**。我独立复现，且证据链比你手上的更强一点——我在**不知道你会撤回**的情况下先拿到了「分支生效态」的样本。
**严重级别**：INFO（判定正确）

**取证协议**：`git diff -- src/lib/pipeline/delivery/grammar.ts` 冻结为 `/tmp/coord-revert.patch`（27 行）→ `git apply --reverse --check` 通过 → `--reverse` 应用（分支复活）→ 实测 → 正向 `git apply` 复原 → 重新 `git diff` 与冻结 patch `diff` 比对，**完全一致**。全程未用 `checkout` / `restore` / `reset` / `clean`。

**A/B 结果（同一探针、同一 fixture、同一 HEAD）**

| | 分支生效（HEAD 的 grammar.ts） | 撤回态（你当前的 WIP） |
|---|---|---|
| 上游调用次数 | **1** | **4** |
| 线上出现 `content_block_delta` | **有**（`"mid-block"`） | **无**（0 次） |
| 客户端收到的帧 | `message_start` → `content_block_start` → `content_block_delta` → `error`(overloaded) → `error`(合成 truncation) | 仅 `error`(合成 truncation) |

即：**半块只在分支生效时泄漏，撤回后不泄漏** —— 这正是「该分支引入」的判据，而不是既有缺陷。你的归属判定站得住。

**补强你的根因叙述**：真正的机制是 `discardOpen()`（`grammar.ts:36-43`）**只清 grammar 自己的记账**，它产出的 `discard-open-unit` outcome 在 `src/` 里**零消费者**（`rg -n "discard-open-unit" --type ts` 只命中 `protocol.ts:89` 的类型定义与 grammar 自身）。半块的帧早已作为 `buffer-real-frame` 进了 `driver.ts` 的缓冲区，grammar 够不到它。所以 b8ab9dbb commit message 里那句「the half-unit is still discarded, so no partial block reaches the wire」从一开始就是错的——**它把「grammar 内部丢弃」当成了「不会送达客户端」**。你新写的注释没有重复这个错误，是对的。

**顺带证伪一个次要前提**：`responseFrames: []` 不是新形态。`grammar.ts:96-97` 在 unit 模式把 structural 帧路由到 `structuralFrames`，而 `response-append`（`:135-136`）在 unit 模式直接 `modeError`——所以 **unit 模式下 `responseFrames` 恒为空**，正常终态（`:83-87`）本来也发 `[]`。而且 `outcome.responseFrames` 在 `src/` 里同样零消费者（活消费者只有 `candidate-response-session.ts:125-132` 与 `boundary-classifier.ts:42-47`，两者都只读 `kind` 与 `terminal.semantic`）。这条方向上确实没有丢帧风险。

### 新问题 3 —— `describe.skip` + `[GATED — ...]` + baseline 登记这个处置

**判定**：方向对，不构成「掩盖缺陷」；但有一条 MAJOR 残留，且存在**严格更优**的处置。
**严重级别**：处置本身 MINOR；它依赖的 backlog 引用 MAJOR（见新问题 3b）。

**为什么不算掩盖缺陷（三条独立证据）**

1. **被 gate 的测试断言的是正确目标行为，不是旧的错误行为。** 用例名已改成 `commits the terminal error without retrying, and without leaking the block that never closed`——同时钉住「不重试」与「不泄漏半块」两个条件。gate 掉的是一个**尚未达成的目标**，不是一个曾经绿过、现在被调红的守卫。
2. **它守的缺陷确属既有。** 我的 A/B 撤回态实测 = `b8ab9dbb^` 运行时（已证逐字节等价）→ 4 次上游调用。所以「mid-block H2 重试四次」在 b8ab9dbb 之前就存在，gate 它没有隐藏任何本轮引入的回归。
3. **`[GATED — ...]` 确为仓库既有惯用法**，不是临时发明：`tests/routes/messages/postcommit-truncation-shaping.it.test.ts`、`tests/history/v3/store-performance.it.test.ts`、`tests/e2e/handover.e2e.test.ts` 等多处在用；`entry-test-discovery-baseline.json` 里 `whole-suite-skip` 已有 9 条同类登记。新增条目的 `count: 1` 与文件内实际用例数（1 条 `test(`）一致，`bun test tests/infra/test-discovery-matrix.unit.test.ts` → 5 pass / 0 fail。

**更优处置（建议，非缺陷）**：把 `describe.skip` 换成 `test.failing`。

`describe.skip` 的结构性弱点是**它不会自己解除**——Task 4 落地那天没有任何机制提醒有人回来打开它，只能靠 backlog 条目被人读到。`test.failing` 没有这个问题：断言照常执行，失败即视为通过；**一旦行为被修好、测试转绿，bun 立刻把它判红**并打印 `this test is marked as failing but it passed. Remove .failing if tested behavior now works`。我在本仓 bun 1.3.14 上实测确认了这个行为。

附带好处：不再需要 `allowed_skipped` 登记（它不是 skip）。

**这条建议的诚实代价，请一并权衡**：`test.failing` 是**粗粒度 oracle**——它只知道「这个用例没通过」，不知道是因为哪条断言。若将来它因为一个**全新的、无关的**原因而失败，仍然报绿。所以若采纳，用例内应保留当前这种「先断言最有判别力的那条（`upstreamCalls`、`sse` 不含半块）」的顺序，并在 gate 注释里写明它是粗粒度的。另需在切换前实跑一次 `test:backend` 与 discovery 守卫，确认 `test.failing` 在 JUnit 汇总与 `entry-test-discovery-baseline.json` 口径下被计为 pass 而非 skip（我只验了 bun 的控制台行为，**未验 JUnit/baseline 口径**——标为待验证）。

### 新问题 3b —— 注释与 gate 都指向一个**不存在**的 backlog 条目

**判定**：残留。
**严重级别**：MAJOR

**证据**：`grammar.ts` 新注释最后一行写

```
// Until then the mid-block shape stays defective, tracked in docs/todo/deferred-backlog.md.
```

而 `rg -n -i "open unit|open-unit|half block|half-block|mid.?block|acceptTerminal" docs/todo/` **零命中**。`docs/todo/deferred-backlog.md` 里目前没有任何关于这个缺陷的条目。

`[GATED — requires Task 4 owner cutover: ...]` 前缀也只说了「需要什么」，没有指向可追踪的落点。于是整条链上**没有任何一处真正记着这件事**：测试被 skip（不可见）、注释指向一个空引用、backlog 无条目。

**下一个读这段代码的人会做出的错误动作**：他读到「tracked in deferred-backlog」，认为已有人负责、已排期，于是不再深究；等他真去翻 backlog 找不到时，最可能的解读是「大概被做掉了/被合并进别的条目了」，而不是「这条引用是假的」。这比不写引用更坏——一个假的追踪指针会终止后续所有追查。

**修复建议**：在 `docs/todo/deferred-backlog.md` 按该文件既有的五字段体例（根因 / 当前行为 / 理想架构 / 为何暂缓 / 若做需改什么）补一条，内容至少包含：① 现象「mid-block H2 error 被当截断重试四次」；② 已试过并撤回的方案与**实测代价**（半块 + 双终态，附本报告路径）；③ 正解依赖 Task 4 owner cutover 的 `consume(outcome, adapter)` 让排空能丢弃最后一个 commit 边界之后的帧；④ 反指 `grammar.ts` 的 `acceptTerminal` 与被 gate 的那条测试。补完后注释里的引用才成立。

### 新问题 4 —— 既有守卫是否完整

**判定**：完整，未被削弱。
**严重级别**：INFO

**证据**：`bun test tests/pipeline/delivery-grammar.unit.test.ts` → **20 pass / 0 fail**。

逐条核对（`file:line` 按当前文件复验）：

- `tests/pipeline/delivery-grammar.unit.test.ts:85-107`——`maps nested units, identity mismatch, and terminal with an open unit ...`：用 `terminal("terminal")` 构造终态，断言 `[discard-open-unit, protocol-error{terminal-with-open-unit}]`。你之前查到的「用 `semantic: "complete"`」结论**我独立复核无误**（helper `terminal()` 产出的 semantic 为 `complete`），这条在分支生效期走的也是错误分支、当时就是绿的，撤回后语义回到全覆盖。
- `:247-257`——`truncation discards every frame of an open unit without returning a half block`：显式断言 `deliveryFrames(outcomes)` 不含 `opening`/`appending`。**注意这条守的是 finish 路径（`kind: "truncated"`）而不是 frame 路径**，所以它当初**没有**、现在也不会拦住 `acceptTerminal` 的半块泄漏——不要把它当成「半块不上线」的守卫，它的作用域比名字看起来窄。
- `:380-410`——`recognizes every frozen semantic literal in both directions`：`terminal-with-open-unit` 仍在穷尽 Record 与排序断言里，撤回后该 literal 仍有活的产生点，穷尽表没有变成「全填但无人读」。

**另外两条相邻实跑**：`h2-committed-block-delivery.http.test.ts` → 2 pass / 0 fail；`test-discovery-matrix.unit.test.ts` → 5 pass / 0 fail。

## 主观建议

- **[建议] `grammar.ts:67-71` 的新注释** —— 它现在是这个缺陷唯一的活文档，密度很高但**位置很偏**（只有改这段代码的人会读到）。预期影响：Task 4 的执行者大概率从 owner cutover 那侧入手，未必会打开 `grammar.ts`。推荐做法：backlog 条目补上后（新问题 3b），在 Task 4 的 plan/spec 里也留一条反向指针，让「排空必须丢弃最后一个 commit 边界之后的帧」成为 Task 4 的**验收项**，而不是一条只存在于旧代码注释里的期望。
- **[建议] `incomplete` 语义的归属未被记录** —— 撤回后 `complete` / `incomplete` / `failed` 三种语义又全部走同一条 protocol-error 路径，这本身自洽。但 `incomplete` 只由 Responses adapter 在 HTTP（unit 模式）下产生（`adapters/responses.ts:17`、`:77-78`），它同样是**上游的终态决定**（max_output_tokens / 内容过滤），不是协议违规——将来 Task 4 修这条缝时，`incomplete` 会和 `failed` 落进完全相同的形态。预期影响：若只按 `failed` 设计修复，`incomplete` 会在同一个位置再犯一次。推荐做法：在新增的 backlog 条目里把 `incomplete` 与 `failed` 并列写进「若做需改什么」，别只写 `failed`。
