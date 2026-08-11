---
name: methodology-edit-then-verify-then-commit-never-one-call
description: 编辑脚本把写盘放在所有 assert 之后 → 中途失败即静默丢弃全部改动而 git commit 照跑，提交信息描述了没发生的事；方法已扶正为 user-level skill `editing-files-precisely`，本文只留触发钩子与本仓实例
metadata:
  type: methodology
---

**方法已下沉，本文是 stub。** 「编辑 → 单独一次调用验证新文本真在磁盘上 → 再提交」的完整配方、为什么 `bash -n`／smoke 证明不了编辑生效、批量替换让写盘发生在每个替换之后、以及提交信息落笔前逐句 grep——**权威在 user-level skill `editing-files-precisely` 的「落盘」一节**（2026-08-09 扶正）。

**触发钩子**（skill 万一没浮现，这行是唯一兜底）：**改文件、验证、提交，这三步不得写在同一次 Bash 调用里。** 验证必须针对**新写入的具体字符串**，不是语法检查、不是 smoke 跑。

## 本仓实例（留在这里，不进通用 skill）

2026-08-03 同一会话内中了两次，形态完全一样：

- **`5a71607f`**：提交信息描述了脚本的 precise-claim 段与 HANDOVER 的 T3-b，**磁盘上一个都没有**；而由另一次调用写入的 run-log 已经引用了那个不存在的条目。**是评审去找产物才抓到的，不是我自查到的。**
- **`88171b3b`**：声称重验了相位状态行，锚点差**一个空格**，只有状态行进了提交。

**已经发出错误提交信息时，下一个提交显式说明它没落**，别默默补上——后人做 `git log` 考古时看到的是那条错的。

**Related:** [[feedback-pass-null-clean-not-self-validating]]（通过性结论不自证）、[[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth]]（提交信息是会撒谎的权威声音）、user-rule `60-evidence-and-criteria` 的 `verified-by-a-wrong-query`。
