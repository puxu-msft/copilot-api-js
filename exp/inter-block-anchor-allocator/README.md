# inter-block anchor allocator 实施 oracle

本目录保存 P0 的实现基线，供 P6 独立交付和后续 allocator 相位复用。

## O-6：短请求 wire 字节基线

运行：

```bash
./exp/inter-block-anchor-allocator/byte-equivalence.sh          # 门：捕获到临时文件，与 fixture 比较
RECAPTURE=1 ./exp/inter-block-anchor-allocator/byte-equivalence.sh   # 有意重捕：改写 fixture
```

脚本默认让内核选择非 4141 的空闲高位端口，启动隔离测试服务器并使用 `deterministic-hook.ts` 产出固定的单 text block 响应。readiness 必须同时满足三条：启动日志没有 bind failure、`ss -ltnp` 证明监听进程是本次 spawn 的 PID 或其后代、捕获内容带 hook 独有的 `msg_allocator_baseline` 与 `allocator baseline` 标记；任一不满足即非零退出。捕获写到 `$WORK_DIR/current-wire.sse`，脚本输出 SHA-256、字节数及监听 PID，并按 PID 精确停止自己启动的服务器。

**默认行为是比较，不是捕获**：脚本末尾对捕获与 `pre-change-wire.sse` 做 `cmp`，一致则 `O-6 PASS` 退出 0，不一致则 `O-6 FAIL` 退出 9 并打印首个差异位置。**只有 `RECAPTURE=1` 才会改写那份权威 fixture**，且会显眼提示要与实现改动分开提交。

> 2026-08-03 修正：此前 `CAPTURE` 默认就指向被跟踪的 `pre-change-wire.sse`，而脚本里只有 `sha256sum`、**没有任何比较**——把它当门跑，等于用当前输出覆盖权威基线再打印自己刚写的 hash，永远为绿。正样本对照已补：未改动树 PASS 且 fixture 字节不变；向 fixture 注入一字节后 FAIL（rc=9）。

实施 base `5c84a1e011e5d8b12ebde764ef0d8486b9952d6f` 经上述归属门重新捕获的权威结果：

- SHA-256：`1c6163c62f568fd5e1a46605c23716d1017b47232021b371f3cb145b2a4277f9`
- 字节数：`764`

历史 provenance `8691db71ca3b692468ae91dfc2df108871c8f5f684acc73f3832975d60f2a6a0 / 1675 bytes` 来自另一套旧请求、hook 与 SSE 内容。首版 P0 记录的 `24eda6b85d0ce17b955ce50aca27407d37f9a32a1de2e7a8318c6a2f55991e8b / 734 bytes` 来自占用固定端口的 peer mock，已被 code review 证伪并替换。后续相位以当前 `pre-change-wire.sse` 为权威 base。

## O-1 / O-2：producer 全序

```bash
bun test ./tests/helpers/wire-index-oracle.unit.test.ts ./tests/pipeline/anchor-multiblock-lifecycle.it.test.ts
```

- `assertMonotonicWireIndices` 断言全部 `content_block_start` 的 index 严格等于 `[0..n-1]`。
- `assertBlockProtocolState` 断言任一时刻最多一个块 open，每个 delta/stop 都引用当前 open block，且终局没有悬挂块。
- `wireShape` 输出可读的 `real_start@N` / `anchor_start@N` / `delta@N` / `*_stop@N` 序列；裸 `ClientFrame` 不携带 anchor provenance，因此调用方必须通过 `isAnchorFrame` option 传入 forwarded 记录或 sink-write 侧掌握的身份判定。

正控由 `wire-index-oracle.unit.test.ts` 的重复 index、跳号、双 open、orphan delta、错 index stop、悬挂块和重复 stop 负样本提供；另有显式 anchor provenance 正样本证明 `wireShape` 的 anchor 分支可达。当前 helper 绿基线为 9 tests / 0 failures。

## anchor 套件基线

`rg -l "anchor" tests -g '*.test.ts'` 命中 51 个测试文件。P0 实跑结果为 481 tests，474 pass，0 fail，7 skip。基线期间发现并修复一条陈旧的 gated CLI e2e：其 hook 仍导出已退役的 `onExchange`，且错误期待已被真实 CLI 判定为不安全的 coexist wire 能组装文本；现改为 `hooks.exchange` 并锁住真实负向结果 `numTurns=1, result=""`。
