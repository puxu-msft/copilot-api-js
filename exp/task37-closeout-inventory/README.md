# Task 37 收尾清单对账（归档件）

## 它回答什么问题

`docs/mandatory-block-delivery-h2-observability/closeout/2026-08-09-evidence-manifest.md` 的分类表声称「合计 427，与冻结清单成员数相等」。这个脚本就是那句话的**产出者**：它读被提交的冻结清单 `docs/mandatory-block-delivery-h2-observability/closeout/2026-08-09-job-tmp-inventory.md`，重算分类计数，并校验清单头部声明的 `# members` 与实际成员行数一致。

归档它的理由很具体：**它原本只存在于 job 的临时目录里**，而那个目录会随 job 过期被回收——一条已经交付出去的证据断言，唯一的产出者却活在会蒸发的地方。

## 结论（实测于 2026-08-10，master `e120a49c`）

```
header `# members`: 427  ==  listed member lines: 427  -> OK
  237  命令输出/门禁日志
   62  JUnit/结构化产物
   53  临时 TS 探针
   52  一次性编辑/整改脚本 (.py)
   10  变异/临时 patch
    7  探针/分析脚本 (.py)
    2  报告草稿
    2  其他
    2  符号链接（指向 node_modules）
  427  == class total
```

**正样本对照**（证明它不是恒绿）：把清单头部的 `# members: 427` 改成 `426` 再喂给它 → `header declares 426 members but the file lists 427 — inventory is inconsistent`，exit=1。

## 它**没有**证明什么

- **没有证明那 427 个对象各自的处置是对的。** 它只做集合层面的计数对账；每一类该保留还是该删，是清单的判断，不是这个脚本的输出。
- **没有证明分类规则是正确的分类。** `classify()` 按文件名后缀和前缀正则归类，是**启发式**：一个名字里带 `fix` 的探针脚本会被归进「一次性编辑/整改脚本」。分类计数只用来让表格可复算，不承载语义判断。
- **末行那个 `427 == class total` 什么都没证明**，它按构造恒真（每个成员恰好落进一类）。真正有鉴别力的是上面那行 header-vs-lines 比较。这一点写在脚本注释里，因为它上一版就是拿这个恒等式当校验的。
- **没有证明清单本身完整。** 清单是 2026-08-10T07:00:20Z 的冻结快照，job 目录此后仍可写；实测到收尾结束时已增至 446。清单头部对此有显式说明。

## 复跑

```bash
python3 exp/task37-closeout-inventory/reconcile-inventory.py
# 或显式指定清单
python3 exp/task37-closeout-inventory/reconcile-inventory.py docs/mandatory-block-delivery-h2-observability/closeout/2026-08-09-job-tmp-inventory.md
```

## 它踩过的三个坑（都在脚本注释里，这里只列索引）

1. 输入指向 `.txt` → 被 `.gitignore` 吞掉、改名后 `FileNotFoundError`，「已对账」的说法不可复现。
2. 用 `sum(counter) == len(members)` 当校验 → 同源恒等式，按构造恒真。
3. 清单路径写死进一棵**后来被收尾删掉的 worktree** → 归档时才发现，它以与坑 1 完全相同的方式再次失效。现在按脚本自身位置解析。
