# A3 合并态独立复评 round 6

- **评审范围**：`cd80497a..adfdf75127b7ed77e86774bdd2e295dea67638cf`，重点检查 token equality 与双向 agreement oracle。
- **已读取／执行的证据**：读取全部 diff；agreement oracle 3 pass／0 fail；分别用裸 corpus 与 `projectSearchableText` 真实 JSON corpus 实跑 41-byte token 对照。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。另有 1 条 major。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/src/lib/history/queries.ts:203-213`、`/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/tests/history/search/overlay-index-agreement.it.test.ts:91-112` — overlay 未镜像 Tantivy 默认 tokenizer 的 40-byte `RemoveLongFilter`，双向 oracle 也漏了该漂移轴。
证据／失败场景：真实 `projectSearchableText` JSON corpus 含 41-byte token，needle=`<该 token> zzzabsent`；native total=0，recent overlay 却返回该行。该行仍会抬高 total、占据首页并产生无效 cursor，和刚修的短-term overmatch 同影响。
修复建议：多词 matcher 在建 term/token 集时按 UTF-8 byte length 丢弃 >40-byte token；agreement 表加入 40／41-byte 边界、长 Unicode token及“长 term＋不存在 term”双向样本，并以真实 recent corpus 为 oracle。

## 双向 oracle 与单 term 豁免

- 双向＋双 lane 的结构是正确修复：真实 index 对 in-flight corpus 与 `projectSearchableText(record)` 分别作 oracle，避免再次用理想化裸散文代替生产载体。
- 单 term 豁免目前是明确的产品语义，不是静默放行；逐 pair 标注优于 blanket skip。但它仍允许一词 substring 与 index 不同，调用方必须接受持久化边界前后结果收敛。未发现该豁免在本轮构成新的 blocker／major。

## 可复用判据

- **先复现 producer，再比较 consumer**：凡评审“两个 matcher／codec／projection 等价或蕴含”，fixture 必须通过生产 producer 生成最终载体，禁止手写语义等价的简化字符串／对象；否则键名、ID、hash、转义、截断与默认字段会消失。
- 判据必须同时覆盖：生产载体的高频噪声字段、边界过滤器（本例 40-byte）、两方向差异、每条真实消费 lane；并保留至少一个“简化样本通过但生产样本失败”的战例，防止未来测试退化回理想化 fixture。
