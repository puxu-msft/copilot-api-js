---
name: methodology-fastfield-ordinal-not-per-doc-dictionary-lookup
description: 把 stored-doc 读改成列式 fast field 时，逐文档做词典查找会反向劣化——等值比较用 term ordinal、字符串按段批量解析
metadata:
  type: reference
---

Tantivy（0.26.1）读路径优化的一条硬事实，2026-08-08 在 native `list-search` 上实测得到。

**反向劣化的那一版**：把「每条命中 `searcher.doc(address)` 解压 stored document」换成「逐文档从 fast field 读字段」，方向正确，但**无过滤列表页从 42.8 ms 劣化到 694.8 ms（慢 16 倍）**，同时选择性过滤快了 5 倍——所以只测有过滤的场景会得出「改对了」的结论。

**根因**：`StrColumn::ord_to_str` → `Dictionary::ord_to_term`，**每次调用都从所在 sstable block 的首个 ordinal 重新解码**（源码 `tantivy-sstable/src/dictionary.rs` 的 `ord_to_term`：`for _ in first_ordinal..=ord { advance() }`）。单次查找的代价正比于 block 内偏移，逐文档调用即对 block 大小呈二次。原先「一次 stored doc 读」反而把同一文档 12 个字段的代价摊薄了。

**正确形状**（三条，缺一条就可能白干）：

1. **等值过滤按 term ordinal 比较**：每段用 `Dictionary::term_ord(value)` 把过滤值解析成一个 ordinal（每段一次），逐文档只做 `column.ords().first(doc)` 这一次列式 `u64` 读 + 小集合成员判断。过滤值在该段词典中不存在 → 空集合 → 该段无匹配，语义天然正确。
2. **子串/正则这类无法 term 查询的过滤**：每段流式扫一遍**该字段的词典**（不是文档），得到「命中」的 ordinal 集合，逐文档同样退化为成员判断。字段基数小（model 名只有个位数）时极便宜。
3. **必须物化成字符串的字段**（本例是要回传的 `operation_id`）：先把幸存者的 ordinal **升序排序**，再用 `Dictionary::sorted_ords_to_term_cb` 做**每段一次**的前向流式解析；它容忍重复 ordinal，但**乱序会 panic**。

改完 20k 语料无过滤列表页 42.8 → 7.0 ms，100k 无过滤 254 → 54 ms、1% 选择率 session 过滤 254 → 9 ms，所有场景无一变慢。

**Why:** 「列式比行式快」只在**访问模式也换成列式**时成立。逐文档去查词典，等于在列式存储上重演随机行访问，还多付了一次 sstable 解码。这类改动的对错**推理不出来**——第一版看起来完全合理。

**How to apply:** 动这条读路径前**先跑基线**：`exp/history-search-list-perf/bench.ts`（确定性合成语料，分档计时，中位数）。基线必须**包含无过滤/宽命中场景**——只测选择性过滤会让反向劣化完全隐身。数字带 ±50% 量级的运行间抖动，只信量级不信精确比值。完整数字、被推翻的那一版、以及「它没有证明什么」在 `exp/history-search-list-perf/README.md`。

同一轮的另一半教训（两次 mutation 不变红都是因为 fixture 造不出被测状态）见 [[methodology-verify-the-mutation-actually-applied]]；SQLite 侧的同类读路径陷阱见 [[methodology-sqlite-read-path-unused-blob-and-orderby-index-mismatch]]。
