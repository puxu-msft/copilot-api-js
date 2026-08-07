# NGHTTP2_CANCEL 交接终态与证据可达复核 R8

- **评审范围：** 以新 checkout 接手者视角，只审终态状态与证据可达流程；不重审技术机制。
- **绑定证据：** `sha256sum` 得 HANDOVER `af7fecc86df84b79e1b70bced408f8c8b3da97d99acd4e2b320e865b336d01e6`、KICKOFF `c974c4cb697d1a79d830707700fafbff529740b350e16e72afec5d83e9a33d05`。当前目录实有初稿 8 文件、首轮双链、factual R2～R7 与 successor R2～R7，共 22 个既有文件；`git ls-tree -r 0840b929 -- <目录>` 确认 `0840b929` 只有初稿 8 文件。R7 两份报告分别明确 0 blocker／0 major，但绑定的是上一版 KICKOFF `df522990...`，不是本轮终态 rewrite。
- **总体 verdict：** 修复 major 后可提交。
- **blocker 数量：** 0。**major 数量：** 2。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:4`、`HANDOVER.md:25` — “取包含当前两文件的同一最终 commit”与逐项 `cat-file` 仍只有 `<commit>`／`<path>` 占位符，没有冻结 blob hash、候选 commit 取法或完整路径 manifest。
接手者会因此直接把 `HEAD` 当最终 commit，或分别取两文件最后提交；也可能从现存目录反推清单，令本就缺失的 review 无法进入待查集合而 false-green。
证据：两文合计只有说明性 `git cat-file -e <commit>:<path>`，没有可复制的 22 项（及本轮 R8）literal 列表；新 checkout 无 job/tmp 可辅助补全。
修复建议：写一段完整只读 gate：`FINAL=$(git rev-parse HEAD)`（或调用方明确传入），先以本轮两个 SHA256核 `git show "$FINAL":<HANDOVER|KICKOFF>`，再对冻结 literal array逐项 `git cat-file -e "$FINAL:$path"`；任一失败立即退出。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:4`、`HANDOVER.md:25` — 终态证据集截止 R7，未预注册本轮真正绑定终态 hashes 的 `review-successor-r8.md`。
接手者会因此在最终状态复核 R8 未进入 Git 时仍通过“R2～R7 全可达”并把交接当完整；R7 的 0B／0M 只证明上一版 KICKOFF `df522990...`，不能单独证明当前 `c974c4cb...` 的终态改写。
证据：`review-factual-r7.md:3-5` 与 `review-successor-r7.md:4-6` 均绑定 `df522990...`；当前两文只要求首轮及 R2～R7，不要求本报告。
修复建议：冻结 manifest 时加入 `review-successor-r8.md`，最终一次提交同时包含当前 HANDOVER／KICKOFF、完整历史链与 R8；终态 gate 明确 R7 是技术机制双链结论、R8 是当前状态／可达流程结论，缺任一即停止。

## 无回归项

- `HANDOVER.md:2,31-70,76-133` 将“已评审·交接定稿”限定为交接文档状态，同时继续明确 A3 六条 major、A1／真实库／CI尾项、A4未实施与 Phase B TBD；接手者不会把文档定稿误读为项目完成。
- `HANDOVER.md:6,25` 正确区分 `0840b929` 历史初稿与待取的最终 commit；job/tmp、job state、tasks、transcript 均只作 provenance，不是新 checkout 依赖。
- 当前终态改写只改状态／证据入口措辞，A3／A4／Phase B 技术范围、硬 gate 与三个 packet未见新增差异。

## 双向检查

- **false-green：** 未冻结候选 blob与完整 manifest时，错误 commit、混合 commit或缺失 R8仍可能被人工解释为通过。
- **false-red：** 用同一 `FINAL`、两个冻结 blob hashes与 literal manifest后，包含全部证据的正确新 checkout可机械通过，不依赖 job/tmp或历史会话。

## 结构怪味扫描

- `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:4` 与 `HANDOVER.md:25` — **证据集合用自然语言类别而非冻结 manifest**；处置：本轮 major，改为同一 commit＋blob hash＋literal path array 的单一机械 gate。
