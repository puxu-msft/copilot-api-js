# Kick-off：Commit 3 —— Producer builders、LegHandle 数据流与 publish harness

<!-- prompt-task-ids: T3.1 T3.2 T3.3 T3.4 T3.5 T3.6 T3.7 -->

## 背景 + 为什么

Commit 3 把各 format builders/classifiers、LegHandle 数据流、terminal 可表达性与 publish harness 备好，但所有 helper 仍不可被 production roots 调用。C4 需要完整调查证据；本 phase 只是为其准备最小子集与明确 owner。

## 必读

- `../design.md`：§3.4/§3.6、§5、§7.6、§9.3、§9.4、§10.1。
- `../cutover-plan.md`：Commit 3、Commit 4 preflight、§0.4e mutation protocol。
- `../traceability.md`：调查缝 #1～#8 与 T3.*。
- progress 文件与 `README.md`。

## 前置/停点

- Commit 2 已收口；准备期旧 API population/属性快照仍相等。
- 到 kickoff 先读证据槽；没有 `file:line` 或 PoC，交付已完成部分与具体缺口，结束本轮，**不编签名**。
- #6 已裁，才能使用 T1.6 的 terminal result 形状。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| `beginLeg` sites | `src/lib/pipeline/driver.ts:885,1014,1102,1521,1579` | 5 sites；kind 固定，不是 60 格笛卡尔积 |
| profile gate | `src/lib/pipeline/driver.ts:883-885` | R-14 provenance 前提 |
| anchor builders | `src/lib/anthropic/keepalive-anchor.ts:155,164,173,186,207,232` | 复用 pure algorithm core |
| reconciler | `src/lib/anthropic/live-reconcile.ts:90,138` | 退化为 decision/transform |
| M1 failure seam | `src/lib/pipeline/delivery/owner-failure.ts:41` → `src/routes/messages/owner-failure-settlement.ts:4` | terminal 正交 axis |

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T3.1 T3.2 T3.3 T3.4 T3.5 T3.6 T3.7 -->

- `T3.1`：真实 vendor bytes/SDK 校准 builders；builder 自洽绿不算 closure。
- `T3.2`：HTTP/WS/terminal 三来源 runtime hit set，分别删各自 effect 的 mutation；不猜 enum。
- `T3.3`：LegHandle **关系覆盖表**，不是 5×3×4；5 site 各 witness、3 kinds/4 scenarios 各覆盖、N/A 带控制流证据、逐 site mutation。
- `T3.4`：producer-to-command helpers 不把 closure symbol 放签名。
- `T3.5`：五类 handler、10 terminal-close、heartbeat mapping 的逐点可表达性；M1 failure disposition 与 terminal result 不混轴。
- `T3.6`：isolated composition publish harness；不泄漏 production。
- `T3.7`：属性快照相等。

## 验收 gate

本 phase 无新增 R 段；R-11/O-6 与共同门按 plan §0.3/§0.4b。Invariant：无 live call-site replacement、无 routing read、无 emit/sample/timer，旧 population 与 C0 相等。

## 提交指引

精确 pathspec、Conventional Commit、无模型署名、绝不 push；进度文件随 phase commit 更新。

## 红线

见 `README.md`。不把 T3 最小子集冒充 C4 完整证据；不以 helper/harness 变成 production shadow path；不重新合并 M1 failure/terminal 两轴。