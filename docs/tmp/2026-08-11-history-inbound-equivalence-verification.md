# History inbound 等价性验证（2026-08-11）

## 1. 实际执行

- 对照两端：before=`db4d16ef`（新建隔离 worktree `/tmp/hie-verify-before`），after=`dcfa73ec`（`/tmp/hie-verify-after`，来自分支 `perf/per-request-cpu-reduction-43045809`）。两端各自 `bun install`。
- 各自独立 `XDG_DATA_HOME`（`/tmp/hie-verify-xdg-{before,after}`），复用既有真实 GHC token（来自 `/tmp/cpu-profile-43045809/xdg/.../github_token`，未改动原文件）。
- 各自 `hooks/mock.ts`（`exchange: async () => mockAnthropicMessage(...)`，内容完全一致），config.yaml 启用 hook，避免真打上游。
- 启动命令：`XDG_DATA_HOME=... bun run ./packages/cli/src/main.ts start --port {18081|18082} --no-tui --no-rate-limit --history`。
- HTTP 载荷：`/home/xp/.claude/jobs/43045809/tmp/payload.json`（真实 Anthropic 请求体，58 条 messages，含 thinking/tools）原样 POST 到 `/v1/messages`。
- WS 载荷：自建富嵌套 Responses payload（`function_call`/`function_call_output`/`image_generation` tool/`metadata` 嵌套数组等），`ws://127.0.0.1:{port}/v1/responses` 发 `response.create`，model=`claude-opus-5`（强制走 Anthropic bridge fallback，否则 direct 路径会因 mock 格式不符而 truncate 报错，已实测踩过一次）。
- 取证：`GET /history/api/entries/:id`，抽取 `clientRequest.body`，`json.dumps(sort_keys=True)` 规范化后 `diff`/`md5sum`。
- 已清理：测试服务器 6 个 PID（526536/526538/526540/526612/526614/526616）已按 PID 精确 kill；两个我自建的隔离 worktree 已移除（非共享树，独占）。4141/PID 3868381 全程未触碰，收尾复测 `curl /api/status` 返回 200。

## 2. 正样本对照

**做了，两条路径各一次**：
- WS 路径：把 `metadata.probe` 和 `input[0].content[0].text` 改成 mutated 值重发，`diff` 命中（exit 1），精确报出两处差异。
- HTTP 路径：给 `metadata.mutationProbe` 加一个新字段重发，`diff` 命中（exit 1，6 行差异，含新字段）。
证明比对管道确实读取到了真实变化的字段，不是恒等空对比。

## 3. Anthropic HTTP（`/v1/messages`）结果

before/after 的 `clientRequest.body` 规范化后 **md5 完全一致**（`ff17a928b33a31bb1466c6735c161289`），且与原始发送的 fixture body **逐字节相等**（无额外注入差异）。**无差异**。

## 4. WebSocket（`/v1/responses`）结果 —— 最高风险路径

before/after 的 `clientRequest.body` 规范化后 **md5 完全一致**（`edbd8fa3d1054b92ad33799312d85f30`）。与原始发送 payload 相比仅多一个 `stream:true` 字段（WS 路由在 `extractPayload` 里强制注入，发生在两版本快照点之前，两版本行为一致，非回归）；`instructions`（路由注入前的原文）与 `tools`（含未被剥离的 `image_generation`）均逐字保留。**无差异，已验证**。

## 5. 未能验证的部分

- 未测试多 attempt/retry（`exchange` 被调 L1×L2 次）场景下快照是否受影响——按代码结构，`originalBodyForHistory` 只在 S1 parse 阶段建立一次，与 attempt 次数无关，但**未做实测确认**。
- 未覆盖 `openai-cc`（Chat Completions）codec 路径（同一 diff 也改了它），任务未要求，未测。
- 未对 `clientRequest.headers` 做逐字段比对（任务范围是 body 内容，未扩展）。
- 未做并发/多请求交叉污染场景下的快照隔离测试。

## 总体判定

在已验证的两条路径（Anthropic HTTP `/v1/messages`、WS `/v1/responses`）上，**命题成立**：inbound 内容在改动前后完全等价，未发现因快照点前移或对象身份变化导致的字段丢失/改变。
