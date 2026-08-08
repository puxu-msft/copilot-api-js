# history-search list-search read path — baseline and result

**结论**：native `list-search` 的每页开销原本正比于**全文命中数**，而不是**结果数**；改为按列式 fast field + 词序号过滤后，20k 语料上无过滤列表页 42.8 ms → 7.0 ms，100k 语料上 254 ms → 36 ms，且**所有场景无一变慢**。

产物 `bench.ts` 是可复跑的基线工具，不是一次性脚本——以后再动这条读路径，先跑它。

## 怎么跑

```bash
bun run build:history-search
bun run exp/history-search-list-perf/bench.ts            # 2000 / 20000 / 100000
bun run exp/history-search-list-perf/bench.ts 20000      # 指定语料规模
```

语料是确定性伪随机生成的（固定种子），同一规模两次运行测的是同一份语料。每个场景取 7 次的中位数。

## 测量结果

改动前后同机、同语料、同命令。改动前 = `475bed45`（`master` 上 A3 前三条已合并的状态），改动后 = 本目录 README 所在提交。

**20 000 篇**

| 场景 | 改前 ms | 改后 ms |
|---|---:|---:|
| list，无过滤 | 42.8 | 7.0 |
| list，session 过滤（命中 1%） | 41.9 | 5.1 |
| list，state+endpoint 过滤 | 42.8 | 3.1 |
| list，model 子串 | 54.0 | 5.0 |
| search，宽词（命中 50%） | 28.0 | 5.0 |
| search，稀有词（命中 1%） | 2.7 | 1.8 |
| search + session 过滤 | 27.7 | 0.6 |

**100 000 篇**

| 场景 | 改前 ms | 改后 ms |
|---|---:|---:|
| list，无过滤 | 254.1 | 54.1 |
| list，session 过滤（命中 1%） | 254.5 | 9.0 |
| list，state+endpoint 过滤 | 241.2 | 5.5 |
| list，model 子串 | 296.7 | 43.7 |
| search，宽词（命中 50%） | 182.9 | 30.0 |
| search，稀有词（命中 1%） | 12.3 | 7.6 |
| search + session 过滤 | 162.9 | 1.9 |

**这些数字带 ±50% 量级的运行间抖动，别当精确值读。** 同一份改后代码、同一台机器上跑两次 100k，无过滤列表页分别得到 36.3 ms 与 54.1 ms，session 过滤分别得到 4.5 ms 与 9.0 ms（表里取的是后一次，即最终二进制那次）。测量期间本机在跑构建与测试。结论「量级上快了 5–25 倍」稳健，「快了 N.N 倍」不稳健。

改前那两行 254.1 与 254.5 是这次改动的全部动机：**1% 选择率的过滤器一毫秒都没省下来**，因为过滤发生在把每条命中的 stored document 解压出来之后。

## 中途被实测推翻的一版实现

第一版只做了「换成 fast field 读取」，结果**无过滤列表页从 42.8 ms 劣化到 694.8 ms（慢 16 倍）**，同时选择性过滤确实快了 5 倍。

根因不是 fast field 本身，而是**逐文档做词典查找**：`Dictionary::ord_to_term` 每次调用都从所在 sstable block 的首个 ordinal 重新解码，单次查找的代价正比于 block 内偏移，逐文档调用即对 block 大小呈二次。原先「一次 stored document 读」反而摊薄了同一文档 12 个字段的代价。

修法是把词典访问从「每文档一次」降到「每段一次」：

- **等值过滤按词序号比较**：每段用 `Dictionary::term_ord` 把过滤值解析成一个 ordinal，逐文档只做一次列式 `u64` 读 + 小向量成员判断。过滤值在该段词典中不存在时得到空集合，语义即「本段无匹配」。
- **model 子串**：每段流式扫一遍该字段词典（model 字段的不同取值只有个位数），得到「含该子串」的 ordinal 集合，逐文档同样退化为成员判断。
- **operation_id 物化**：过滤后用 `sorted_ords_to_term_cb` 对**升序排好的** ordinal 做一次前向流式解析，一段一次，而不是每条结果一次查找。

这一版才是上表的「改后」。

## 两个附带探针（`supersede-probe.ts` / `segment-probe.ts`）

写变异对照时，两条「本该变红」的测试没变红，探针查出来的原因都不是测试写错了，而是**我对 tantivy 行为的模型是错的**：

- **`segment-probe.ts`：一次 `flush()` 不止产生一个 segment。** 实测 3 篇 → 三个 1 篇的 segment；8 篇 → 6/1/1；30 篇 → 28/1/1；200 篇 → 198/1/1（writer 的多个索引线程各自成段）。后果：**用 3 篇文档写的「序号→候选映射」测试毫无判别力**——每段只有一个幸存者时，映射怎么错都是恒等。改成 12 篇（其中 10 篇同段）后，同一个变异立刻变红。
- **`supersede-probe.ts`：这种写法下不会留下 tombstone。** 同一 operation 二次 upsert（`delete_term` + `add_document`，随后 commit）之后，`meta.json` 里所有存活 segment 都是 `deletes: null`；被删文档已在 commit 时物化清除，而只剩 0 篇存活的 segment 会被整段丢弃。200 篇的大 segment 同样如此。后果：`list_search_blocking` 里的 alive-bitset 分支**目前不可达**，禁用它不会让任何测试变红。该分支仍然保留（旧的 collector 路径本来就免费提供这层过滤，一旦 tantivy 策略变化，丢掉它会静默复活被取代的记录），但代码与测试都写明了它未被测试覆盖。

跑法：

```bash
bun run exp/history-search-list-perf/segment-probe.ts
bun run exp/history-search-list-perf/supersede-probe.ts
```

## 它没有证明什么

- **没有证明真实 History 语料上的加速比。** 合成语料的字段基数、文本长度、命中分布都是人造的：`content` 是 40 个词的随机组合，真实请求正文要长得多也重得多；`session_id` 只有 100 个不同取值。真实语料的绝对值和比值都会不同。
- **没有测多段（segment）场景的代表性。** 基线里每个规模只 `flush()` 一次，因此基本是单段。生产索引由 daemon 分批 flush，段数更多；分段会让「每段一次」的词典解析次数上升，也会改变合并后的表现。
- **没有测删除/更新密集的索引。** 语料里每个 operation 只写一次，没有 tombstone。真实索引里 `upsertSummary` 会 delete-then-add。
- **没有测并发。** 全部是单进程串行调用，没有 sidecar 的 UDS 往返、没有并发查询。
- **没有覆盖正确性。** 性能数字完全不保证结果正确——正确性由 `tests/history/search/daemon.it.test.ts` 里的 native list-search 用例负责（超越、缺列、pushdown 与逐文档过滤选出同一集合）。
- **不是回归门禁。** 没有任何测试断言这些数字；它不会在变慢时自动变红，只有人主动跑才有信号。
