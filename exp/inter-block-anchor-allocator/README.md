# inter-block anchor allocator 实施 oracle

本目录保存 P0 的实现基线，供 P6 独立交付和后续 allocator 相位复用。

## O-6：短请求 wire 字节基线

运行：

```bash
./exp/inter-block-anchor-allocator/byte-equivalence.sh
```

脚本在非 4141 端口 `42061` 启动隔离测试服务器，使用 `deterministic-hook.ts` 产出固定的单 text block 响应，把完整 SSE 保存为 `pre-change-wire.sse`，输出 SHA-256 与字节数，并按 PID 精确停止自己启动的服务器。

实施 base `5c84a1e011e5d8b12ebde764ef0d8486b9952d6f` 捕获结果：

- SHA-256：`24eda6b85d0ce17b955ce50aca27407d37f9a32a1de2e7a8318c6a2f55991e8b`
- 字节数：`734`

历史 provenance `8691db71ca3b692468ae91dfc2df108871c8f5f684acc73f3832975d60f2a6a0 / 1675 bytes` 来自另一套旧请求、hook 与 SSE 内容。当前 P0 的 hook、请求和响应 fixture 已显式冻结在本目录，因此后续相位以这里保存的 `pre-change-wire.sse` 为权威 base，而不把旧 provenance 当成可直接比较的同一输入。

## O-1 / O-2：producer 全序

```bash
bun test ./tests/helpers/wire-index-oracle.unit.test.ts ./tests/pipeline/anchor-multiblock-lifecycle.it.test.ts
```

- `assertMonotonicWireIndices` 断言全部 `content_block_start` 的 index 严格等于 `[0..n-1]`。
- `assertBlockProtocolState` 断言任一时刻最多一个块 open，每个 delta/stop 都引用当前 open block，且终局没有悬挂块。
- `wireShape` 输出可读的 `real_start@N` / `anchor_start@N` / `delta@N` / `*_stop@N` 序列。

正控由 `wire-index-oracle.unit.test.ts` 的重复 index、跳号、双 open、orphan delta、错 index stop、悬挂块和重复 stop 负样本提供。当前 producer 绿基线为 13 tests / 0 failures。

## anchor 套件基线

`rg -l "anchor" tests -g '*.test.ts'` 命中 51 个测试文件。P0 实跑结果为 481 tests，474 pass，0 fail，7 skip。基线期间发现并修复一条陈旧的 gated CLI e2e：其 hook 仍导出已退役的 `onExchange`，且错误期待已被真实 CLI 判定为不安全的 coexist wire 能组装文本；现改为 `hooks.exchange` 并锁住真实负向结果 `numTurns=1, result=""`。
