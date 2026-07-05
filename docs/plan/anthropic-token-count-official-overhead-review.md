# 对抗式审查结论：auto-truncate messages[0] 非法修复计划

> **类型**：对抗性审查报告（文件名错配）—— 本文实际审查的是 **auto-truncate messages[0] 非法修复** 方案，与同 codename 的 [anthropic-token-count-official-overhead.md](anthropic-token-count-official-overhead.md)（token 计数，未实施）**无关**。非独立 plan。

只读核验，不改任何文件。结论汇总在末尾。

## 核验数据
- history DB：116 条全 completed，0 条 messages.0/system 错误样本（出错记录已被 reaper 轮换掉，无法回放复现 400）。
- 116 条真实请求 messages[0] 全是 `user[text,...]`，其中 115 条含中间 system 角色消息 → **佐证"上游接受中间 system，只拒 messages[0]=system"**。
- Anthropic 官方文档对"首条必须 user""tool_result 必须配对"保持沉默——`messages.0: use the top-level 'system' parameter` 是 Copilot 上游特定校验，非 Anthropic 标准。

## 逐点结论

### 1. 强化 ensure 判定边界 —— ✅ 正确（含一处需补测）
- (a)/(d) **✅ 推理成立**：tool_result 的配对 tool_use 在 assistant 中，协议上必在其前。若该 assistant 在 preserve 窗口内 → user 非 msg0；若被切掉 → tool_result 必孤儿。故"messages[0]=user 含 tool_result ⇒ 必孤儿"成立。无法发真实探针复现 400（无样本、不启服务器），但这是纯协议演绎，不依赖实测。
- (b) **✅ 不误杀混合**：探针 S7 证实 `user[orphan tool_result, text]` 不被 ensure 跳过（非 all-TR），processToolBlocks 删孤儿 tr 后剩 `user[text]`，msg0 合法。
- (c) **✅ string content user 保留正确**：tool-utils.ts:54 现状只比 role，强化后需显式 `typeof content==="string" → break`。
- ⚠️ **判定不等价但安全**：强化 ensure 用"块全是 tool_result"近似"孤儿"，不查配对。安全前提是 ensure **只作前导扫描、遇合法 user 即 break**（while+break）。中间合法 `user[tool_result]`（配对完整）永不是 msg0（其 assistant 在前），故不会误杀。**务必保留 break 语义，不可改成全局过滤。**
- ⚠️ **补测**：现有 message-sanitizer.it.test.ts:579 只测"跳 assistant"，无"跳纯 tool_result user""保留混合 user""保留 string user"用例。强化必须同步加这三个边界测试，否则回归无守卫。

### 2. 收敛循环终止性 + 真修 ping-pong —— ✅ 终止，⚠️ 非根治（兜底有效）
- (a) **✅ 必终止**：processToolBlocks 与强化 ensure 都只删不增 → length 单调非增。do-while 以 `length !== prev` 判停，单调有界 → 必停。不存在"length 不变但内容仍变"死循环：唯一"改内容不改 length"的是 processToolBlocks 对 assistant 的 name-fix/input-decode，但那是幂等的（第二轮 needsNameFix/needsInputFix 均 false），不会无限改。
- (b) **✅ 收敛到合法 msg0**：探针 S1 `[user(orphan tr), assistant(text), user(text)]` → 2 轮 → `user[text]`，msg0 合法。
- (c) **⚠️ 与 OpenAI 不等价但功能等价**：OpenAI 用 `filterOrphanedToolResults+filterOrphanedToolUse`，Anthropic 用 `processToolBlocks`（内部已含双向孤儿过滤 + name-fix + input-decode），二者过滤效果等价。processToolBlocks 的额外副作用（name-fix/input-decode）幂等，不破坏循环稳定性。
- ⚠️ **非根治，多删合法对**：探针 S5 `[assistant(tool_use p1), user(tool_result p1 配对完整), user(text)]` → 强化 ensure 跳开头 assistant 后，配对的 user[tool_result p1] 因 tool_use 被 slice 而变孤儿被删 → 只剩 `user[text]`。**一对配对完整的 tool_use/tool_result 被无谓丢弃**。结果仍合法，但说明 cleanup 层治标——靠 length 单调兜住，而非从源头避免孤儿。

### 3. processToolBlocks 反复调用副作用 —— ✅ 安全
- (a) **✅ 幂等**：name-fix（correctName===block.name 时 no-op）、input-decode（已是 object 时 typeof!=="string" no-op）第二轮均无操作。
- (b)/(c) **✅ immutable thinking 不导致卡死**：isImmutableThinkingMessage 仅作用于 **assistant**（thinking 块只在 assistant）。探针 C：`[immutable thinking-only assistant, user(text)]` → ensure 的 slice **不依赖删除**即可跳过开头 immutable assistant → 剩 user(text)。immutable assistant 永不会作为 msg0 残留（ensure slice 总能越过它）。探针 B：immutable assistant 后仅配对 tool_result → 收敛到空 len=0（触发 preserved.length===0 兜底）。**无"length 稳定但 msg0 非法"残留。**

### 4. 最终守卫必要性 + 正确性 —— ⚠️ 冗余但无害；降级是真问题但可接受
- 若收敛循环已正确，方案3"返回前再断言 + 再清"在已验证场景下**冗余**（循环已保证 msg0 合法或为空）。但作为**深度防御**可接受——成本低，且能兜住未来 processToolBlocks 行为变化。建议守卫逻辑直接复用同一个收敛 cleanup，不要另写一套并行逻辑（避免两套判定漂移）。
- ⚠️ **"全工具回合返回 wasTruncated=false"是真实降级**：此时原请求超长，strategy abort 后**上游仍会 400（context 超限，非 messages.0）**。这是**从"messages.0 非法 400"降级为"context-length 400"**——错误类型变了但请求仍失败。**这是可接受的降级**（至少不再 ping-pong 重试耗尽配额），但应在文档中明确："极端全工具回合无法安全截断，会以 context-length 错误透传给客户端，而非静默成功"。现状代码 auto-truncate.ts:262-271 已有 `preserved.length===0 → wasTruncated=false` 路径，方案3 与之一致。

### 5. 修复层：cleanup 收敛 vs binary-search 干净边界 —— ⚠️ cleanup 是治标层，binary-search 才是根治层
- **findOptimalPreserveIndex（truncation.ts:186 / OpenAI:119）是纯 token 二分，完全不对齐 tool/turn 边界**。preserveIndex 落在 tool_use↔tool_result 之间 → 产生孤儿 → 才需要 cleanup 收尾。
- **根治方案**：二分得到 left 后，向后推进 preserveIndex 到下一个"干净边界"（即 `messages[preserveIndex]` 是 role==="user" 且首块非 tool_result，或简单地 role==="user" 且非 all-tool_result）。这样根本不产生开头孤儿，cleanup 只需处理被切断的尾部 tool_use（assistant 末尾孤儿 tool_use），强化 ensure 与守卫都不再必要。
- **评估**：计划选的 **cleanup 层是"对的兜底层但不是最根治层"**。binary-search 对齐边界能消除孤儿产生源（探针 S5 的"无谓多删配对"也随之消失）。**但 cleanup 收敛是正确且必要的兜底**——即便对齐边界，preserve 尾部仍可能有 assistant 孤儿 tool_use 需 cleanup。
- **建议**：两层都做最稳妥——binary-search 对齐 user 边界（消除孤儿源 + 避免多删）+ cleanup 收敛（兜底尾部孤儿）。若只做一层，cleanup 收敛能保证正确性（不会发非法 msg0），但会有探针 S5 的"多删一对配对"轻微浪费。**计划只在 cleanup 层修，功能正确，但放弃了在源头避免孤儿的机会——这违反 CLAUDE.md 原则8"修根因而非症状"的精神。** 强烈建议在 findOptimalPreserveIndex 增加边界对齐。

### 6. OpenAI 侧是否同 bug —— ✅ 计划"OpenAI 已对"正确，不乐观
- **结构差异是根因**：OpenAI Message.content 类型（openai-chat-completions.ts:64-65）只允许 string | TextPart | ImagePart，**user 消息结构上不可能含 tool_result**；tool result 是独立 `role:"tool"` 消息（tool_call_id 在消息层）。
- `filterOpenAIOrphanedToolResults` **整条删除**孤儿 tool 消息，`ensureOpenAIStartsWithUser` 跳非 user 即可——不存在"user 消息本身是孤儿 tool 结果"形态。
- **Anthropic 的 bug 独有**：tool_result 嵌进 user 消息，ensure 跳"非 user"却放过"内容非法的 user"。**OpenAI 无此结构性漏洞，计划判断准确。**

## 最终裁决

| 点 | 判定 | 要点 |
|---|---|---|
| 1 判定边界 | ✅（补测） | 推理成立、不误杀；必须保留 break 前导语义；补 3 个边界测试 |
| 2 收敛终止 | ✅ / ⚠️ | 必终止、真收敛到合法 msg0；但 S5 会多删配对（治标） |
| 3 反复副作用 | ✅ | 幂等；immutable 仅 assistant，ensure slice 总能越过，不卡死 |
| 4 最终守卫 | ⚠️ | 冗余但无害深度防御；全工具回合降级为 context-length 400 需文档化；守卫复用收敛逻辑 |
| 5 修复层 | ⚠️ | cleanup 是对的兜底层但非根治层；**强烈建议 binary-search 对齐 user 边界消除孤儿源** |
| 6 OpenAI | ✅ | 结构差异致 OpenAI 无此 bug，判断准确 |

**无致命缺陷**：方案功能正确，不会发非法 msg0，循环必终止，不误杀合法消息。

**两个改进点（非阻断）**：
1. **修复层不彻底**（点5）：只在 cleanup 兜底，未在 findOptimalPreserveIndex 源头对齐边界 → 仍产生孤儿再清理，且多删配对对。按原则8 应同时在 binary-search 对齐 user 边界。
2. **降级语义需文档化**（点4）：全工具回合 wasTruncated=false → 上游仍 400（context-length），非静默成功。按原则5 暂缓项应完整文档化。

**必须补的测试**（点1）：ensureAnthropicStartsWithUser 强化后需加"跳纯 tool_result user""保留混合 user[tool_result,text]""保留 string user"用例 + cleanupMessages 收敛的 S1/S5 端到端用例。
