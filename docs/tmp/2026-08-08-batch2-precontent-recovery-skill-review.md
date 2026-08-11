# anthropic-precontent-recovery skill 独立评审

## 评审范围

- `/home/xp/src/copilot-api-js/.claude/skills/anthropic-precontent-recovery/SKILL.md`
- `/home/xp/src/copilot-api-js/.claude/skills/anthropic-precontent-recovery/verification-log.md`
- C1–C10、易变状态残留、可绕过措辞、判据可执行性、离线验收的外推边界，以及三个相邻 skill 的改动与触发边界。

## 已读取／执行的证据

- 读取上述两份评审对象、三个相邻 skill 的 `git status`／`git diff`、所引 source/docs/plan/exp 及关键测试。
- 用 CodeGraph 与最终源码核对 gate、semantic delivery flag、server-tool gate、两个 recovery 入口、evaluator 九种 kind、disposition、C9、continuation 约束和 handler 挂载点。
- 关键命令：`git status --short -- <四个 skill 目录>`、`git diff --numstat -- <三个相邻 SKILL.md>`、`git diff --check -- <本轮 instruction 文件>`、针对符号与引用的 `rg -n`；未修改仓库评审对象，未运行行为测试。

## 总体 verdict

**存在 blocker，不可定稿。** blocker：1。major：2。

C1–C10 严重度口径：C1、C2、C3、C4、C5、C6、C8、C9 未发现 blocker／major；C7 有 1 major；C10 有 1 blocker。六条“常见误判”和六条“验收怎么做才算数”除下述 live-efficacy 门外，未发现 blocker／major 级不可执行项；未发现 blocker／major 级易变默认值、落地状态或测试计数残留。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/.claude/skills/debugging-claude-client-connection/SKILL.md:2,68-101` — C10 的“相邻 skill 全文未被本轮改动”当前无法成立 — `git status` 显示该文件为 `M`，`git diff --numstat` 为 `23 9`，正文与 frontmatter 均有未提交改动；另两个相邻 skill 无 diff。没有派发前 baseline，无法把这些 hunk 归属给本 batch 或并发会话，但当前工作树不能证明边界完整性。定稿前由 `gpt-souls:instruction-smith` 路由方隔离／处置该改动并重新取证，禁止用整文件 restore 猜归属。

[major] `/home/xp/src/copilot-api-js/.claude/skills/anthropic-precontent-recovery/SKILL.md:86-90` — `ping` 行把“无需 anchor/remap”写成“什么都不用做”，漏掉 ready-live 下的 duplicate `message_start` dedup — `/home/xp/src/copilot-api-js/src/lib/anthropic/live-reconcile.ts:160-166` 明确在无 anchor hooks 的 `ping` 路径保留首个 `message_start`、丢弃 recovery 的重复 start；`/home/xp/src/copilot-api-js/tests/routes/messages/precontent-recovery-matrix.it.test.ts:1012-1037` 正是 primary 已先发 start 的回归。`FINDINGS.md:19` 只证明“fresh start 是客户端首 start”的较窄 ping 场景。将表改为“无 anchor close／index remap；若 primary 已发真实 message_start，仍须 dedup recovery start”。

[major] `/home/xp/src/copilot-api-js/.claude/skills/anthropic-precontent-recovery/SKILL.md:108-117,128-137` — “真实上游实测证据”不是可判别的 live-efficacy 门，正常成功的真实 GHC 请求也能被合理化为满足它 — 当前文字没有要求观测 primary 在 post-commit/pre-content 窗口确定性死亡、fresh dispatch 实际发生、以及该 dispatch 产生客户端完整终态；`verification-log.md:22` 也承认 V4 写作时已知可被绕过。把 V4／验收门写成必要观测链，并明确“只打到真实 GHC但未命中 B2 seam”仍只证明普通请求成功，不证明可救回；同时保留离线故障矩阵作为机制层证据。

## 主观建议

无 blocker／major 级主观建议。

## 复评轮

### 复评 verdict

**修复 major 后可定稿。** blocker：0。major：2。

C10 blocker 已关闭：`git --no-optional-locks status --short --` 针对三个相邻 skill 目录无输出；当前工作树可证明这三个邻域均无未提交改动。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/anthropic-precontent-recovery/SKILL.md:87,93-97` — M1 的推广过头，内部自相矛盾 — `live-reconcile.ts:98-101,111-117` 是“已有 start 才丢重复，否则让首个 start 通过”，只有 `:121-123` 因 synthetic start 已注入而无条件丢；`FINDINGS.md:19` 的 pre-ready `ping` 正需要 recovery start 成为客户端首 start。把通用规则改为“客户端至多一个 start；若此前已转发 start，丢 recovery duplicate”，不要写“recovery 自己那个一律丢弃”。

[major] `/home/xp/src/copilot-api-js/.claude/skills/anthropic-precontent-recovery/SKILL.md:124-131` — M2 四环链仍留有不可归属的旁路 — 第 2 环允许用全局计数器增量证明 fresh dispatch，第 4 环却要求证据与同一 request/entry id 串联；全局 counter 不带 request identity，无法排除增量来自并发请求。删掉 counter 作为单独替代证据，或要求它与该 request 的具名 attempt／trace 事件共同关联；四环必须使用可按 request id 归属的证据。

## 第三轮复评

### 复评 verdict

**可以定稿。** blocker：0。major：0。

M1 已闭合：`live-reconcile.ts:98-101,111-117` 与新文的条件放行／条件丢弃逐字一致，`:121-123` 对已注入 synthetic start 无条件丢弃；`FINDINGS.md:19` 支持无既有 start 时放行 recovery start。`pre-ready + ping` 被准确标为“典型”而非唯一组合；其他尚未转发 start 的组合也由同一状态判据覆盖。

M2 已闭合：fresh dispatch 证据限定为可按 request／entry id 归属的 attempt 或 trace／日志；全局计数器明确降为不可填环的旁证。第 4 环反向约束前三环，primary 死亡、fresh dispatch、客户端完整终态均必须串到同一 request，未发现可用无 identity 证据合理化通过的口子。

### 事实性发现

未发现 blocker 或 major。
