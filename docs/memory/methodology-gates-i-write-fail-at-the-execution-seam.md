---
name: methodology-gates-i-write-fail-at-the-execution-seam
description: 写门禁／顺序前置／评审或清理放行时，门写了却没有东西会执行它——九形态与四问已扶正为 user-level skill `making-a-gate-actually-fire`，本文只留触发钩子与本仓实例
metadata:
  type: methodology
---

**方法已下沉，本文是 stub。** 权威分两处，别搞混：

- **九种形态**（裁决点不可达 / 自证空结果 / 评审无 oracle / 判定了没回路 / 按对象类型分叉 / 不可逆动作 fail-open / 顺序写反 / 声明单源实际双判 / 无边界+入列前自评过滤）、**四问诊断**、以及**跨项目通用的实证** —— 权威在 user-level skill **`making-a-gate-actually-fire`**（2026-08-09 扶正）。**本仓专有的实例留在本文下方**，不进通用 skill。
- **工具调用里那条最低约束**（`&&` 是门、换行与 `;` 不是、管道看 `pipefail`、退出码不得来自计数器/过滤器、不可逆动作要单独跑一次）—— 权威在 user-rule **`63-engineering-practice` 的 `batching-can-silently-remove-a-gate`**，因为它必须在**没打开 skill 时**也成立。skill 那节是它的展开。

**触发钩子**（skill 万一没浮现，这行是唯一兜底）：**我写下了一道门，但真到执行那一刻，有东西会去执行它吗？** 判否之后回到哪一步？评审看得见事实还是只看得见我的自述？空清单是真没有还是漏了？

## 本仓实例（留在这里，不进通用 skill）

- **首跑就咬到作者本人**：新写的「必须交出事件源 + 双向对账」条款，作者交出 transcript 后 reviewer 独立枚举，发现作者只列了 2 项候选，漏掉同一会话里被逐条打回的**一整批**——**伪「两轴」、不可达裁决点、自证空清单、过严 clean gate、先删后审、缺回流、无 oracle**，而它们正是作者自己刚写下的那两类的教科书样本。**作者对自己刚犯的错最没有距离感。**
- **而且咬了两次**：补成 10 项后再对账，reviewer 又指出仍漏两格，并证否了作者「某两类无新增」的自称——**第 4 类实际新增了 job tmp 的人口口径与 `fd` 枚举陷阱**（`fd` 默认遵守 `.gitignore`，会少报），**第 6 类的多组 Git／GNU patch 探针直接驱动了裁决**。**两次都是「我以为已经列全了」** → 双向对账不是一次性仪式，补全后要再对一次，直到 diff 为空。
- 该批条款出自 2026-08-08 的项目 skill `session-closeout` §3b/§4，被独立 reviewer 连打六轮（2 blocker、十余 major）。该 skill 同日并入 user-level `closing-a-development-session` 并删除，条款已迁入其 `source.json` 的 §2／§5 与 `discover_nonfile_candidates` stage。

**Related:** [[methodology-ordering-gate-needs-a-trigger-that-reads-it]]（顺序前置的分型判据）、[[methodology-downgrading-a-gate-needs-a-reachable-trigger]]（降级自评闸门同样要有可达触发点）、[[feedback-pass-null-clean-not-self-validating]]（通过性结论不自证）。
