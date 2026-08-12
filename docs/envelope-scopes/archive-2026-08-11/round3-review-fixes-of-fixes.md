# Envelope 第三轮：修复本身的独立评审

评审对象：`3f6fd34c`、`f686d2d6`、`67c84f52`、`55d9d934`；核验基线：`55d9d934d30ee46cf0810136c437b21f0429425a`。结论：**0 blocker、3 major，不能定稿。**

## 验收矩阵

| 条目 | 结论 | 独立证据 |
|---|---|---|
| C1 | 通过 | `tests/pipeline/hedged-driver.it.test.ts:224-242` 在真实 `transport.open` 收到的两个 env 上同时检查 body 与 prepareHints 的身份和写入隔离。隔离 clone 上将 `src/lib/pipeline/driver.ts:708` 改为直接引用后，目标测试 rc=1，准确红于 `:236 not.toBe`；反向 exact patch 恢复后 rc=0。`67c84f52` 的 patch 仅追加 `:234-239`，没有削弱既有 body `:228-232`。 |
| C2 | major | 见 M1。第 1 条本身成立：`src/lib/pipeline/envelope.ts:81-84` 的 request scope 与候选共享，且四 codec 的 `parse` 对原始 payload 做 clone；但本次标注遗漏仍在作为生产契约的同一 spec 内。 |
| C3 | major | 见 M2。待用户裁决的 spec 被注记加入了新的载体论证与结论保留判断。 |
| C4 | major | 见 M3。收紧后的称呼表仍无法外部验证“列出的 literal 已完整覆盖该类别”。 |
| C5 | 通过 | `git log -1 -S'generation()' -- src/lib/history/search/daemon.ts` 返回 `7a99a254`（2026-08-08）；当前 daemon 有两处调用（:359、:561）；`native/history-search/src/lib.rs:962` 导出 `pub async fn generation`；`git check-ignore -v native/history-search/copilot_history_search.node` 命中 `.gitignore:13`。处置表 `:49-65` 如实将其与不可复核 mtime／历史测试输出分开。 |
| C6 | 通过 | 逐个 `git show`：R2-1、R2-2、R2-3 均为 `3f6fd34c` 的 DESIGN／hook 示例／旧 spec 标注；R2-4 为 `67c84f52` 的 hedge 测试；R2-5、R2-6 为 `f686d2d6` 的称呼表与环境证据降级。`55d9d934` 的处置表 `:34-39` 提交号和内容逐项相符。 |

## Major

### M1：生产 hook 规格只改了叙述，没有同步改同一节的示例与 helper 契约

- 违反 C2，且是要求寻找的第三处“正文改了、指向它的内容没改”。`3f6fd34c` 在 `docs/spec/2026-07-12-upstream-hook-middleware.md:155` 宣告可变 live env，却保留 `env.clientFormat`、`env.body`、返回新 env；`:156-162` 继续以旧 accessor 定义三种形状；`:177` 仍承诺 helper “不可变”并返回新 env。
- 这些不是被横幅整体作废的历史机制：`:131-177` 明称“首个生产示例”与“helper 工具箱”，读者会据此写当前可加载 hook；现行字段是 `env.request.clientFormat`、`env.attempt.body`，写入是 `writeAttempt`，见 `src/lib/pipeline/envelope.ts:85-166,238-244`。
- 最小复现：`nl -ba docs/spec/2026-07-12-upstream-hook-middleware.md | sed -n '130,180p'`；生产代码位置已确证，交回 implementer 同步整段示例、三个 accessor 与 helper 返回契约，不能只再加取代句。

### M2：待用户裁决的 server-tool spec 被注记擅自补入新的论证／结论

- 违反 C3。`3f6fd34c` 新增的 `docs/spec/2026-07-26-server-tool-provenance-routing.md:290` 不止描述 `snapshotStableState`／`with()` 前提失效，还断言“per-attempt 事实塞进 per-request 载体是语义倒挂”对新 `request` 仍成立，并据此写“本条结论未被自动推翻”。
- 该断言不是纯前提变更：`src/lib/pipeline/envelope.ts:81-84` 明说 request 是跨候选共享、且可在 S1b 再 refined 的对象，并非注记称的“请求级纯值”；载体是否适合新事实正是待重新取证及用户裁决的实质。
- 最小复现：`nl -ba docs/spec/2026-07-26-server-tool-provenance-routing.md | sed -n '286,292p'` 对照 `nl -ba src/lib/pipeline/envelope.ts | sed -n '80,100p'`。交回 implementer：注记限于已失效的旧前提与“重新推导前不可实施”，删除对新形状结论的保留判断，不能替用户续写论证。

### M3：称呼表新判据仍可用“类别内挑一个 literal”绕过

- 违反 C4。`docs/memory/methodology-sweep-a-concepts-whole-vocabulary-not-one-keyword.md:23-27` 要求每类给出“具体 literal + 旧契约 file:line”，但没有要求列出该类别的全部 literal，也没有独立集合／检索来裁定列举完整性。
- 绕过：方法类只列 `writeAttempt` 及其定义行、逐项扫完，却不列已删除的 `env.with()`；四类都有 literal 与证据，仍满足 `:27` 的“表上每项”，恰好复现本规则要阻止的遗漏。
- 最小复现：按 `:24-27` 制作上述四行表即可通过文字门；无需改生产代码。交回 implementer：每类必须给出从旧契约／旧版本枚举得到的候选集合及逐项处置，或对候选集合的可重跑检索与审阅回执，不能把单个 literal 当类别完备性证据。

## 实跑记录

- 正样本／反样本在隔离 clone `/tmp/copilot-api-js-envelope-c1-11538`（HEAD 同为 `55d9d934`）执行：`bun test tests/pipeline/hedged-driver.it.test.ts --test-name-pattern 'each hedge candidate reaches the transport with its own body object'`。基线 rc=0；将 `prepareHints: structuredClone(env.attempt.prepareHints)` 精确变异为直接引用且先读取生产点确认变异存在后，rc=1、失败于 `:236`；以同一冻结 patch 反向恢复后 rc=0。
- 结构怪味审计：`docs/spec/2026-07-12-upstream-hook-middleware.md:155-177` 是“现行契约与示例双载体漂移”；本轮不改生产／仓库内容，按 M1 交 implementer 收敛为真实 envelope 接口。
