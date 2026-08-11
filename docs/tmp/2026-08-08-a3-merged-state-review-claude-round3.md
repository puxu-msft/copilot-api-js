# A3 合并态复评 round 3 — Claude 侧报告（转录件）

**这是转录件**：该 reviewer 无 `Write` 工具，报告经回话正文返回，由主会话逐字转录。我的复核结论在 `2026-08-08-a3-merged-state-review-dispositions.md`。

**verdict**：无 blocker；**2 条 major**。它对我点名的三个问题给出明确答案：`durability` 不构成 false-red（**无任何消费者**）；`hasOlder`/`hasNewer`／双向分页／`terminalOnly` 复核未发现问题；但「这轮又引入新问题」的模式**第三轮仍然成立**——这次引入的是**两条写进注释、却可被探针证伪的不变量**，且新守卫只钉住了其中一个方向。

**双视角覆盖**（它自述）：机械核对＝逐条读四个 commit 的 diff、比对 SQL 谓词（`compileSummaryWhere`）与 native 逐维过滤的等价性、核 `recordToEntrySummary` 的两处派生在被过滤字段上是否同源、grep 测试文件里 overlay 行的构造点；第一人称执行＝对重建产物跑 tokenize/substring 双向探针，并按项目实际 runner 跑 `bun test --parallel`（42 pass／0 fail／29.29s，三个文件）。

---

## 事实性发现

**[major] `src/lib/history/queries.ts:193-195` 与 `:433-441`** — 两条注释断言的不变量都不成立，overlay 与 index 的匹配语义在**两个方向**上都不同

- 证据（实跑，当前 native 产物）：语料 `please fix the hello-world bug in src/lib/foo.ts`，query `hello world` → tantivy 命中、overlay 子串**不命中**；`src lib foo` 同形。反方向已知：query `orld` → overlay 命中、tantivy 不命中。
- 被证伪的两句：`:194`「the overlay may over-match ... and it never produces the reverse」；`:440`「a row's membership stops changing as it crosses the persistence boundary」。
- 失败场景（false-red，本轮 ownership 模型使其成为唯一失效面）：一条刚 terminal、尚未 tail+flush 的记录，只有 overlay 能显示它；用户搜「hello world」这类**最普通的多词查询**，该行在整个 drain+tail+flush 窗口内不可见，等索引追上后又凭空出现。反向的 `orld` 则是先可见、落盘后消失。
- 修复建议：让 overlay 用与索引同一套切分做匹配（按非字母数字切 needle 与语料，要求每个 term 都出现），两个方向的分歧一次消掉，`:440` 那句才真正成立；单 token needle 保留子串行为即可。若决定保留残差，就把注释改成「两个方向都会分歧」并写明可观察后果，别留一句会被后人当前提使用的假断言。

**[major] `tests/history/v3/summary-query.it.test.ts`** — 新 ownership 的守卫只钉住「丢得太少」，没有「丢得太多」的正样本对照

- 证据：该文件里调用 `getHistorySummariesAsync` 的只有 `:162`、`:206`、`:214`、`:267` 四处；唯一的 `publishModelOperationTerminal`（`:242`）所用的 id `overlap-cartoon` 在 `:234` 已先 `persist(...)`。即**没有任何一条 async-search 用例里存在「索引看不见的 overlay 行」**。
- 失败场景：把 `overlaySummaries` 恒定改成 `[]`（overlay 彻底停止贡献），这 14 条测试全绿；而 overlay 在 `f2c4ba09` 之后**仅剩这一项职责**，它整体失效不会被任何断言发现。
- 另外，`:265` 的 `expect(result.total).toBeGreaterThanOrEqual(result.entries.length)` 在 `0 >= 0` 上恒真，判别力来自紧随的 `toMatchObject({entries: [], total: 0})`，不来自这条不变量断言。
- 修复建议：补一条对称用例——recent bus 上放一条**未落盘**的记录、stub sidecar 返回空，断言它出现在 `entries` 且被计入 `total`；再加一条同样未落盘、但只有多词查询能命中的记录，用来把 major 1 的方向钉住。

## 我点名的三个问题（它的复核结论，均为「未发现问题」）

- **`durability` 丢失 → 不构成 false-red。** 全仓消费者搜索：`durability` 只出现在生产端 `queries.ts:113-114` 与类型定义 `core-types.ts`；`src/routes/`、`ui-v4/src`、`ui/src` **零命中**。UI 看不到「已落盘中」状态，是因为它本来就没读过这个字段。残留的只是表现不一致（同一行在带 `search` 与不带 `search` 的列表里一个有该字段、一个没有），无消费者，属 minor。
- **`hasOlder`/`hasNewer`／双向分页 → 正确。** 两者取或，任一侧还有更旧/更新的行都会给出游标；`direction="newer"` 下 native 的 `split_off(len-limit)` 与 JS 的 `slice(-limit)` 同向；`limit + overlaySummaries.length + 1` 变小是对的——被移出 overlay 的行改由 sidecar 页承担配额，未发现欠取。
- **`terminalOnly` → 未被本次改动影响。** 注：它从未下发给 sidecar，因此 `persistedTotal` 理论上会多计「已落盘的 active 行」——但这是既有行为、且本仓 V3 未见 eager 落盘 streaming 头行，不作为发现提出。
- **另两处已复核为等价**：SQL 谓词与 native 逐维过滤在 endpoint/state/pid/session/agent/model/from-to 上语义一致；`recordToEntrySummary` 的两次派生其**被过滤字段**全部只取自 `record`，`stored` 参数只影响 `pinned`/`endedAt`。

## Round-2 三条的闭合判据（可复跑）

- **M1（`InvalidArg` 过宽）→ 闭合。** 判据：`search-rest-cutover.it.test.ts` 的「an unparsable query is 400 while an unreachable sidecar stays 503」通过（真 HTTP，三例 400，可解析查询 200 作正控，杀掉 sidecar 后 503）。残留一条 minor：daemon 在调 `listSearch` **之前**先判 target 覆盖，故「索引滞后 + 坏查询」仍先出 503；该优先级未被用例覆盖。
- **M2 → 我报的那条路径闭合**，但守卫的方向缺口见上面 major 2。
- **M3 → 闭合。** 三条都补了，且 `daemon.ts` 原先未覆盖的 165-169 那段代码已被删除。判据：三个文件 `--parallel` → **42 pass / 0 fail**。

**一条排雷提示（不是发现）**：这三个文件放在**同一个进程**里跑（不带 `--parallel`）会有 5 条红，全部来自跨文件的进程级单例污染；用项目实际的 `--parallel` 全绿。
