# 文档归并重组独立评审

> **来源**：`gpt-souls:reviewer`，2026-08-11，评审对象 `770128a1`。**正文逐字保留、未经改写**——原件由 reviewer 写在 `/tmp/docs-consolidation-review.md`（共享检出的写入护栏拒绝了它写进仓内），主会话以 `cmp` 校验逐字节一致后收入本仓，先原样提交、本头部另起一个提交追加，故 `ee862e01` 里是未加工的原件。
>
> 结论：**BLOCKER 0 / MAJOR 0 / MINOR 0**。

## 评审范围

- 评审对象：`master` 的 `770128a11850a4eeb571b09562b2b2d00c34f274`；`git merge-base --is-ancestor 770128a1 master` 返回 0，确认该目标已在当前 `master`。
- 提交范围：`git log --oneline 15c43e40..770128a1 -- docs/ exp/ .superpowers/` 所含归并及其最终合并态。
- 本评审只读检查既有对象，并只写入本报告；未操作 4141 进程、未推送、未修改被审文档或脚本。

## 已读取／执行的证据

1. `git diff --name-status 15c43e40 770128a1 -- docs/ exp/ .superpowers/`：确认该系列的 50 个 Markdown 文件处于 `docs/mandatory-block-delivery-h2-observability/`，并核对每一个迁入源路径。
2. 用 Python 从 `770128a1` Git tree 枚举 50 个目录内 Markdown，对每个内联相对 Markdown 链接按源文件目录解析，覆盖同目录裸链接；共检查 87 条目录内相对链接，未发现缺失目标。另以全仓 tree 检查目录外指入本系列的 3 个实际 Markdown 链接，均解析到现存文件。
3. 对 `.superpowers/sdd/`、`docs/tmp/`、`docs/spec/`、`docs/plan/` 搜索系列特征词。4 个候选中：旧 `progress.md` 是明确 stub；`wrapup-artifacts-review.md` 是跨 memory/backlog/coding-conventions/实验及一个 Task 9 快照的综合评审；另两份分别是 lifecycle／shutdown 系列对本系列的历史引用。因此没有证据表明本系列独立文档仍留在旧目录。
4. 对目录内 `batch2b`、`header-deadline`、`precontent-recovery`、`TUI`、`memory` 逐项搜索并阅读命中上下文。`batch2b` 仅出现在 Task 37 评审保存的历史 `git diff --name-status`；其余 History Worker 名称仅为 Task 9／37 审核基线中无关提交或代码路径的证据，均不是被误迁的 History Worker 文档。`TUI` 无命中；`memory` 是通用词而非另一系列文档。
5. `git grep -n -C 2 '\.superpowers/sdd/progress\.md' 770128a1 -- docs/todo/deferred-backlog.md docs/plan docs/archive` 及 `git grep -n -i P1 770128a1 -- docs/mandatory-block-delivery-h2-observability/progress-ledger.md`：backlog 第 696 行确称 `P1 Task 1-4/7`，而迁入账本零个 `P1` 命中。旧路径确有 17 个来自多次独立 SDD 运行的引用，故不将目录外引用全部重指到新账本的决定正确；旧路径 stub 也给出了新账本入口及历史取证方式。
6. `git log --follow`：`plan.md` 可回溯至 `82cd9123`，`spec.md` 可回溯至 `2bd0b83d`，`progress-ledger.md` 可回溯其迁移前的连续原始账本提交；重命名历史未断。
7. 读取本目录与 `docs/history-persistence-worker/` 的 README，并对 README 直接主题文件链接做集合比较：50 个目录 Markdown 中 49 个非 README 文件均被 README 索引；命名为 `README.md`、`spec.md`、`plan.md`、`plan-kickoff.md` 及日期前缀角色文件，目录扁平，且 README 正确将当前状态指向 `progress-ledger.md`、活路径指向 `docs/DESIGN.md`。
8. `python3 exp/task37-closeout-inventory/reconcile-inventory.py`：退出 0，自动内容定位到迁入后的 frozen inventory，且确认头部 427 与实际成员行 427 一致。正样本对照以不落盘的 in-memory inventory 驱动同一 `main()`：故意声明 2 行而只给 1 行，返回 1 且输出 `header declares 2 members but the file lists 1`，证明检查不是恒绿。

## 总体 verdict

可进入下一阶段。BLOCKER：0；MAJOR：0；MINOR：0。

## 事实性发现

未发现问题。

## 结构怪味扫描

- `docs/mandatory-block-delivery-h2-observability/README.md` 与目录内 50 个 Markdown、旧路径 stub、`reconcile-inventory.py`：检查重复权威、错误归属、无效双轨和手工路径依赖；未发现需要修复或登记 backlog 的结构怪味。旧进度路径作为复用路径的 stub 与内容寻址脚本分别消除了两种误导性双源／路径耦合，而不是引入长期双轨。
