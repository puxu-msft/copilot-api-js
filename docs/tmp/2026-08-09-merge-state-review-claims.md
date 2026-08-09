# 合并态评审：判据证伪报告（2026-08-09）

评审者视角：判据证伪。HEAD = `b9b5895b1a906a374eef8639866291016b71aea2`，评审开始时工作树干净。
被审四提交：`ca5f4cf7`（merge）、`a0c82cc3`、`e24de3a1`、`b9b5895b`。

---

## C1 — `test:backend` 通过且 tally 为 7532/7532/0 —— **成立**

命令（自己跑的，未采信派活方引用的数字）：
```
bun run test:backend
```
输出末尾：
```
[parallel-test] 16 shards · 7532 tests · 7532 pass · 0 fail · 7532 executed · 35 skipped · 113.90s
[parallel-test] artifacts=/tmp/parallel-test-bmHFw1
EXIT_CODE=0
```
与断言逐字一致：7532 tests / 7532 pass / 0 fail / 7532 executed / 35 skipped，无 `shard(s) crashed` 标记，退出码 0。

### 追加问：`executed` 与 `pass + fail` 现在同源吗？

**同源，且代数上不可能不一致。** `scripts/parallel-test.ts:235` 是 `const passSum = executed - failSum`——pass 是从 executed 派生的，不是独立计数。
因此 `pass + fail === executed` 是恒等式，不是巧合。tally 行里 `${executed} tests` 与 `${executed} executed`（第 241-242 行）也是同一个变量打印两次。
这正是提交信息所称的「derives pass as executed - failed so the two can never disagree」，属实。

**但同源也意味着：若 `executed` 本身漏计，`pass` 会跟着漏计而两者仍然自洽。** 自洽性在这里没有检错能力——见 C2。

---

## C2 — parseJUnit 统计 `<failure>`/`<error>`，tally 取自 junit —— **断言本身成立，但其宣称达成的目标未闭合**

### 成立的部分（先证实）

`scripts/parallel-test.ts:233-235` 确实从 junit 取数：`failSum` 来自 `identity.failed`，`passSum = executed - failSum`，`failSum` 进了退出条件（第 245 行）。
`scripts/parallel-test-artifacts.ts:127-135` 确实同时处理 `failure` 与 `error`。

对提交信息引用的那次真实运行产物 `/tmp/parallel-test-VZxJ3f/`（**仍在磁盘上，未被清理**）复算：
```
bun <脚本> /tmp/parallel-test-VZxJ3f
-> executed=7529 skipped=35 failed=1 pass=7528 files=727
-> failedIdentities: tests/history/v3/store-performance.it.test.ts ›
   "CAS live physical bytes are at least 10x smaller ..." (TimeoutError)
```
与提交信息的「7529 executed / 1 failed / 7528 pass, naming the timed-out test」**逐字吻合**。这条证据是真的。

### 鉴别力检验：我自己构造的 11 种 XML 形态

直接调用 `parseJUnit`，逐形态观察计数（脚本 `/home/xp/.claude/jobs/a7c2cc1a/tmp/adversarial.ts`）：

| 形态 | 结果 | 判定 |
|---|---|---|
| A. 同一 testcase 下两个 `<failure>` | failed=1 | 正确，`??=` 防了重复计数 |
| C. 嵌套 `testsuite` | failed=1 | 正确 |
| D. `<error>` 无 `type` 属性 | failed=1, type="error" | 正确，回退到标签名 |
| E. 自闭合 `<failure/>` | failed=1, type="failure" | 正确 |
| F. 命名空间前缀 `<j:failure>`（已声明） | failed=1 | 正确，按 `local` 名匹配 |
| B. `<failure>` 与 `<skipped>` 同在一个 testcase | skipped=1, **failed=0** | 见下 |
| G. 失败的 testcase 缺 `classname` | **executed=0, failed=0** | **失败被静默吞掉** |
| H. 失败的 testcase 缺 `file` | **executed=0, failed=0** | **失败被静默吞掉** |
| I. `<error>` 直接挂在 `<testsuite>` 下 | **failed=0** | **失败被静默吞掉** |
| J. `testsuite` 只有 `failures="1"` 属性、无 row | **failed=0** | 属性从不被读 |

前 6 种（A/C/D/E/F 及既有用例）计数正确、无重复无遗漏。B 的取舍（skipped 压过 failure）在 bun 实际输出里不会出现，仅记录。

### 反向：真实会出现、而新解析器仍然看不见的失败形态（**实测，非推理**）

这是本条最有价值的方向，我用真实 `bun test` 造了三个探针（`/home/xp/.claude/jobs/a7c2cc1a/tmp/scratch/`）。

**探针 1 —— 文件加载期抛错（top-level throw）。** 一个 shard 跑三个文件：正常文件（1 pass + 1 fail）、加载期抛错文件、延迟异步抛错文件。
bun 自己的 stdout：`1 pass · 2 fail · 2 errors · Ran 3 tests across 3 files`，退出码 1。
而它写出的 XML **只含那个正常文件**：
```xml
<testsuites name="bun test" tests="2" assertions="2" failures="1" skipped="0">
  <testsuite name="ok.unit.test.ts" file="ok.unit.test.ts" tests="2" failures="1">
    <testcase name="passes" .../>
    <testcase name="fails" ...><failure type="AssertionError" /></testcase>
  </testsuite>
</testsuites>
```
另外两个文件**完全没有痕迹**——没有 `testsuite`、没有 `testcase`、也没有 `<error>` 元素。
`parseJUnit` 对它得到 `executed=2, failed=1`，而 bun 看到的是 3 tests / 2 fail。

**探针 2 —— 延迟异步抛错**（tests 之后 `setTimeout` 里抛）：bun 报 `0 pass · 0 fail · 1 error`，退出码 1，且**根本不写 XML 文件**。

**探针 3 —— `afterAll` 抛错**：这一类**是**被覆盖的，bun 会产出 `<testcase name="(unnamed)"><failure type="AssertionError" /></testcase>`，parseJUnit 正确记为 failed=1。（这条是证实，不是证伪。）

### 那么「实现坏掉但判据全绿」的场景造出来了吗？——造出来了一半，另一半被一道**既有**闸门挡住

把探针 1 的 XML 喂给完整口径（`parseJUnit` + `compareFileIdentities`）：
```
parsed: {"executed":2,"failed":1,"files":["ok.unit.test.ts"]}
compare: {"missing":["boom.unit.test.ts","late.unit.test.ts"],"unexpected":[]}
```
`compareFileIdentities` 抓到了两个消失的文件 → `parallel-test.ts:213-216` 打印 `missing runtime file identity`，第 245 行退出 1。
**所以退出码是 fail-closed 的，不会静默放行一次坏构建。** 这一点必须讲清楚，否则会高估严重度。

**但没闭合的恰恰是这次提交要修的那个东西：被引用进交付报告的那一行 tally。**
在上述场景里 tally 行会打印 `... · 2 tests · 1 pass · 1 fail · 2 executed ...`：
- `failed` 少算（1 vs bun 的 2）、`executed` 少算（2 vs 3）；
- `crashed` 标记**不会**出现——第 186 行的判据是 `code !== 0 && !/\\d+ fail\\b/.test(r.err)`，而 bun 明明打印了 `2 fail`，所以这一行被认定「不是 crash」，tally 行末尾不会加 `shard(s) crashed`；
- tally 是最后打印的，读者/agent 最容易直接摘走的就是它。

提交信息说旧口径「under-counted the suite by more than half (3337 vs 7529 executed), because every crashed or truncated shard silently contributed nothing」。
换成 junit 之后，**「整个 shard 静默贡献 0」被堵住了（缺 XML → 退出 1；截断 XML → `parseJUnit` 抛错、未捕获 → 非零退出），但「单个文件静默贡献 0」没有**：只要该 shard 的其余文件仍写出合法 XML，那个文件的失败与用例数就从 tally 里蒸发，且只由 file-identity 那道**既有**闸门兜底。

**严重度：MAJOR（限于 tally 行的可信度，不涉及放行坏构建）。**
接手方会因此做出的错误动作：把 tally 行原样抄进交付报告 / HANDOVER，声称「N pass · 0 fail」，而实际存在加载期失败的文件——这与触发本次修复的 `3337 vs 7529` 是同一族错误，只是规模变小。

**修复建议（不要求本轮做）**：tally 与 file-identity 检查共用一个「本次口径是否完整」的标志位——`fileComparison.missing.length > 0` 时，tally 行必须自带类似 `⚠ N file(s) produced no JUnit rows` 的标记，而不是把警告留在上面几行、让最显眼的最后一行照旧报绿。

---

## C3 — CAS 字节比 guard 超时 15s→120s 是否掩盖真问题 —— **处置正确**（附一条既有判据鉴别力的 MINOR）

这是「放宽既有 guard」，按项目纪律不由实施者自判，以下是裁决依据。

### 方向 1：是不是实现退化？——**否，未发现退化证据**

`git diff 05fd7c3d..HEAD -- tests/history/v3/store-performance.it.test.ts` 中 grep `maxTurns|length: 48|8_192|768|deterministicNoise` **零命中**：CAS 用例的 fixture 规模自计时缓存刷新以来未变。

实测当前字节数（`bun test ... -t "CAS live physical bytes"`）：
```
HISTORY_V3_PERF cas-bytes {"operations":48,"v2Bytes":283022247,"pageDelta":2580480,
 "liveBytes":1294688,"physicalRatio":109.678,"liveRatio":218.603}
```
与提交信息自称的「109x physical / 218x live」**逐位吻合**。
**这是判「有无实现退化」最直接的量**：若有人把 v2Bytes 或 pageDelta 的规模改大，比值必然移动；它没有移动。故 CAS/manifest/压缩路径在该测度上未退化。

耗时侧实测（隔离跑，两次）：CAS 用例 7.45s / 8.40s，整文件 wall 10.25s / 12.01s。提交信息称「~9s isolated」，落在实测区间内，属实；
「16.29s inside a 16-way sharded run」与 15s 预算的 1.3s 差额也因此可信。

**一处未解释的残差（不构成证伪，但值得记）**：`scripts/test-timings.json` 给该文件的缓存值是 `5.818051`，而当前逐用例 `time` 之和为 9.51s。
缓存最后刷新于 `05fd7c3d`（2026-08-07），其后 `2b2c1d43`（08-08）往该文件加了一条用例——但那条实测仅 0.088s，补不平 3.7s 的差。
余下差额可能是运行方差或提交路径上不改变字节的 CPU 工作，**我没能把它归因到具体 commit**，标为未核实。
它的实际后果是 LPT 分片把这个文件按 5.8s 估重、实为 9.5s，该 shard 因此偏长——这正是把用例推过 15s 的调度噪声来源之一。

### 方向 2：dedup 真坏掉时这条判据还会红吗？——**会红，实测确认；但边际很薄**

不看注释怎么写，直接做正负对照。在 `/home/xp/.claude/jobs/a7c2cc1a/tmp/scratch/`（**未改工作树任何文件**）建了树外 harness：
按仓库 `tsconfig.json` 的 36 条 paths 生成 scratch tsconfig + 复刻 `bunfig.toml` 的三个 preload。

**正对照（先做，否则红了也分不清是不是 harness 假象）**——原样副本树外跑：
```
physicalRatio: 109.67814050, liveRatio: 218.564 -> 1 pass
```
与仓库内数值一致，harness 已标定。

**负对照**——只改一处，让 48 条 operation 的消息内容各自唯一（形状与大小不变），以此消灭跨 record 的内容寻址复用：
```
messages: sharedMessages.slice(0, turns)
  -> sharedMessages.slice(0, turns).map((m) => ({ ...m, content: m.content + "-uniq-" + index }))
```
```
HISTORY_V3_PERF cas-bytes {"v2Bytes":283291597,"pageDelta":29786112,"liveBytes":26245717,
 "physicalRatio":9.5108,"liveRatio":10.7938}
Expected: >= 10   Received: 9.510861874151283   -> 1 fail
```

**结论：oracle 确实是字节比而非时间，超时放宽没有让它失去裁决力**——dedup 失效时 `physicalRatio` 断言仍然咬住并变红。C3 断言成立，处置正确。

### 但由此暴露一条既有判据的鉴别力问题（MINOR，非本次提交引入）

上面这组数字同时说明：
- **`liveRatio >= 10` 在这个失效模式下几乎没有鉴别力**——dedup 被完全消灭后它仍是 10.79，**照样通过**。
- **`physicalRatio >= 10` 只以 5% 的余量咬住**（9.51 vs 10）——而这还是 dedup **完全**失效的极端。

推论出的「实现坏掉但判据全绿」场景（这是我被要求主动构造的那一条，已构造成功）：
**任何部分性的 dedup 退化**（例如只丢失一半跨 record 复用）会让 `physicalRatio` 落在 10 与 109 之间，**两条断言都绿**，而 CAS 的核心价值已经损失大半。
判据在 109x 的实际水平上设 10x 的门，留了约 11 倍的沉默区间。

严重度 **MINOR**：不阻断本次合并，阈值早于本次提交存在，a0c82cc3 没有让它变差。
接手方可能因此做出的错误动作：把这条用例当成「CAS 去重的回归防线」，而它实际只能拦住去重**彻底**失效。
建议（不要求本轮做）：把门按实测水平上移（例如 `physicalRatio >= 60`）或改成对基线的相对比值，并把 `liveRatio` 的阈值与 `physicalRatio` 分开定，别让一个恒真断言充数。

---

# 第二轮：C4 / C5 / C6（在当前 HEAD `53ae4903` 上重新取值，未沿用早先观测）

## C4 — 发现基线自洽 —— **成立**

`runner_git_blob` 三处一致（工作区 blob = 已提交 blob = 基线记录值）：
```
git hash-object scripts/parallel-test.ts   -> e077439eacb8f24f64fd35ba5f67e22e34c6564f
git rev-parse HEAD:scripts/parallel-test.ts -> e077439eacb8f24f64fd35ba5f67e22e34c6564f
baseline runner_git_blob                    -> e077439eacb8f24f64fd35ba5f67e22e34c6564f
```

`files` 列表用**两种不同原理**的方法交叉验证，两者都指向 **727**（我自己数的，未采信派活方的措辞）：
- 仓库自身的发现逻辑（`parallel-test.ts` 用的 `Bun.Glob`，按 unit/it/http 三后缀扫 `tests/`）：727，且与基线**集合完全相等**（`missing: []`、`extra: []`），已排序、无重复。
- 独立工具 `fd`：457（unit）+ 203（it）+ 67（http）= **727**。

本轮确实没有新增测试**文件**（727 与上一轮相同），但用例数从 7532 涨到 7536（+4），与 `0144edcb` 新增的 4 条判据吻合——**文件数不变而用例数变化，两者不矛盾**。

## C5 — typecheck 与 lint 零 error —— **成立**

```
bun run typecheck  -> EXIT=0
bun run lint:all   -> EXIT=0
```
`lint:all` 唯一输出是 `baseline-browser-mapping` 的数据过期提示，属依赖自身的 notice，非 eslint 诊断，零 error 零 warning。

## C6 — 提交信息与内容相符 —— **基本成立，一处数字无法核实，一处计数与派活描述不符**

### 先更正一个计数：是 **10 个**提交，不是 11 个
```
git log --first-parent --oneline ca5f4cf7^..53ae4903 | wc -l  -> 10
```
10 个依次为：`ca5f4cf7` `a0c82cc3` `e24de3a1` `b9b5895b` `f7932527` `ca2653ec` `63568fee` `0144edcb` `27113ce4` `53ae4903`。
若把 `ca5f4cf7` 的第二父 `57208559`（master 侧）也算进来才是 11——但那是被合并进来的 master 提交，不属于本线产出。
这不影响任何结论，仅提示**别把这个数字抄进交付报告**。

### 逐个核对结果

10 个提交的 `--stat` 文件集与其信息描述的改动范围均相符，未发现「信息说做了 A、内容却是 B」的情形。载重数字如下：

| 提交 | 断言 | 判定 |
|---|---|---|
| `e24de3a1` | `7529 executed / 1 failed / 7528 pass`，具名超时用例 | **成立**（对 `/tmp/parallel-test-VZxJ3f/` 复算，逐字吻合）|
| `e24de3a1` | `714 -> 727 files, +13 / -0` | **成立**（前后两版 baseline 实算：714→727，added 13，removed 0）|
| `e24de3a1` | 变异对照：关掉失败捕获 → 同一批产物变 0 failed，两条新正例变红、skipped 那条保持绿 | **成立**（树外变异副本实跑：产物侧 failed 1→0；单测 12 pass / 2 fail，变红的正是那两条）|
| `e24de3a1` | `3337 tests · 3337 pass · 0 fail` | **无法核实** —— 见下 |
| `b9b5895b` | 「master 侧既有 lint error」「同样匹配」 | **成立**（`57208559` 版第 324 行确有该正则、且该文件在第一父 `2df07a1a` 中不存在；stdin 跑 eslint 复现 `regexp/no-super-linear-backtracking`；10 种输入下两版 `.trim()` 后结果 0 差异）|
| `0144edcb` | `7536 tests · 7536 pass · 0 fail`，exit 0 | **成立**（我自己跑 `test:backend`：`7536 tests · 7536 pass · 0 fail · 7536 executed · 35 skipped · 87.67s`，EXIT_CODE=0，且未出现 `⚠ INCOMPLETE` 标记——本轮无缺行文件，正确）|
| `0144edcb` | 4 条判据 | **成立**（新增 4 条 `test(...)`，含 crashed 与 incomplete 相互独立那条）|
| `27113ce4` | 阈值改 30 / 50 | **成立**（diff 即是）|
| `27113ce4` | healthy 109.68/218.58、broken 9.51/10.79、跨树 7 位复现 | **成立**（均为我 C3 的实测值：树内 109.67814011/218.603，树外 109.67814050/218.564，负控 9.5108/10.7938；7 位一致属实）|
| `27113ce4` | 「Verified still green on the healthy tree at 109.85 / 218.71」 | **部分核实** —— 绿是确证的（全后端 0 fail），但 `109.85 / 218.71` 这一对具体读数我没复现到；该指标每次运行有小幅浮动，属正常，不构成矛盾，只是**不能当成可复现常量引用** |
| `53ae4903` | History re-init 缺陷是 master 既有、非合并引入 | **成立** —— 见下 |

### `3337` 为什么判「无法核实」

旧口径是从各 shard 的 **stdout** 解析的，而保留下来的只有 XML；stdout 未落盘，因此该数字**在现存证据里不可复算**。
`docs/tmp/2026-08-08-...-task9-ready-snapshot.md:190` 虽然复述了同一数字，但那是**同一作者、同一轮次的同源复述**，按「两个独立来源其实同源」不构成交叉验证。
需要说明的是：`63568fee` 本身已明确写下「不宣称这解释了历史数字……instrument was replaced, not diagnosed」，**该提交的自我限定是恰当的**，我这条判定不是指控它过度宣称，只是标注这个具体数字的证据等级。

### `53ae4903` 的 History 论断——我独立跑了指定命令确认

不因为它出自另一评审的更正就采信，实跑：
```
git show 57208559:src/lib/history/state.ts
```
master 侧 `initHistory`（第 100 行起）在第 131-133 行是：
```
admission.replaceTerminalSink(new LegacyHistoryTerminalSink({ ... }))
unsubscribeV3Terminal?.()
unsubscribeV3Terminal = subscribeModelOperationTerminals(async (publication) => {
```
**替换 sink 与换订阅者之间没有任何 pause / quiescence / drain**——论断的前半成立。

再跑 `git diff 57208559:src/lib/history/state.ts HEAD:src/lib/history/state.ts`：合并侧新增的只有
`stopV3SummaryBackfill()` + `await drainV3SummaryBackfill()`（函数开头）与 `startV3SummaryBackfill(getDatabase())`，
**而上面那三行 sink/订阅者交换在 diff 里是原样的上下文行**（前后一致、未被改动）。
故「合并只 ADDED backfill coordination、该缺陷是 master 既有」两半均成立，归类为 pre-existing 是正确的，不是把回归洗成既有问题。
