---
name: project-v4-pipeline-rearchitecture
description: v4 P0-P3 + response-pipeline Stage A/B 全部已落地；权威现状看 DESIGN「活的架构现状」+ docs/archive/2606-landed-rfcs
metadata:
  node_type: memory
  type: project
---

**v4 模型请求管线重构（七阶段 driver+codec+transport）+ response-pipeline RFC Stage A/B 全部已落地。** 权威现状永远看 `docs/DESIGN.md`「活的架构现状」表 + 设计 `docs/archive/2606-landed-rfcs/response-pipeline/`（design/stage-a-plan/stage-b-plan/finalize-stream-redesign）。

要点（仅指针）：薄信封 IR（守 Anthropic 直连字节无损）；event bus 已存在（`src/lib/observability/`），重构=提升编排+下沉数据采集；错误驱动重试；改写注册式 transform（order 键契约）。**Stage A**=激活 transform registry 把改写迁进 driver S3/S5（非流式经 `transformWhole` 统一、Responses fixStreamEventIds 纳入 S5）。**Stage B**=driver-owned writeout 全 5 格式 owns-sink（`ResponseOutcome` 三态、forwarded 采样/heartbeat 统一进 driver）。B4 finalize 重设计评估后驳回（过度设计，见 finalize-stream-redesign.md）。**剩余未收敛**：web_search 双跳 `[bypass]`（`handler.ts` 非流式）待迁 driver 收敛。关联 [[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]]、skill `large-refactor`。
