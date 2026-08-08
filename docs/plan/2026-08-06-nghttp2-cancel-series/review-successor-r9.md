# NGHTTP2_CANCEL FINAL_COMMIT／manifest gate 复核 R9

- evidence-manifest-sha256: 1ebe0d17897526a2966d0443a9c659baa9eb9323b67266eadc2eb0870aa011b0
- verdict: 0 blocker / 2 major

- **评审范围：** 仅以新 checkout 接手者视角审 `FINAL_COMMIT`／manifest gate；不重审技术机制。
- **绑定证据：** HANDOVER SHA256 `865e369f3ed852b5b5bea360b0e5b47c921771ab839c3f9a6ba01961e492cbac`；KICKOFF SHA256 `b455f15f0d5b6515aff83ff30cdcbfc363786a3faf8e9fbf5628c2fe4a75c971`；manifest 文件 SHA256 与上方机器字段一致。独立重算 manifest：24 行／24 唯一路径，全部 workspace blob hash匹配，无 manifest 自引用，无 R9 项。
- **总体 verdict：** 修复 2 个 major 后复评。
- **blocker 数量：** 0。**major 数量：** 2。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:29-31,63-67` — gate 只检查 `FINAL_COMMIT` 是 40 位 hex，没有证明对象类型确为 commit。
接手者会因此可把 40 位 tree object ID 当作 `FINAL_COMMIT`；`git show <tree>:<path>` 仍能读取全部 blobs，绕过“同一最终 commit”的身份不变量。
证据：实测 `git rev-parse 0840b929^{tree}` 得 tree 对象，`git cat-file -t` 为 `tree`，但 `git show <tree>:.../HANDOVER.md` 返回 rc=0。
修复建议：读取任何 blob 前要求 `git cat-file -t "$FINAL_COMMIT" == commit`，并要求 `git rev-parse "$FINAL_COMMIT^{commit}"` 逐字等于输入；补 tree/tag/blob 40hex 反例。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:102-113` — R9 机器字段唯一性只在前 20 行计数，报告第 21 行以后可重复或写冲突字段而 gate 仍绿。
接手者会因此采信一份顶部写 green、正文另写第二个 manifest hash或非零 verdict 的自相矛盾 R9，违反“假绿字段／重复字段均应红”。
证据：代码仅令 `top = text.splitlines()[:20]`，随后只搜索 `top`；没有对全文中 `- verdict:` 与 `- evidence-manifest-sha256:` 前缀做额外计数。
修复建议：全文扫描这两个字段前缀，要求每类全文件恰好一行，且该行位于前 20 行并精确等于期望值；补第 21 行重复 hash、冲突 verdict、近似假绿字段反例。

## 已闭合路径

- 不设 `FINAL_COMMIT` 会由 `${FINAL_COMMIT:?}` 红；短 SHA 与非小写／非 40hex 会由正则红。
- manifest 严格要求 24 行、24 个冻结 literal 路径；漏项、额外项、重复路径、格式错误及任一 blob 漂移均红。
- 两份 R9 都从同一 `FINAL_COMMIT` 读取；漏任一 R9、R9 非 UTF-8、顶部缺字段、顶部 hash错误或顶部非 green verdict均红。
- manifest不含自身与R9，R9只声明manifest blob hash，因此无自引用循环；新 checkout只依赖Git对象与调用方显式FINAL，不依赖工作区、job或tmp。

## 双向检查

- **正确状态：** 修复上述两门后，同一commit含manifest、24 blobs与双绿R9可机械通过。
- **false-green：** 当前仍有40hex tree对象和第21行重复／冲突机器字段两类绕过。
- **false-red：** 未发现正确commit、精确manifest与全文件唯一双绿字段被现有其余判据误拒。

## 结构怪味扫描

- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:29-113` — **标识符形状代替Git对象类型＋局部唯一性冒充全文唯一性**；处置：本轮2个major，补对象类型门与全文字段门。
