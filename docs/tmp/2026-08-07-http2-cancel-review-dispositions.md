# HTTP/2 CANCEL spec/plan 评审处置

- 评审范围：`995c1047..399bb802`
- 首轮 reviewer：异模型对抗审
- 状态：首轮 12/12 findings 已采纳并完成核心重写，等待新一轮完整评审
- test-only peer CANCEL oracle：`node $CLAUDE_JOB_DIR/tmp/probe-peer-cancel-oracle.mjs` 的 `handle-rst-cancel` 变体实测客户端 `end/close rstCode=8`；公共 `stream.close(CANCEL)` 为 `rstCode=0`，`stream.destroy(error)` 为 `rstCode=2`。

| ID | 级别 | 发现 | 处置 | 证据与理由 |
|---|---|---|---|---|
| R1 | C | first-writer local intent 不能证明 wire 上真实发起方 | 采纳 | peer RST 可已到 socket但 JS listener 尚未运行；随后 local cleanup 先写 local。单一来源会过度声称。改为 additive evidence；local+peer/session 并存派生 `ambiguous`。 |
| R2 | C | stream unknown 首写会吞后到 session evidence | 采纳 | `http2-client` 的 stream/session event 次序没有提供全序保证。`unknown` 改为 quiescence 后无结构证据的派生 attribution，不作为 evidence；session evidence可追加。 |
| R3 | C | Node JSON→纯 classifier 没覆盖 production wiring | 采纳 | 当前 Bun 测试已明确 RST可能塌缩为 clean end（`tests/transport/http2-client.it.test.ts:162-171`）。改为显式 Node test server只产生 wire CANCEL=8，Bun测试进程直接调用 production `http2Fetch` + `onTerminationEvidence`，覆盖事件提取/callback。 |
| R4 | C | 只改 disposeDispatch 漏 scheduler.settle | 采纳 | `src/lib/pipeline/generation/dispatch-scheduler.ts:324-331` 的正常 settle 直接 `recordSettlement`。两条路径统一用 `settlementWithTermination()`，都在 `quiesced` 后取 accessor。 |
| R5 | C | 一等 canonical 字段的必要性 claim 过强 | 采纳 | typed diagnostic/settlement extension也可闭合但类型约束弱。保留一等字段作为长期类型安全最优方案，改为择优论证并记录未采纳替代方案。 |
| R6 | C | `Bun.spawn([process.execPath,...])` 实际仍启动 Bun | 采纳 | 实测 Bun `process.execPath` 是 `bun.exe`。改为显式解析 `node` executable，fixture自报 `process.release.name` 并非node即失败。 |
| R7 | C | `stream.destroy(error)` 只能产生 INTERNAL_ERROR=2，不能作为peer CANCEL=8正控 | 采纳（blocker） | 本轮Node探针实测公共`stream.close(CANCEL)`假绿rst0、destroy为rst2、test-only私有`kHandle.rstStream(8)`忠实产生rst8。新fixture仅测试server使用私有injector，Bun production http2Fetch做client。 |
| R8 | C | session与bare close混写且缺事件反序矩阵 | 采纳 | 拆为bare close→unknown、session-first、stream-first/session-later、local+session→ambiguous、GOAWAY+clean end五格；unknown改为派生值而非首写evidence。 |
| R9 | C | dispatch lifecycle缺external reason与explicit cancel双向测试 | 采纳 | 指定现有`tests/transport/dispatch-lifecycle.unit.test.ts`，覆盖external identity、显式cancel/dispose=dispatch-cancel及先后顺序。 |
| R10 | C | header/deadline同tick与timer/listener单次释放未覆盖 | 采纳 | Task1加入FakeClock两种注册顺序、external-abort、settlement计数、liveTimerCount、listener add/remove和H2 onStreamClosed/reservation门。 |
| R11 | C | Node JSON回灌纯classifier不覆盖Bun production wiring | 采纳 | 删除JSON→classifier方案。Node只起server并发wire CANCEL=8；Bun测试进程直接用production http2Fetch/evidence callback消费。 |
| R12 | C | 最终logical terminal可绕过scheduler settlement | 采纳 | 除dispose/normal scheduler两路统一enrichment外，RequestContext在dispatch begin保存runtime provider；`recordGenerationLogicalTerminal` fallback冻结provider/error最终observation。 |
