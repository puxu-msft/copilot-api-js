# Envelope 指令文本与收尾产物 Round 2 独立评审

范围：HEAD `4bdbe93a`；只报 blocker／major。仓库仅写入本报告。

## 已核验、未见 blocker／major

- C1：记忆的事后叙述与提交链相符。`git show 30a6d406` 仅清掉 `requestState` 旧称呼；`git show 49c862ad` 明说该扫掠漏了 `env.with()`／immutable 并改 `client.inbound` 与 `RewriteResult`；`git show c2679ff2` 再补 docs/spec/RFC 的 `with`、snapshot、immutable 契约。见 `docs/memory/methodology-sweep-a-concepts-whole-vocabulary-not-one-keyword.md:9-18`。
- C2：旧契约确实存在于 `49c862ad^:src/lib/pipeline/hooks/types.ts:34-35` 与 `49c862ad^:src/lib/pipeline/rewrite-registry.ts:35-38`；现行 `writeAttempt` 原地 `Object.assign` 后返回输入 `env`（`src/lib/pipeline/envelope.ts:240-245`），身份测试在 `tests/openai/openai-cc-codec.it.test.ts:128-139`。
- C3：处置表八项的 hash 与 diff 对得上：`5272af0e` body clone、`182ae415` 四 codec 行为 oracle、`05809c80` post-fork、`25a24f68` migrated 路径、`06bc3535` DESIGN、`30a6d406` 残留称呼、`fdf8e06d` 假体 scope、`935ec9ba` SCC 重冻结；逐项运行 `git show --format= --find-renames <hash>`，映射见 `docs/envelope-scopes/review-dispositions.md:10-19`。
- C4：三份报告的事实性发现分别为契约 1 项、守卫 2 项、扫掠 R2 的 4 项，另有 1 项守卫独立复核确认无需动作，均已在表中处置；扫掠的六项“未覆盖”是明确范围限制而非“留到下一轮”的发现（`docs/envelope-scopes/archive-2026-08-11/round1-review-sweep.md:35-42`）。未发现悄悄跳过的 blocker／major。
- 新记忆不应并入 `feedback-fix-all-comparison-sites`：后者按腿／格式／端点枚举“同一动作的独立入口”（`docs/memory/feedback-fix-all-comparison-sites.md:13-15`），新条按同一概念的多套文字称呼枚举，故分工成立。其中文 frontmatter、正文和 MEMORY 索引钩子均合规，索引行已含“删概念／扫全部称呼／属性名、方法名、形容词、机制名”等足够召回词（`docs/memory/MEMORY.md:102-104`）。

## Major 1：称呼表可被“空类别 + 自认列全”绕过，不能阻止本条要防的遗漏

- `docs/memory/methodology-sweep-a-concepts-whole-vocabulary-not-one-keyword.md:20-24` 只要求列四个类别、逐项报数，却未要求每类写出具体 literal、来源，或对“本类无项”给出检索证据。
- 绕过路径：作者列 `requestState`，把“方法名”“形容词／配套机制”填成抽象类别或自认无项；随后只扫已列项并报告零命中，仍满足“表上每项已扫过”，精确复现这次漏 `with`／immutable／defense-in-depth 的形态。
- 应把动作收紧为：每一类均列出具体称呼及其旧定义／旧契约的 `file:line`；若写“无”，附该类候选检索式与命中审阅结果。然后才允许逐 literal 报数；称呼表不能靠作者一句“我觉得列全了”封口。

## Major 2：环境归因的关键两环不可复核，处置表把未保留的瞬时观测写成已坐实的因果

- `docs/envelope-scopes/review-dispositions.md:27-29（评审当时的行号；该文件其后追加了第三轮，行号已移位）` 可由 git 复核 Rust `generation()` 在 `7a99a254` 添加、TS 同提交引入；当前源码亦在 `native/history-search/src/lib.rs:962` 与 `src/lib/history/search/daemon.ts:359,561`。
- 但 `.node` 被 `.gitignore:13` 忽略，`git ls-tree HEAD native/history-search/copilot_history_search.node` 无记录；当前 `stat` 只能看到重建后的 `2026-08-11 11:47:44`，不能倒推出报告所称旧产物“8 月 6 日 20:08”。
- 同理，报告没有保存“重建前 21 条红”与“执行 `bun run build:history-search` 后该文件 22 pass／0 fail”的原始命令输出；当前产物转绿不证明旧产物过期是该次红的原因。
- 修复前不得将其标为“实测坐实、不是回归”：要么补同一轮的不可变命令输出／日志载体，要么降级为“当时观察到、现无法独立复核”，并明确 C5 的旧 mtime 与重建→转绿因果未被版本库证据支撑。

## 校验

- 已运行：`git rev-parse HEAD` → `4bdbe93a478c4ece6e70b1bb8bc867ed0330a07f`；`git diff --check a560e893^ a560e893` → 退出 0；逐项 `git show`、`git log -S`、`git ls-tree`、`git check-ignore -v` 与 CodeGraph 源码定位如上。
- 未采纳建议：无。