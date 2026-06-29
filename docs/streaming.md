# 流式处理、WebSocket、截断检测

全 5 格式流式 pump 已切 driver owns-sink：driver `runResponseSink` drain S5 改写链写进注入的 `ClientSink`，统一处理 forwarded 采样、heartbeat、终态。

## owns-sink 写出

`src/lib/pipeline/client-sink.ts` 的 `makeSseSink` / `makeWsSink` 在写出点采 forwarded、注入 keepalive ping、自重排 heartbeat timer。`driver.ts` 的 `runResponseSink`（+ buffered 变体）持 sink，handler 自持 accumulator 经 `onUpstreamFrame` / `onRenderedFrame` 喂。

## 截断检测

`src/lib/pipeline/non-streaming-completeness.ts` gate 非流式语义残缺；流式各 handler 在 complete 分支读自家终止符（message_stop / finishReason / status），缺则改判 fail + 合成 error 帧。详见 spec/upstream-stream-truncation-detection.md。

## 重复检测

`src/lib/repetition-detector.ts` 监测上游退化重复输出。

## WebSocket

`src/lib/ws/`（adapter Node/Bun 分流 + broadcast 总线）。上游 WS 传输（Responses）：`src/lib/openai/upstream-ws*.ts`（半开熔断 + 回退）；客户端 WS：`src/routes/responses/ws.ts`。

详见 DESIGN.md「流式写出」「截断检测」表行与运行时选项 timeouts.* / anthropic.stream_keepalive_* / protect_streaming_*。
