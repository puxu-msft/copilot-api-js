# job tmp 处置清单 — History Worker Batch 2b 收尾

枚举命令：`find . \( -type f -o -type l \)` = 174；交叉核对 `fd -H -I --type f --type l` = 174（`fd -H` 不带 `-I` 只报 64——按 skill 的坑，它吃 .gitignore）。

**本轮零删除**：所有行的长期价值都已有已提交的仓库载体，删除时机不会毁掉任何唯一副本；目录留给 harness 到期回收。

| 文件 | 类型 | 长期价值 | 载体 / 替代证据 | 处置 |
|---|---|---|---|---|
| `ab1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `ab2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `add-import.ts` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `add-import2.ts` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `b3.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend10.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend11.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend12.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend13.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend14.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend15.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend16.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend17.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend18.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend19.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend4.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend5.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend6.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend7.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend8.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `backend9.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `baseline-adhoc.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `baseline-before.json` | grep / 基线快照 | 无（可重跑重建） | 命令见清单正文 | 保留，不删 |
| `baseline-test-fast.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `bl-mut.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `bl-mut2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `bl2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `bl3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `build.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `cfg.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `dbh-shard.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `dbh.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `dur-base.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `dur.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `e2e-deadline.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `e2e-mut.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `e2e-mut2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `e2e2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `e2e3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `e2e4.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `e2e5.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `ee.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `enum-check.ts` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `enum-diff.ts` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `fast1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `fast1.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `fast2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `fast2.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `fx.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `fx2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `fx3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `g1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `g2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h10.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h10.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h11.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h11.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h12.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h12.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h13.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h13.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h14.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h14.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h15.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h16.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h17.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h18.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h2.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h3.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h4.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h4.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h5.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h5.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h6.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h6.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h7.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h7.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h8.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h8.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h9.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `h9.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `hist-infra.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `hist-par.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `hist-seq.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `infra.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `iso-mut.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `iso.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `iso2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `iso3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `iso4.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `it-run1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `it-run2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `m1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `m1.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `manifest.md` | 未分类 | 待定 | — | 保留，不删 |
| `memory-pins.txt` | grep / 基线快照 | 无（可重跑重建） | 命令见清单正文 | 保留，不删 |
| `merge-gate.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `merge-gate2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `merge-gate3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `merge-gate4.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `merge-msg.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `min.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `msg1.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msg2.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msg3.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msg4.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msg5.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msg6.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msg7.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgA.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgB.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgC.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgD.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgE.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgF.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgG.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgH.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgI.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgJ.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgK.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgL.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgM.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgN.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgO.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgP.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgQ.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `msgR.txt` | commit-msg 输入 | 无（消息已进提交对象） | 对应 commit 的 message | 保留，不删 |
| `n1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `n1.txt` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `n2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `n3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `nonfile-candidates-review.md` | 本次收尾的审计稿 | **有**：结论需落仓库 | 见终稿报告与 docs/ 载体 | 保留至结论落盘后 |
| `nonfile-candidates.md` | 本次收尾的审计稿 | **有**：结论需落仓库 | 见终稿报告与 docs/ 载体 | 保留至结论落盘后 |
| `pc-guard.ts` | 守卫正则的正样本对照 | 无（正样本已进测试） | `tests/architecture/history-worker-boundaries.unit.test.ts`（5 处 positive control，已核实） | 保留，不删 |
| `probe-ro-ddl.ts` | 只读 DDL 能力探针 | **有**：结论=只读连接上 IF NOT EXISTS 对已存在对象 no-op、对新对象抛 | `docs/history-persistence-worker/archive-2026-08-11/2026-08-09-history-worker-progress-impl-2b.md:46`（已提交，含「实测非推断」与顺序依赖） | 保留，不删 |
| `probe-ro.db` | 只读 DDL 能力探针 | **有**：结论=只读连接上 IF NOT EXISTS 对已存在对象 no-op、对新对象抛 | `docs/history-persistence-worker/archive-2026-08-11/2026-08-09-history-worker-progress-impl-2b.md:46`（已提交，含「实测非推断」与顺序依赖） | 保留，不删 |
| `probe.it.test.ts` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `probe.ts` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `rebaseline.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `resolve.py` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `revert.patch` | 编辑前快照 | 无（结果已提交） | 对应 commit 的 diff | 保留，不删 |
| `round2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `round2b.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `s12.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `s12b.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `s12full.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sc.orig` | 编辑前快照 | 无（结果已提交） | 对应 commit 的 diff | 保留，不删 |
| `sc1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sd-mut.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sd-mut2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sd2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sd3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sd4.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sh1.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sh2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sq.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sq2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `sq3.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `state.ts.orig` | 编辑前快照 | 无（结果已提交） | 对应 commit 的 diff | 保留，不删 |
| `state2.orig` | 编辑前快照 | 无（结果已提交） | 对应 commit 的 diff | 保留，不删 |
| `susp.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `swap-getdb.ts` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `switch-reads.ts` | 一次性脚本（codemod / 枚举 / 合并辅助） | 无（产物已提交） | 对应 commit 的 diff | 保留，不删 |
| `tc.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `tier-it-base.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `tier-it.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `tier-it2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `w2.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
| `worker-tests.log` | 测试运行输出（派生数据） | 无（判据是 0 fail，已记进度文档） | `docs/tmp/…progress-impl-2b.md` 的门禁实测节 | 保留，不删 |
