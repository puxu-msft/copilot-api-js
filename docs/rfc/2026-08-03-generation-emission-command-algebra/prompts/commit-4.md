# Kick-off：Commit 4 —— 原子发布全部 generation authority

<!-- prompt-task-ids: T4.0a T4.0b T4.0c T4.0d T4.1 T4.2 T4.3 T4.4 T4.5 T4.6 T4.7 T4.8 T4.9 T4.10 T4.11 T4.12 T4.13 T4.14 T4.15 T4.16 -->

## 背景 + 为什么

这是唯一 authority publish semantic commit。raw authority、全部 producer、terminal、heartbeat、WS control 同一 commit 切换；不能先收 raw 后迁 producer，不能 `legacy_adapted`，不能 new command 回落旧 writer。task 划分是施工顺序，**不是发布粒度**。

## 必读

- `../design.md`：§2、§3、§4、§5、§7.7、§7.13、§9.2 Q5、§9.3、§10.1/§10.2。
- `../cutover-plan.md`：Commit 4 完整段、§0.3/§0.4b/§0.4e、§11 #6。
- `../traceability.md`：R-1～R-8/R-12/R-14、O-1/O-2/O-4/O-8、调查缝。
- progress 文件与 `README.md`。

## 前置/停点

1. Q5 逐帧预测 diff 已审，超出预测即停。
2. `T4.0a`～`T4.0d` 补齐 §9.3 #1/#2/#5/#8；没有 file:line 或 PoC，结束本轮，**不生成猜测签名**。
3. A/B/C/D closure 输出未漂。
4. §11 #6 已裁；未裁不得进入 terminal migration。
5. 此 commit 的合成/production mutations 按 plan §0.4e，不能在 entry tree 做破坏性恢复。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| sink construction | `src/lib/pipeline/client-sink.ts:494,696` | raw/delivery composition |
| Anthropic composition | `src/routes/messages/handler-v4.ts:574,658,1124,1192` | 8 constructs + 2 wiring；单请求不可建两 owner |
| WS owner root | `src/routes/responses/ws.ts:358` | WS operation boundary |
| raw sends | `src/lib/pipeline/client-sink.ts:209,645` | handle-level recorder 深度 |
| terminal close | `src/routes/messages/handler-v4.ts:702,1464,1584,1623,1688,1808,1848,1893`; `src/lib/pipeline/driver.ts:1436,1611` | 10 terminal decisions |
| legacy C lookup | `src/lib/pipeline/delivery/session.ts:90,95,100` | lookup/constructor 收口 |

完整表以 plan Commit 4 为准。

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T4.0a T4.0b T4.0c T4.0d T4.1 T4.2 T4.3 T4.4 T4.5 T4.6 T4.7 T4.8 T4.9 T4.10 T4.11 T4.12 T4.13 T4.14 T4.15 T4.16 -->

按 plan Commit 4 逐 task 执行，不复制判据细节：

- `T4.0a/b/c/d`：完整调查 slots，分别为 composition export/port、WS typed result/close intent、registration mutation insertion、raw test entrypoint。
- `T4.1`：Q5 diff 停门。
- `T4.2/3`：8 sink construct + 2 Anthropic wiring、private raw/handle supply。
- `T4.4/5/6/7/8/9`：common/indexed/LegHandle/compound/heartbeat/cardinality authority。
- `T4.10/11`：terminal/finalize 与 WS control-with-inflight；每 handler/site mutation，不以 A 集归零替代。
- `T4.12/13/14/15/16`：C/D 收口、non-Anthropic winner provenance、独立 transfer oracle、test/guard migration、O-1/O-2/SDK 后 golden。

## 验收 gate

R-1～R-8、R-12、R-14、O-1/O-2/O-4 targeted/O-8、R-11/O-6。O-6 byte-critical；共同门与树向绑定按 plan §0.3/§0.4b。所有 handler/site mutation、production registration collision、shared predicate mutation 必须按 RFC §10.2 原 oracle 跑。

## 提交指引

**一个 semantic commit，不拆 authority publish。** Commit 4 progress 文件逐 task 更新可单独提交（docs/tmp，避免中断即全丢），但不得将 production authority 拆成多 commit。精确 pathspec、Conventional Commit、无署名、绝不 push。

## 红线

见 `README.md`。不发布部分 authority、不使用 payload guessing facade、不让 new command 回落旧 writer、不现场编签名、不碰 4141。