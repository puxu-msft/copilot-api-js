---
name: project-telemetry-tiered-storage
description: 遥测分层持久化大特性(独立 telemetry.db + DDSketch + 全可配)——P0-P2 已 landed、P3-P7 待做、两个承重坑
metadata: 
  node_type: memory
  type: project
  originSessionId: 7654802f-e457-41c1-918b-47b2995359ac
---

遥测从单 27MB JSON 迁到独立 `telemetry.db`(SQLite 三层 rollup raw5min/hourly/daily + 终身累计 + DDSketch 分布 + 全可配 `telemetry.*`)。源起本会话「proxy 可观测性如何」体检——发现遥测无配置面、JSON 不可扩展、硬顶 7d(但聚合准确、对账逐字节吻合)。定位=**纯聚合层**,行级明细委托已无限保留的 History DB。

**权威**:spec `docs/spec/2026-07-13-telemetry-tiered-storage.md`(2 轮 review:2 BLOCKER+6 HIGH)、plan `docs/plan/telemetry-tiered-storage/`(1 轮 review:3 HIGH,含「评审采纳修订」节)、PoC `exp/telemetry-storage/CONCLUSIONS.md`(4 项双 runtime 全绿)。隔离 worktree `.worktrees/telemetry-storage/` @ 分支 `feat/telemetry-tiered-storage`。

**进度(2026-07-13)**:P0 sketch 封装 ✅ / P1 schema+dictionary+paths ✅ / P2 config 5 触点全接线 ✅(653 test 绿,11 提交)。**P3 写路径(store.upsert+加性双写)→ P4 rollup → P5 读路径逐字节兼容 → P6 backfill → P7 SSOT** 待做。续用 `prompts/kickoff.md`。

**承重红线**(Global Constraints,plan 详):cost 用 **scaled-int micro**(`round(cost*1e6)`,绝不 STRICT INTEGER 存 REAL——PoC 证抛异常;micro 非 nano 防永久 cumulative 撞 2^53);**SQLite 只存 DDSketch**、`/metrics` 用进程内固定桶(不读 SQLite)、`/api/stats` 持久窗返 sketch 分位;**P3 加性双写**(保内存路径 + persist_interval flush 到 SQLite,读路径 P5 才翻转)防半坏中间态;DDSketch **手动 DenseStore 序列化**(保 min/max)绝不 protobuf;双轨计数(进程内归零 + 持久 cumulative)。

**两个承重坑**:
1. **GPT 异模型 review roster infra-broken**——三底座全挂:`gpt-souls:*`=`model_not_supported`、`gpt-second-opinion`/`gpt-5-5`=`Invalid 'user': string too long (150>64)`(harness 把过长串传 OpenAI `user` 元字段)。异模型对抗视角这轮拿不到,已用「自扮 GPT reviewer」补位(采纳序列化自描述 magic+version 加固)。**修 harness 前 GPT agent 不可用**。
2. **sketch.ts 依赖 DDSketch 私有字段** `_multiplier` / `store.{bins,offset,minKey,maxKey}`(不在 `@datadog/sketches-js` 2.1.1 的 .d.ts,靠 `MappingInternals` 断言存取)——bit-exact 序列化必需(否则 ra↔γ 反解 ~1e-13 噪声),**升级 sketches-js 版本须复验私有字段稳定性**。

**Related**: [[reference-undici-websocket-runtime-split-bun-vs-node]](runtime-split 同类)、[[feedback-config-philosophy-separate-compat-and-warn-continue]](config warn-continue,P2 已遵)、[[feedback-verify-ui-with-build-not-just-typecheck]](P7 SSOT 收敛须跑 typecheck:ui-v4+build:ui-v4)。
