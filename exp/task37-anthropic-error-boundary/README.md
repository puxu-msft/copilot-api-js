# Anthropic `error` 帧不是 grammar 意义上的 commit 边界

两个最小探针，用来判定 Task 37 合并态里一处被静默遮蔽的 commit 谓词**是否语义等价**。

- 冻结基线：`638f6f3c898f7562fc086bfb2c5f1f4b04a5b5ad`
- 复跑：`bun run exp/task37-anthropic-error-boundary/probe-classify.ts`、`bun run exp/task37-anthropic-error-boundary/probe-roundtrip.ts`

## 它回答的问题

`src/routes/messages/handler-v4.ts` 传入的外层谓词 `anthropicCommitBoundaries` 被 candidate session 的 grammar 投影覆盖（`driver.ts` 的 `mergeCandidateResponseOpts` 用 `{ ...outer, ...candidate }` 展开，且未把 `commitBoundaries` 列入其后显式重组的五个字段）。问题是：**覆盖它的那份投影，能不能推导出同一个边界集合？**

## 结论

不能。`probe-classify.ts` 的输出：

| 帧 | 外层 `anthropicCommitBoundaries` | `adapter.classify().kind` | 能否进 `completedBoundaryFrames` |
| --- | --- | --- | --- |
| `content_block_stop` | `true` | `unit-close` | 能（grammar 产出 `complete-unit` 时） |
| `error` | `true` | `protocol-error` (`semantic=unexpected-frame`) | **不能**——非 `unit-close`，不可能产出 `complete-unit` |

`probe-roundtrip.ts` 把 adapter 自己 `renderError()` 产出的帧喂回它自己的 `classify()`，同样得到 `unexpected-frame`——**该 adapter 认不出自己写出的错误帧**。

外层谓词的 docstring 明写 `error` 是 commit 边界（spec §5.3 M1，「H2 终态必是 commit 边界」），因此这不是等价替换。附带地，`unexpected-frame` 不在 `isUpstreamFailure`（`candidate-response-session.ts`，只含 `terminal-failure` 与 `adapter-exception`）里，所以 `sawUpstreamError` 也不因该帧触发。

## 它**没有**证明什么

**这一节是必填项，别跳过。** 探针只调用了 `adapter.classify` / `adapter.renderError` 两个纯函数，因此：

- **没有证明生产环境真的会收到 Anthropic `error` 帧。** 帧形状取自本仓 `anthropicErrorFrame` 的产出，是「本系统自己会写出这种帧」的证据，不是「上游 GHC 会发来这种帧」的证据。后者要抓真实上游字节才能定。
- **没有证明客户端可观察行为发生了改变。** 探针停在分类层，没有走 driver 的 buffered 循环，因此**没有**回答「少一个 commit 边界会让客户端多收/少收/晚收哪些字节」。要断言用户可见影响，必须走真实 HTTP 入口的端到端用例。
- **没有证明这是本轮引入的回归。** 探针只测了 `638f6f3c` 一个点，没有与 Task 3 之前的行为做 A/B 对照。「外层谓词曾经生效」目前的依据是那行代码上方的注释（`candidate session ... must not shadow this outer gate`）与冻结计划的措辞，属于意图证据，不是行为实测。
- **没有覆盖其他 protocol。** 只测了 Anthropic adapter。`deliveryMode: "unit"` 的还有 Responses/HTTP（`adapters/responses.ts`，`transport === "http"` 时），其 handler 是否也传外层 `commitBoundaries`、是否也存在同型分歧，**未测**。
- **没有对照正样本。** 没有构造「adapter 补上 `error` 分支后该表如何变化」的对照——修复方案的有效性尚未被这两个探针验证。
