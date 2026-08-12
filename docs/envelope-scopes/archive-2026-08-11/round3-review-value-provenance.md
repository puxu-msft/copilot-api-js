# RequestEnvelope 作用域取值语义评审（round 3）

- 评审范围：`55d9d934` 的最终生产代码；以 `69bea997^` 为语义基准，逐 hunk 对照 `69bea997` 的扁平字段读取到三作用域读取的映射，重点覆盖四个 codec、`cell-assembly.ts`、`driver.ts`、四个 `handler-v4.ts` 与 `*-leg.ts`/`*-cell.ts`。
- 已读取／执行的证据：CodeGraph 两次定位定义与调用链；`git diff --find-renames --unified=4 69bea997^ 69bea997 -- src` 的所有含旧 `env.*`/`requestState` 读取 hunk；`rg` 全仓枚举 `truncateBaseline`、resolved/raw model、candidate holder、`request.clientFormat`/`request.stream`/`attempt.targetEndpoint` 读取及所有 scope mutation；复核 `69bea997..55d9d934` 的后续相关提交。
- 总体 verdict：可进入下一阶段。
- blocker 数量：0；major 数量：0。

## 事实性发现

未发现 blocker 或 major。

## 可核验断言结论

- C1 已确认：`rg -n 'env\.(request|attempt)\.truncateBaseline|\.request\.truncateBaseline' src --glob '*.ts'` 的所有读取都在 `src/lib/codec/anthropic/anthropic-cell.ts:70,158`、`src/lib/codec/cc-family-strategies.ts:59`、`src/routes/messages/handler-v4.ts:1226`，均从 `env.request.truncateBaseline` 取固定基线；唯一写入是 Gemini S1b 的 `src/lib/codec/gemini/codec.ts:254`。这些站点把 `env.attempt.body` 仅作为“基线不存在时”或“当前待派发 payload”的明确 fallback，未把它当 baseline。
- C2 已确认：所有 `modelIdFor` 调用均以 `env.request.model` 为已解析模型的第一来源，并只以 `env.attempt.body.model` 作无 resolved model 时的 raw-string fallback，例如 `src/lib/codec/anthropic/codec.ts:189,377`、`src/lib/codec/openai-cc/codec.ts:200`、`src/lib/codec/openai-responses/codec.ts:204,264`。wire preparation、strategy 与 model capability 读取 `env.request.model`；当前 payload / history / renderer 中需要 wire 上实际字符串的读取保留 `env.attempt.body.model`，与改前 `env.model` / `env.body.model` 的双源语义一致。
- C3 已确认：candidate-only holders 的全部实际读取集中在 `src/lib/codec/anthropic/anthropic-cell.ts:65,73,122,154,159,162`、`src/lib/codec/openai-cc/openai-cc-cell.ts:68`、`src/lib/codec/openai-responses/codec.ts:244` 与 `src/routes/responses/candidate-response-session.ts:107`。`src/lib/pipeline/generation/candidate-state.ts:50-78` 为每个 candidate 新建 holder 与 body/hints，`src/lib/pipeline/driver.ts:699-710` 再以当前 attempt 的深拷贝 fork；request 仅在 `src/lib/pipeline/envelope.ts:233-235` 按引用共享。没有发现把 candidate holder 放到 request 或把 request truth 当 candidate-local 值读取的站点。
- C4 已判定的可疑形态：`src/lib/codec/cc-family-strategies.ts:59` 的 `request.truncateBaseline ?? attempt.body` 是刻意保留改前 fallback，并按 client format 选择与 retry strategy 相同的 payload shape；`src/lib/pipeline/driver.ts:703-710` 看似没有采用 factory 的 generation snapshot，实际必须从“当前” attempt 延续已接受 retry，且随后 clone 防 hedge aliasing；上述两处均未构成语义错位。

## 主观建议

无。本轮只报告 blocker 与 major，未把非阻断性测试扩展建议列为发现。
