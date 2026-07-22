# Plan-4..7: Responses HTTP / CC 升块级 / Responses WS / 收口

> P4/P5/P6 依赖 P0-P3 的机制;各自门（G4/G5）决定续写覆盖。P7 收口须在对应门 PASS 后翻默认。

---

## P4: Responses HTTP 续写

**依赖:** 门 G5（Responses prior-output 续写形状）。已块级（`isResponsesCommitBoundary`）。
**Files:** Create `src/lib/codec/openai-responses/continuation-builder.ts`;Test `tests/responses/continuation-responses.it.test.ts`。

### Task 4.1: Responses continuation-builder
- [ ] 写失败测试:组装 `input: [...原始, 已done的output_item(canonical→Responses item), {role:user, content:message}]`。
- [ ] 跑失败 → 实现 + `registerContinuationBuilder("openai-responses", ...)` → 跑通过 → 提交 `feat(responses): continuation builder`。
- [ ] **G5 分支:** G5 Responses PASS → 启用;FAIL → builder 返 undefined → partial-degrade（登记 backlog）。

### Task 4.2: Responses ledger 喂养（output_item.done 边界）
- [ ] 写失败测试:每 `output_item.done` 把该 item canonical 快照喂 ledger;partial item 不入账。
- [ ] 实现（driver Responses 提交边界处接 ledger）→ 提交。

### Task 4.3: SDK oracle（@ai-sdk/openai 更宽容，见记忆 responses-buffered-merge）
- [ ] 真 `openai` SDK 消费缝合流断累积;注意官方 SDK 比 @ai-sdk 严（`missing content` 抛错）→ 两者都测。→ 提交。

---

## P5: CC 升块级 + 续写

**依赖:** 门 G4（index 串行性——**先验风险偏高**）+ G5（CC 尾随约束）。
**Files:** Modify `src/lib/openai/cc-commit-boundaries.ts`（terminal-only → 块级);Create `src/lib/codec/openai-cc/continuation-builder.ts`;Test `tests/openai/cc-block-boundaries.unit.test.ts`。

### Task 5.1: CC 块边界重建（G4-gated）
- [ ] **G4 PASS（串行）分支:** 写失败测试——`ccCommitBoundaries` 认「更高 index tool_call 出现 = 前块完成」+ text→tool 过渡 + 末块 finish_reason。
  ```ts
  test("cc boundary: higher tool_call index arriving commits the prior tool_call block", () => { /* ... */ })
  test("cc boundary: text→first tool_call transition is a boundary", () => { /* ... */ })
  test("cc last block only closes at finish_reason (degenerate corner, not a bug)", () => { /* ... */ })
  ```
- [ ] 实现（扩 `cc-commit-boundaries.ts`，保留现有「上游 error 帧」判据）→ 跑通过 → 提交 `feat(cc): promote commit-boundaries to block-level`。
- [ ] **G4 FAIL（交错）分支:** 边界判据改「只在 finish_reason 前的完整 JSON parse 成功点」或**退回 CC terminal-only**（本相位缩减为纯续写、不升块级），登记 backlog。

### Task 5.2: CC continuation-builder（G5-gated 尾随约束）
- [ ] 写失败测试:组装 CC `messages`;**G5 分支** committed 末尾是完整 tool_call 且后续也 tool_call 的窄场景 → builder 返 undefined（partial-degrade);单/纯文本/text+单tool 场景正常续写。
- [ ] 实现 + `registerContinuationBuilder("openai-cc", ...)` → 提交 `feat(cc): continuation builder (trailing-constraint aware)`。

### Task 5.3: CC ledger 喂养 + SDK oracle
- [ ] 块边界处喂 ledger;真 `openai` SDK 消费缝合流断累积。→ 提交。

---

## P6: Responses WS 升块级 + 续写

**依赖:** P4（共用 Responses builder）+ **WS 传输门**（续写重派上游轮 + close-code 时序）。
**Files:** Modify `src/routes/responses/ws.ts`（terminal-only → 块级:接 `isResponsesCommitBoundary` 谓词，移除故意省略);Test `tests/responses/ws-continuation.it.test.ts`。

### Task 6.1: WS 升块级
- [ ] 写失败测试:WS 路径接 `output_item.done` 块级谓词（现 `ws.ts` 故意 omit → 改为传入）。
- [ ] 实现 → 提交 `feat(ws): block-level commit boundaries (reuse responses predicate)`。

### Task 6.2: WS 续写传输时序（承重实现细节）
- [ ] 写失败测试:续写在 WS 长连接上**重新派发上游轮**（新 upstream turn，非同连接续帧）+ `sendErrorAndClose`/1011 close-code 与增量 commit 时序对齐（前 spec §7.3 backlog:300-306 四点）。
- [ ] 实现（WS 续写 = 新上游 turn 结果接同一 WS 下行流）→ 提交 `feat(ws): continuation via re-dispatched upstream turn`。
- [ ] SDK oracle（WS 客户端消费缝合流）→ 提交。

---

## P7: 退役 whole + 默认翻转 + doc-sync + ADR 定稿

**依赖:** 所有门 PASS + P1-P6 绿。**默认翻转必在对应门 PASS 之后**（绝不先翻默认再验证，R4）。

### Task 7.1: 退役 whole-response
- [ ] 写失败测试:`protect_streaming_generation` 不再有 whole 语义;Anthropic 块级不可用回退 live（非 whole）。
- [ ] 改 `schema.ts:637-645` 文档 + 删 whole 兜底路径 + `validation.ts` 跨字段告警文案 → 提交 `refactor(config): retire whole-response buffering (fallback is live)`。

### Task 7.2: 默认翻转（门后）
- [ ] Anthropic `protect_streaming_generation` 默认 → 块级 on（**G1+G2 PASS 后**）;`continuation.enabled` 默认 true（P0 已设，此处确认全格式生效）。
- [ ] 改 `config.yaml` 默认 + `state.ts` CONFIG_MANAGED_DEFAULTS → 提交 `feat(config): default-on block-level anthropic + continuation`。

### Task 7.3: doc-sync + ADR 定稿
- [ ] 前 spec 加「Anthropic 部分由本 spec 完成/取代」注解;`DESIGN.md` 活的架构现状行;`docs/streaming.md`;ADR 状态 Proposed→Accepted。
- [ ] 跨文档 grep 验证（skill `session-closeout`）→ 提交 `docs: sync continuation-retry landed state`。

### Task 7.4: 合并态审查 + 收官
- [ ] whole-branch 对抗审查（异模型，merged-state）;记忆维护;FF 合并回 master（`comm -12` 核 feat 改动∩主树脏=∅，见记忆 remerge）。

---

## 门 → 相位 fallback 映射（回填 README）

| 门 FAIL | 触发的 fallback |
|---|---|
| G1（代理产不出顺序 wire） | P1 需真实现（预期，非 fallback）;若结构上产不出 → Anthropic 回退 live、incident 目标重议 |
| G2（300s 不重置） | Anthropic 长静默场景回退 live;incident 复合场景须换保活载体或与用户重议（spec §3.4） |
| G3（tool_use 前缀被拒） | Anthropic 续写限 committed 非-tool_use-末尾场景（incident 属此，主目标仍达成） |
| G4（CC 交错） | P5 边界判据换 / CC 退回 terminal-only（仅续写不升块级） |
| G5 CC 尾随 / Responses 续写 | 对应窄场景 / 格式回退 partial-degrade，登记 backlog |
