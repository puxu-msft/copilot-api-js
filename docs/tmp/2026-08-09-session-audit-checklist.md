# 本会话全面审核清单（2026-08-09）

> **怎么用**：A 段是**待你裁决**的开放问题；B 段是**已落地**的东西（每条给可复跑的核对命令，别信描述）；C 段是**剩余工作**；D 段是**我知道自己没验证的**；E 段划清**哪些不是本会话的产物**——同一目录下有大量同伴会话的文件，不分清会审错对象。
>
> **所有提交都在本地，未推送。**
>
> 数字一律不写死。核对状态请跑：
> ```bash
> git -C ~/.claude --no-optional-locks log --oneline -20
> git -C /home/xp/src/copilot-api-js --no-optional-locks log --oneline -20
> ```

---

## A · 待你裁决（按重要性排）

### A1 · 剩余约 15 组：本会话继续，还是交接新会话？

**我的建议：交接。** 理由不是工作量，是**本轮归属判断的错误率，且四次纠正没有一次是我自查出来的**：

| 错误 | 谁纠正的 |
|---|---|
| 照抄 agent 的「家」映射未复核（第二处扶正归属判错） | 用户提问后我自查 |
| 把两条机制不同的规则合成一组（`check-dependency-contract` × `batching`） | 第三方裁决判死 |
| 为迁就错误归属而扩 `authoring-skills` 的 description | **用户叫停** |
| 五条「留（不拆）」拿「短」当理由 | 独立评审判 major |

这些是**判断漂移**，不是知识缺失；同一上下文里再想一遍修不好，换上下文有效。

### A2 · 记忆索引没有余量了

`docs/memory/MEMORY.md` 现在贴着上限（跑 B5 的命令看当前值）。本轮为了加一行指针，连续压了四五次别的条目，最后靠删掉一条**真重复**才回到限内。**此后每加一条都会溢出，而溢出是静默的。**

三个选项：

1. **继续按需挤**——每次加条目顺手合并一条。省事，但每次都在磨触发词。
2. **再拆一段出去**（如「已下沉到项目 skill」那批）——立刻腾出空间，但那些钩子的作用正是「skill 没浮现时的兜底」，与「召回宁滥勿缺」冲突。
3. **做一轮同域合并整理**——唯一不牺牲召回面的，但要单独一轮，且合并本身会丢覆盖面、需逐条对账。

**我倾向 3。**

### A3 · 一处我与评审有分歧，需要你裁

评审判「五条『留（不拆）』全部不成立、都该下沉」。四条我接受。**`anchor-numbers-to-commits` 我仍认为该留 rules**——它是纯不变量、没有可下沉的长尾，拆开只会多一个指针。

评审的理由：后果只是「文档数字陈旧」＝返工级。我的理由：**它没有可下沉的内容，拆分的对象不存在**。两条都成立，指向不同动作。

### A4 · 任务列表陈旧

会话内的任务项 #19–#25 是更早那批工作的（批 1–批 6），**早已完成**，现在显示为 in_progress/pending 是陈旧状态。要我清掉并按 v2 清单重建吗？

---

## B · 已落地（逐条给核对命令）

### B1 · 三份新 user-level skill

```bash
ls -d ~/.claude/skills/{authoring-skills,making-a-gate-actually-fire,editing-files-precisely}
head -4 ~/.claude/skills/making-a-gate-actually-fire/SKILL.md
head -4 ~/.claude/skills/editing-files-precisely/SKILL.md
```

| skill | 管什么 | 评审 |
|---|---|---|
| `authoring-skills` | 写 skill 本身：文本为主、归属判据、slug、description 按意图、重写必丢覆盖面 | 与同伴合著；多轮 |
| `making-a-gate-actually-fire` | 门写了但没人执行：九形态 + 四问 + 工具调用控制流 | J1–J5 + 复评，0 blocker |
| `editing-files-precisely` | 这一刀准不准、落盘没有：下刀/检查/批量/落盘/改完之后 | K1–K5 + 两轮复评，blocker 已闭合 |

**每份都有 `verification-log.md`**，里面登记了**未经实测的判断**——这是最该你抽查的部分：

```bash
sed -n '/^## B2/,/^## B3/p' ~/.claude/skills/making-a-gate-actually-fire/verification-log.md
sed -n '/^## E4/,/^## 已毕业/p' ~/.claude/skills/editing-files-precisely/verification-log.md
```

### B2 · 三条 always-on 规则被压缩（不变量保留、手法下沉）

```bash
cd ~/.claude/rules/agents
rg -n 'mutation-baseline|batching-can-silently|replacement-must-cover|anchor-numbers-to-commits' .
```

- `mutation-baseline-must-contain-the-real-impl` → 手法进 `positive-control-your-tests`
- `batching-can-silently-remove-a-gate` → 手法进 `making-a-gate-actually-fire`
- `replacement-must-cover-what-it-restates` → 手法进 `editing-files-precisely`
- `anchor-numbers-to-commits` → **收紧**为「默认只给能重算的命令、不写值」

**三条压缩里最该复核的是它们各自留下的那句不变量能不能独立拦住人**——本轮有两条第一版就写漏了（黑名单代替白名单、单向白名单代替双向），都是评审抓的。

### B3 · 指针没有断链

```bash
cd ~/.claude/rules/agents
rg -n '^\s*- \*\*(scoped-invariant-written-as-global|fix-at-the-shared-base-not-where-you-noticed|check-dependency-contract-against-your-invariant|new-checks-must-not-alter-existing-contracts|packaging-can-void-another-invariant)\*\*' .
```
应命中 5 条。**本轮曾因规则压缩打断过一次下游引用**（某 skill 的四处 `file:line` 同时漂移约 8 行，通读看不出异常），那处已改成按 slug 检索。

### B4 · 两份记忆改成 stub、索引改指

```bash
head -12 /home/xp/src/copilot-api-js/docs/memory/methodology-gates-i-write-fail-at-the-execution-seam.md
head -12 /home/xp/src/copilot-api-js/docs/memory/methodology-edit-then-verify-then-commit-never-one-call.md
```
两份都应只剩「触发钩子 + 本仓专有实例」，方法指向对应 skill，并**分别写明权威边界**（规则拥有最低约束、skill 拥有形态与实证）。

### B5 · 记忆索引在限内

```bash
python3 -c "import io;s=io.open('/home/xp/src/copilot-api-js/docs/memory/MEMORY.md',encoding='utf-8').read();print(round(len(s)/1024,2),'KB / 上限 17.1')"
```

### B6 · 同伴的未提交改动没被卷进我的任何提交

```bash
git -C ~/.claude --no-optional-locks status --short
git -C /home/xp/src/copilot-api-js --no-optional-locks status --short
```
`rules/agents/62-docs-and-handover.md` 上有同伴一处未提交 hunk（`moving-shared-head-is-not-failure` 那句），本轮全程用 `-U0` 过滤避开；提交后复核过它仍在工作区。

---

## C · 剩余工作

**权威计划**：`docs/tmp/2026-08-09-rules-62-63-64-split-ledger-v2.md`（**顶部有执行期修订节，优先于正文**）。

- 剩余约 15 组尚未下沉，每组走「拆 → 双向逐条对账 → 独立评审 → 提交」，**一次一组**。
- 唯一确认无家、需真正新建的：**「散落状态收进一个对象」的五坑**。
- 交接件尚未写（等 A1 的裁决）。

---

## D · 我知道自己没验证的

**D1 · 所有「召回」判断都是反事实推理。** 无真实 selector 日志、无多读者盲测；第三方裁决自己把这写成「最弱一环」。这些判断**判得掉明显错的分组，判不出两个都合理的哪个更好**。

**D2 · 三份新 skill 是否真会在该触发时浮现，本会话验不了**——skill 注册要新的 CLI 进程。

**D3 · 我对 `MEMORY.md` 做过一次整文件重写**（压缩全部钩子）。链接目标集合有机械核对、零丢失；但**挡不住同伴在窗口内改过某条钩子措辞被我覆盖**。若发现某条钩子回退了，成因在这里。

**D4 · 本会话我自己犯了四次同一族错**：把判据挂在过滤器/计数器/通配符的退出码上（`grep -c` 命中 0 返回 1、`ls` 无匹配 glob 返回非零），一个**正确**结果把后续命令短路。已写进规则与 skill，但那是「写下来了」，不是「不犯了」。

---

## E · 这些**不是**本会话的产物

`docs/tmp/2026-08-09-*` 下有大量同伴会话的文件（`task37-*`、`batch2b-*`、`history-worker-*`、`merge-state-*`、`a4-batch1-*`、`wrapup-artifacts-*`、`codex-*` 等）。**本会话产出的只有这九份**：

```
2026-08-09-authoring-skills-and-anchor-numbers-review.md
2026-08-09-rules-62-63-64-split-ledger.md          (v1，已被 v2 取代)
2026-08-09-rules-62-63-64-split-ledger-v2.md       (权威计划)
2026-08-09-split-ledger-review.md
2026-08-09-question-axis-grouping-independent.md
2026-08-09-question-axis-grouping-attack.md
2026-08-09-grouping-conflict-arbitration.md
2026-08-09-gate-skill-promotion-review.md
2026-08-09-editing-skill-promotion-review.md
```

两个仓库的提交历史里同样交错着同伴的提交（全局侧尤其多）。要只看我的，按上面 B 段各条的文件路径去查该文件的提交即可。
