---
name: methodology-plan-red-green-mutation-prediction-can-be-wrong-verify
description: 计划写的「注释掉某行→测试变红」红绿预测可能错，执行期必须真跑 mutation 验证，别信 plan 自述有牙
metadata: 
  node_type: memory
  type: methodology
  originSessionId: 2d448603-e703-4917-9c68-76e079e8823b
  modified: 2026-07-19T17:46:45.046Z
---

计划（哪怕过了对抗复核）里写的「临时注释掉 X 行 → 测试应变红」这类红绿证据预测**可能是错的**——执行期**必须真跑那个 mutation**确认测试真变红，不能因为 plan 这么写就默认测试有牙。

**Why:** 执行 buffered⊥hedge 守卫测试（plan Task 1.4）时，plan 预测「注释掉 `maybeRunHedgedResponseSink` 的 retryCap 短路（driver.ts:769）→ 测试变红/挂起」。真跑 mutation：测试**仍 1 pass**、没变红。根因：`maybeRunHedgedResponseSink` 有一条更早的前置守卫 `if (!policy?.enabled || !runtime || !binding || !env.stream) return undefined`，而测试用的 `makeBufferedHarness` 不建立 generation binding → `!binding` **首先**短路、retryCap 那行在此 harness **从未被触达**。测试通过是因为 buffered 确实走顺序路径,但它**不隔离** retryCap 短路这个它声称锁定的不变量——是假绿守卫。reviewer 其实早标了「makeBufferedHarness 签名需实测坐实」,但没预见 mutation 不咬。

**How to apply:** 凡 plan 用「注释掉某行→变红」当红绿证据的 task,执行期照做一遍真 mutation:改→跑→确认**真变红且只红该条**→恢复→确认变绿。若 mutation **不咬**(测试仍绿),说明测试对该不变量没牙、被更早的前置条件遮蔽——**别提交假绿测试**(empirical-verification / [[feedback-pass-null-clean-not-self-validating]])。诚实处置:要么改成真能咬的 harness(可能需要建更完整的前置状态,如 binding-present),要么把测试如实降级为 characterization + 注释写清「不隔离 X、被 Y 遮蔽、真正 teeth-ful 测试需 Z」,并把缺口记入 backlog。绝不让测试声称锁定它其实没锁的东西。
