# 门禁的 tally 曾在一条真失败之上报绿（2026-08-09）

## 它回答什么问题

`scripts/parallel-test.ts` 的汇总行原本从各 shard 的 stdout 解析 `N pass` / `N fail`。本目录保存的是**促使它改为从 JUnit XML 取数的那次运行的机器生成产物**——因为该论断在提交信息（`e24de3a1`）里被当作事实引用，而产生它的运行日志与产物原本只在临时目录（`$CLAUDE_JOB_DIR/tmp`、`/tmp/parallel-test-*`），会随会话消失。

> **本节的第一版只保存了人工转录的两行，并自称「原始证据」。** 独立评审指出：那样一来，仓库里能确认的只是「作者在多个载体重复了同一说法」，而不是可独立审计的 primary evidence——恰好重犯本目录要防的那个错误。现已收入原件（见下）。**注意范围**：能从本目录原件复算的只有 shard-06 那一份的计数与那条失败行；全量的 `7529 executed` 需要全部 16 份 XML，本目录**没有**，只能重跑。

## 原件（机器生成，未经编辑）

| 文件 | 是什么 | sha256 |
|---|---|---|
| `artifacts/run.log` | 那次 `bun run test:backend` 的完整 stdout+stderr（1330 行，含 ANSI） | `8cd82fae2ef5f5160920c9d587e7ebb73126da293effcf9904d8b94a82ac4773` |
| `artifacts/shard-06.xml` | 同一次运行里 shard-06 的 JUnit 产物 | `101d99a32862ecb29cad62b608ac9c1cc46e0a36361987b3f825b2d609db7bdf` |

采集环境：Linux 6.18 (WSL2)、16 CPU、bun 1.3.14 (0d9b296a)、仓库 HEAD 为合并后未提交状态（该次运行即用于判定合并能否成立）。**只保留了 shard-06 一份 XML**——它是唯一含失败行的那份；其余 15 份未收（共 2.5 MB）。因此本目录可复算 shard-06 的计数，但**不能**用它复算全量的 `7529 executed`，那个数需要全部 16 份。

## 从原件读出什么

`run.log` 末尾的汇总行：

```
[parallel-test] 16 shards · 3337 tests · 3337 pass · 0 fail · 7529 executed · 35 skipped · 1 shard(s) crashed (see isolated re-run above) · 132.19s
```

`shard-06.xml` 里的这一行：

```xml
<testcase name="CAS live physical bytes are at least 10x smaller than the real compressed V2 write shape"
          classname="History V3 store performance" time="16.29342"
          file="tests/history/v3/store-performance.it.test.ts" line="216" assertions="2">
  <failure type="TimeoutError" />
</testcase>
```

也就是说：**`0 fail` 与一条真实的 `TimeoutError` 同时为真**。成因是 shard 在打印 summary 的过程中死掉，`N fail` 那行永远没落盘，而失败的 testcase 行早已 flush 进 XML——按 stdout 统计的聚合器分不清「没有失败」和「没读到失败」。同一次还把总数少报了一半以上（3337 vs 7529 executed），因为异常终止的 shard 对 stdout tally 贡献 0。

## 它**没有**证明什么

- **没有**证明「stdout tally 历史上那些互不相同的数字（backlog 记的七个值）都由此产生」。这里只坐实了其中一个成因，且只在「有 shard 异常终止」的运行上成立。那个问题至今未定位——载体换了，不是被诊断出来了。
- **没有**证明退出码曾经失效。退出码取自各 shard 自身，那次运行确实退出 1；坏的只是被交付报告摘走的那一行。
- **没有**证明改用 JUnit 之后计数就完备了。它不完备：一个测试文件在**加载期抛错**时根本不产生任何 JUnit 行，而 bun 照样打印自己的 `N fail`，于是 crash 分支也不触发。**该论断已被两位独立评审各自实测确认**（bun 1.3.14：summary `1 pass / 1 fail / 1 error / Ran 2 tests across 2 files`，而 XML 根节点是 `tests="1" failures="0"` 且完全不含抛错的那个文件）。已在 `0144edcb` 用「tally 行自带 `⚠ INCOMPLETE` 标记」处理——**标记的是不完备，不是把它补全**；真正兜住退出码的仍是既有的 `compareFileIdentities`。
- **没有**证明 `7529` 这个全量数——如上，仓库里只有 1/16 的 XML。要复现它需要重跑。

## 复跑配方

```bash
bun run test:backend            # 产物目录打印在末行 artifacts=<dir>
```

用当前解析器对任意一批产物复算。**shard 数由 `os.cpus().length` 决定，不是常数 16**，所以从目录枚举而不是数到 16；并且**断言编号连续**——缺一份 XML 时静默把子集当成完整批次，正是本目录要防的那个错误的翻版：

```bash
bun -e '
  import { readdirSync, readFileSync } from "node:fs"
  import path from "node:path"
  import { parseJUnit } from "./scripts/parallel-test-artifacts"
  const dir = process.argv[1]
  const names = readdirSync(dir).filter((n) => /^shard-\d+\.xml$/.test(n))
  const numbers = names.map((n) => Number(/^shard-(\d+)\.xml$/.exec(n)[1])).sort((a, b) => a - b)
  if (numbers.length === 0) throw new Error(`no shard-*.xml under ${dir}`)
  for (const [index, value] of numbers.entries()) {
    if (value !== index + 1) throw new Error(`shard numbering is not contiguous from 1: got ${numbers.join(",")} — this batch is a SUBSET, its counts are not a total`)
  }
  let executed = 0, failed = 0
  for (const value of numbers) {
    const name = `shard-${String(value).padStart(2, "0")}.xml`
    const id = parseJUnit(readFileSync(path.join(dir, name), "utf8"), process.cwd())
    executed += id.executed; failed += id.failed
    for (const f of id.failedIdentities) console.log("FAIL", f.file, "›", f.name, `(${f.type})`)
  }
  console.log({ shards: numbers.length, executed, failed, pass: executed - failed })
' <artifacts-dir>
```

**对本目录保存的那一份复算会故意失败**——它只有 `shard-06.xml`，编号不从 1 开始连续，脚本会抛 `this batch is a SUBSET`。这是设计如此：想单看那一份，直接读 `artifacts/shard-06.xml` 里的 `<failure type="TimeoutError" />` 行，或对单文件调用 `parseJUnit`，**但不要把它的计数当作那次运行的总量**。
