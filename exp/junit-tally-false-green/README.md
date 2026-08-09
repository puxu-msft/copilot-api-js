# 门禁的 tally 曾在一条真失败之上报绿（2026-08-09）

## 它回答什么问题

`scripts/parallel-test.ts` 的汇总行原本从各 shard 的 stdout 解析 `N pass` / `N fail`。本目录保存的是**促使它改为从 JUnit XML 取数的那次运行的原始证据**——因为该论断在提交信息（`e24de3a1`）里被当作事实引用，而产生它的运行日志与产物都在临时目录（`$CLAUDE_JOB_DIR/tmp`、`/tmp/parallel-test-*`），会随会话消失。独立评审在复核时正是因为拿不到这份原件，把 `3337` 这个数标成了「无法核实」。

## 证据

那次 `bun run test:backend` 打印的汇总行，逐字：

```
[parallel-test] 16 shards · 3337 tests · 3337 pass · 0 fail · 7529 executed · 35 skipped · 1 shard(s) crashed (see isolated re-run above) · 132.19s
```

同一次运行写出的 `shard-06.xml` 里躺着这一行：

```xml
<testcase name="CAS live physical bytes are at least 10x smaller than the real compressed V2 write shape"
          classname="History V3 store performance" time="16.29342"
          file="tests/history/v3/store-performance.it.test.ts" line="216" assertions="2">
  <failure type="TimeoutError" />
</testcase>
```

也就是说：**`0 fail` 与一条真实的 `TimeoutError` 同时为真**。成因是 shard 在打印 summary 的过程中死掉，`N fail` 那行永远没落盘，而失败的 testcase 行早已 flush 进 XML——按 stdout 统计的聚合器分不清「没有失败」和「没读到失败」。同一次还把总数少报了一半以上（3337 vs 7529 executed），因为异常终止的 shard 对 stdout tally 贡献 0。

用当时的 16 份 XML 复算，新解析器给出 `executed=7529 / failed=1 / pass=7528`，并点名上面那条用例。

## 它**没有**证明什么

- **没有**证明「stdout tally 历史上那些互不相同的数字（backlog 记的七个值）都由此产生**」。这里只坐实了其中一个成因，且只在「有 shard 异常终止」的运行上成立。那个问题至今未定位——载体换了，不是被诊断出来了。
- **没有**证明退出码曾经失效。退出码取自各 shard 自身，那次运行确实退出 1；坏的只是被交付报告摘走的那一行。
- **没有**证明改用 JUnit 之后计数就完备了。它不完备：一个测试文件在**加载期抛错**时根本不产生任何 JUnit 行，而 bun 照样打印自己的 `N fail`，于是 crash 分支也不触发。该缺口由独立评审实测发现，已在 `0144edcb` 用「tally 行自带 `⚠ INCOMPLETE` 标记」处理——**标记的是不完备，不是把它补全**；真正兜住退出码的仍是既有的 `compareFileIdentities`。
- 原始的 16 份 XML（2.5 MB）**未**收进仓库，只保留了上面那条决定性的行。想要全量请按下面复跑。

## 复跑配方

```bash
bun run test:backend            # 产物目录打印在末行 artifacts=<dir>
# 用当前解析器对任意一批产物复算：
bun -e '
  import { readFileSync } from "node:fs"
  import { parseJUnit } from "./scripts/parallel-test-artifacts"
  const dir = process.argv[1]
  let executed = 0, failed = 0
  for (let i = 1; i <= 16; i++) {
    const id = parseJUnit(readFileSync(`${dir}/shard-${String(i).padStart(2, "0")}.xml`, "utf8"), process.cwd())
    executed += id.executed; failed += id.failed
    for (const f of id.failedIdentities) console.log("FAIL", f.file, "›", f.name, `(${f.type})`)
  }
  console.log({ executed, failed, pass: executed - failed })
' <artifacts-dir>
```

原始运行的完整日志曾在 `$CLAUDE_JOB_DIR/tmp/merge-backend2.log`（1330 行），**已随会话失效**，不要去找。
