# 流式处理、WebSocket、截断检测

全 5 格式流式 pump 已切 driver owns-sink：driver `runResponseSink` drain S5 改写链写进注入的 `ClientSink`，统一处理 forwarded 采样、heartbeat、终态。

## 上游掉线缓冲重试（opt-in，四端点非对称提交粒度，默认全 OFF）

`runResponseSink` 的 buffered 变体 `runResponseBufferedSink` 是格式无关共享原语：上游中途掉线（RST/error/idle）不直接下发截断，而是缓冲已收内容、透明重取新流重试，仅在提交边界落定后才把内容写给客户端。四端点接线**刻意非对称**（Anthropic/Responses HTTP 走块级提交、Chat Completions/Responses WS 走仅终态提交），当前**全部默认 OFF**（opt-in，Anthropic/Responses/CC 三个默认翻转 gated 在用户跑 keepalive 实证门；Anthropic 块级机制已 landed 但 handler 接线未启用）。详细机制、谓词边界、per-vendor telemetry、caps 解析见 DESIGN.md「活的架构现状」的「block 级缓冲重试（四端点非对称提交粒度）」行与「Codex/Responses tier-1」行，不在此重复展开。

## owns-sink 写出

`src/lib/pipeline/client-sink.ts` 的 `makeSseSink` / `makeWsSink` 在写出点采 forwarded、注入 keepalive ping、自重排 heartbeat timer。`driver.ts` 的 `runResponseSink`（+ buffered 变体）持 sink，handler 自持 accumulator 经 `onUpstreamFrame` / `onRenderedFrame` 喂。

## 截断检测

`src/lib/pipeline/non-streaming-completeness.ts` gate 非流式语义残缺；流式各 handler 在 complete 分支读自家终止符（message_stop / finishReason / status），缺则改判 fail + 合成 error 帧。详见 spec/upstream-stream-truncation-detection.md。

## 重复检测

`src/lib/repetition-detector.ts` 监测上游退化重复输出。

## WebSocket

`src/lib/ws/`（adapter Node/Bun 分流 + broadcast 总线）。上游 WS 传输（Responses）：`src/lib/openai/upstream-ws*.ts`（半开熔断 + 回退）；客户端 WS：`src/routes/responses/ws.ts`。

详见 DESIGN.md「流式写出」「截断检测」表行与运行时选项 timeouts.* / anthropic.stream_keepalive_* / protect_streaming_*。
