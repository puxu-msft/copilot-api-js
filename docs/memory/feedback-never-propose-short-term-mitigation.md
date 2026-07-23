---
name: feedback-never-propose-short-term-mitigation
description: 本项目绝不做/绝不推荐短期止血方案；「打开一个默认关闭的现成功能来绕过」也算短期将就、同样禁止
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40f4cfdd-1039-4814-bdb6-c7ce1b1813be
---

**在本项目，遇到有根因可修的缺陷，绝不提「短期方案 / 快速止血」作为推荐或选项——包括「打开一个已存在但默认关闭的 gated feature 来绕过」。** 即便那个开关就在手边、功能已 merge，启用它来回避根因也是短期将就。

**Why**：项目哲学是「长远正确 + 完整 > 最小能交付」（CLAUDE.md `long-term-wins` / `against-yagni`）。gated feature 有它**自己的正式进度轨道和翻默认门禁**（如 buffered-retry 的 P0-P4 + 真 CLI/scenario-B 前门），在一个 debugging 语境里草率打开它当解法，既绕过了该功能的验收门、又把注意力从真正该修的根因引开。

**How to apply**：分析事故给建议时，只提**修根因**的路径；不要把「enable 某 flag / 打开某默认关闭功能」列为选项或推荐。若某功能确实是正解但尚未到翻默认阶段，指向它自己的进度轨道，别在此处顺手翻。实例（2026-07-14）：gpt-5.6-sol NGHTTP2_CANCEL 尾部砍断事故，我把「打开 `protect_streaming_generation` buffered retry(默认OFF)」当选项 (a) 推荐 → 用户否决「绝不做短期方案」，只做根因项 (b) 修 `logUpstreamStreamError` 的 `frames=0` 观测缺陷。反面是 [[feedback-slam-dunk-fixes-do-immediately]]（无取舍无分叉的根因改进当场做）。
