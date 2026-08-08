# 事实证伪复评 R9

- evidence-manifest-sha256: 1ebe0d17897526a2966d0443a9c659baa9eb9323b67266eadc2eb0870aa011b0
- verdict: 0 blocker / 2 major
- **评审范围：** 仅审 manifest 与 `FINAL_COMMIT` gate；候选 `HANDOVER.md@865e369f3ed852b5b5bea360b0e5b47c921771ab839c3f9a6ba01961e492cbac`、`KICKOFF.md@b455f15f0d5b6515aff83ff30cdcbfc363786a3faf8e9fbf5628c2fe4a75c971`、manifest `1ebe0d17897526a2966d0443a9c659baa9eb9323b67266eadc2eb0870aa011b0`。
- **总体 verdict：** 修复 2 个 major 后可提交。
- **双视角覆盖：** 机械核 24 项 set／格式／workspace hash、两份 gate 逐字一致、R7/R8 角色叙述；第一人称注入 tree object、缺项／错 hash／混合 blob／矛盾 verdict，验证错误状态是否会假绿。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/{HANDOVER.md:51-53,KICKOFF.md:29-32}` — `FINAL_COMMIT` 只校验 40 位 hex，没有校验对象类型为 commit。
证据／失败场景：`git rev-parse 0840b929^{tree}` 得 40hex tree `be93727a…`，且 `git show be93727a…:docs/.../KICKOFF.md` rc=0；同理，最终 tree hash 可让全部 `blob()`、manifest 与 R9 检查通过，却没有 commit 身份／parents，违反“同一最终 commit”。
修复建议：解析 hex 后执行 `git cat-file -e "$FINAL_COMMIT^{commit}"` 并要求 `git cat-file -t "$FINAL_COMMIT" == commit`；Python 中用 `git cat-file -t final_commit` 精确拒绝 tree／tag／blob，再读取所有 blob。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/{HANDOVER.md:122-135,KICKOFF.md:100-114}` — R9 解析只数 top-20 中一条精确绿色行，矛盾的真实 verdict／major finding 可同时存在而 gate 假绿。
证据／失败场景：构造 top-20 同时含 `- verdict: 1 major`、`- verdict: 0 blocker / 0 major` 与 `[major] fatal finding`；现有 `verdict_count == 1` 仍为真，manifest 检查也为真。top-20 外的第二机器字段同样完全不被扫描。
修复建议：全文件解析机器字段，要求 manifest 与 verdict 字段各恰好一次；任一其他 `^- verdict:` 行、blocker／major finding 标记或非零计数即拒绝。至少加入矛盾 verdict、major finding、字段移到 21 行及重复字段四个负控。

## 已通过项

- manifest 为 24 行、24 个唯一 literal；精确集合与 gate 一致，工作区 blob SHA256 全匹配，不含 manifest 自身或 R9。
- 所有 evidence blob 都通过同一 revision 参数读取，故在补 commit-object type gate 后可保证同一 commit；缺项、错 hash、错误集合与混合内容会红。
- HANDOVER／KICKOFF 的完整 gate 文本逐字一致，SHA256 同为 `df7b7ff896daf851262003a6ec6af5117574924459f816ba04c01d0b1b1f64ed`。
- R7 被准确描述为终态化前技术双绿；R8 factual 为 0B／0M、successor 发现 manifest 缺口；R9 排除在 manifest 外以避免自引用。
