# Commit -1 whole-branch review record

## 范围与证据等级

评审基线为 `87679f35d346cad94abd32d62133b40fee79fe7a..4fe920fca820f7dcee630d76e2aab120952eb7ea`。本记录只归档该不可变范围的 whole-branch review；`389a21e1f2d4ef72ee26de3e7283d8e8c065d222` 是范围外后续文档修复，不能由本轮评审自动判定通过。

证据分两级：①“直接实跑”仅指实施方报告并在相应修复文档中绑定到具体 commit 的 focused、mutation、typecheck 与 backend 结果，本 reviewer 按派活要求没有重跑；②“读证复核”指 reviewer 完整读取 review packages、最终代码、frozen `cutover-plan.md` §0.4e／§0.4f／§0.5、测试与文档，并用 `git show`／`git log`核对 commit、范围及集成关系。

## Findings 最终 disposition

| Finding | 修复 commits／范围 | 独立复评结论 |
|---|---|---|
| Major 1：C11 runtime import scanner 漏同一行第二 import | `9ca24c18`；后续 closure 加固至 `0fe17435` | 已关闭：全 import 扫描、bootstrap、local／bare runtime closure 与 ENTRY provenance 均复评通过。 |
| Major 2：disk/runtime/skipped aggregates 仅验 hash、可协调自洽篡改 | `9ec5da94`, `d564212e`, `baea24d7` | 已关闭：strict schema、15-run 双向语义对账及 coordinated tamper controls 通过复评。 |
| Major 3：nested same-basename artifact 可替换 direct child | `9ec5da94`, `d564212e`, `baea24d7` | 已关闭：canonical direct parent、固定 basename、nested 负控与 symlink-OUT 正控通过复评。 |
| Major 4：receipt-v1 缺严格 consumer／tamper oracle | `b05af54e` 至 `7cbe5fa4` | 已关闭：12-key strict parser、独立 T0.1 expected facts、pointer／manifest／receipt provenance、RFC3339 与 leap-second controls 通过复评。 |
| Producer containment：lexical OUT 可经 symlink 落入 TREE | `198d4db5`, `0771b49b` | 已关闭：pre-write deepest-ancestor gate、post-mkdir recheck、canonical run layout及 no-replace atomic writer通过复评。 |
| XML parser：手写 regex/entity parser 是承重协议重实现 | `eaa8099f`, `00915750`, `b71d4a1e` | 已关闭：改用直接锁定的 `saxes@6.0.0`；真实 Bun corpus、namespace／entity／skip／malformed controls与 API consumers复评通过。 |
| C11 SAX dependency closure：TREE-local false-red、手写 closure、自证 bootstrap、package-set 单向比较 | `fdf7c12d` 至 `0fe17435`，集成于 `4fe920fc` | 已关闭：实际 Bun resolution内容身份、metafile递归 closure、ENTRY-bound manifest／package／lock、built-in bootstrap及 observed＝manifest package population复评通过。 |

## A／B 最终裁决

**A——commit-message discipline：待关闭，但可作为 nonblocking reviewed exception 处理。** Frozen `cutover-plan.md` §0.5 要求每条 message 点名章节；大量历史提交不满足字面要求。不要重写这些已评审 SHA，因为重写会使 review ranges、mutation基线、报告引用与 evidence lineage失效并触发整轮重验。关闭条件是：独立评审通过 plan amendment，明确 Commit -1 一次性例外，并提供覆盖 `87679f35..FINAL_REVIEWED_COMMIT` 精确提交集合的 mapping。每行至少含原 SHA、subject、对应 T0.0 task／§0.4e／§0.4f／Commit -1 gate、产物角色、主要 paths、覆盖它的 review range／报告及 ancillary 修复归属；必须机械拒绝 missing、duplicate、orphan。Commit 0～8 继续执行 message 内点名章节的原规则。

**B——五份最终文档的 stale HEAD／next-action：在本评审范围内仍待关闭。** 需修复两份 `2026-08-05-command-algebra-commit-minus-1-*` 与三份 `2026-08-06-command-algebra-commit-minus-1-*` 文档，把 `3b5ac1e4` 等写成绑定具体测试的 `tested_code_head`，把独立评审覆盖写成 immutable `reviewed_branch_head`／range，删除“whole-branch review 是下一项”，并避免自指的固定 final HEAD；entry A 只由最终 merge 到 master 后重取。范围外 commit `389a21e1` 声称已完成该修复，但必须单独复评，不能据其存在把 B 判关闭。

## 当前 verdict

截至 `4fe920fca820f7dcee630d76e2aab120952eb7ea`，除 A 的独立 plan amendment＋commit mapping 与 B 的五份文档修复／范围外复评外，原始评审链没有未决 blocker 或 major。A／B 完成前，本记录不批准将 Commit -1 作为最终 entry candidate；真实 T0.0f／T0.0d 仍只能在 merge 后按 frozen §0.4f 启动。
