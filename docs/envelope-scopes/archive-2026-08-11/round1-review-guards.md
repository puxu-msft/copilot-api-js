# Envelope scopes 守卫独立验收

对象：`69bea99787ae1d6e64ff4f417f5f00f0d463ae61`；判定：存在 1 个 blocker、1 个 major。

| 守卫 | 独立判定 |
|---|---|
| `config-snapshot.unit.test.ts` | Blocker：新题目不能覆盖旧的“某 codec 手抄 builder 漏掉 request 配置钉定”。 |
| `candidate-state.unit.test.ts` | `body` 的 `not.toBe` 与 request 按引用共享均为契约必然结果；Major：缺少“产出 fork 后再改源 body 不污染既有 candidate”的直接守卫。 |
| `openai-cc-codec.it.test.ts` | 有效：`writeAttempt` 同一 envelope 且原句柄可见的可变契约。 |
| `client-inbound.unit.test.ts` | 有效：hook 收到 live body，`undefined` 返回后的就地写入到达 wire。 |

## Blocker：共享 factory 守卫可被不同命名的本地 builder 绕过

- 违反项：提交说明第 5 项取消 `translationConfigSnapshot` 专用钉子的前提，是所有 codec 只经共享 `makeEnvelope` 完整携带 request scope；`69bea997:src/lib/pipeline/envelope.ts:94-100` 明定该 pin 的请求期生命期。
- 最小反例：在隔离树把 `openai-cc` 的调用改为本地 `buildEnvelope`，并在该 builder 删除 `request.translationConfigSnapshot`；该缺陷保持类型正确，却不是测试所查的字面 `function makeEnvelope(`。
- 实测：`bun test tests/pipeline/semantic/config-snapshot.unit.test.ts` 为 `9 pass, 0 fail`，随后 `bun run typecheck` 退出 `0`；故当前 `tests/pipeline/semantic/config-snapshot.unit.test.ts:92-106` 对旧失效的判别力为零。
- 对照：把 import 改名并重新声明名为 `makeEnvelope` 的本地转发器时测试确实红，证明它只守住特定拼写，非“不得自建 builder”契约。
- 建议交给 implementer：用可解析的 import/call-site oracle，或以真实四 codec parse 后的同一 `translationConfigSnapshot` 身份与热重载隔离为行为 oracle；不得只扩大字符串黑名单。

## Major：candidate body 的 post-fork 源对象污染没有直接回归守卫

- 必然部分：`69bea997:src/lib/pipeline/generation/candidate-state.ts:72-74` 为每个 candidate clone body；把它改成共享 `generationBody` 后，`tests/pipeline/candidate-state.unit.test.ts:72` 两处 `not.toBe` 都按预期红，恢复后 `4 pass, 0 fail`。
- 缺口：该文件唯一的源变异发生在 factory 建立后、第一次 `fork()` 前（`:65`）；它没有先 `fork()` 取得 candidate，再原地修改 `env.attempt.body` 的嵌套成员并断言已有 candidate 不变。
- 因而删除旧 requestState 深拷贝断言本身符合“request 按引用共享”的新契约，但同时删掉了唯一接近 source→fork 隔离的行为场景；全仓检索只找到上述 pre-fork 样本。
- 建议交给 implementer：补一个 body 嵌套对象的 post-fork mutation 样本；它应只守 attempt/candidate 隔离，不得错误要求 request scope 不共享。

## 已运行的独立证据

`bun test tests/pipeline/semantic/config-snapshot.unit.test.ts tests/pipeline/candidate-state.unit.test.ts tests/openai/openai-cc-codec.it.test.ts tests/pipeline/hooks/client-inbound.unit.test.ts tests/pipeline/owns-sink-two-racer.unit.test.ts`：`29 pass, 0 fail`。在 `/home/xp/src/copilot-api-js/.worktrees/verify-envelope-scopes` 对有效守卫做变异并逐次反向精确 patch 恢复：candidate 共享 body、`writeAttempt` copy-on-write/丢写、以及 `client.inbound` defensive clone 均红且失败来自目标断言，恢复后均绿。缺 `attempt` 的 racer 假体复现输出 `{"kind":"stream-error","source":"codec-render"}`；`response-processor.ts:236` 的访问异常被 `:284-285` 包装为 codec-render，非上游流错误，故补齐假体是正确修复而非掩盖真实错误分类缺陷。
