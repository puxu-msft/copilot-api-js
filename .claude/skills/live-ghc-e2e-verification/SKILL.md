---
name: live-ghc-e2e-verification
description: 当要用「真实请求走本项目 + 真实 GHC 计费后端」端到端验证一个功能/改动在**生产形态**下正确时使用——起隔离测试服务器（跑新码、真 GHC auth、独立 history.db 不污染真库）→ 发真请求覆盖被改路径 → History API 当核验 oracle（路由/双轨/真实 usage 计费/转发帧）。触发：功能开发/补全后想在真 GHC 上确认「不只测试绿，实际也对」、想验某改动没回归真实管线、想看真实 usage/计费/路由怎么记。**区别于 `client-proxy-e2e-testing`**（那个上游全程 mock、离线不烧额度、客户端 SDK/CLI 当 oracle 测客户端行为；本 skill 打真实 GHC、烧真实额度、History API 当 oracle 验端到端 + 计费）。共享的服务器 spawn 机制（`start` 子命令坑 / `XDG_DATA_HOME` 隔离 / PID 清理）见那个 skill，本 skill 不重复。裁决可信度实测 > 文档 > 声称，见 `empirical-verification`。
---

# Live GHC 端到端验证（真实计费后端、生产形态）

自洽单测绿 + 上游 mock e2e 绿 **两个盲点**：① 测试与实现同源出错一起绿；② mock 上游帧是你捏的、真 GHC 帧结构/顺序/usage 可能不同。**唯一能同时排掉两者的 = 真请求打真 GHC**。代价是烧真实额度、触真实计费——所以靶向（只发被改路径）+ 省额度（便宜模型 + 小 `max_tokens`）。

**最大盲点先记死：`live=旧码`。** 4141 主服务器跑的几乎总是你**改动前**的代码（用户没为你重启）。验你的改动**必须让新码在跑**——绝不 kill/重启 4141（`protect-user-main-server`），而是在**其他端口起隔离测试服务器**跑当前 worktree 代码。

## 1. 起隔离测试服务器（新码 + 真 GHC auth + 独立库）

隔离靠 `XDG_DATA_HOME` 覆盖 `APP_DIR`（`src/lib/config/paths.ts`：token/config.yaml/history.db 全在此下）。给隔离 dir 复制**真** github_token（保 GHC 认证）+ config.yaml（保用户真实路由/模型覆盖），这样行为「符合预期」= 跟生产一致，但 history 写进独立库、不污染真库（25GB+，别碰）。

```bash
# 实测可用配方（4142 为例，任意非 4141 高位端口）
TESTDATA=/tmp/copilot-test-4142
mkdir -p "$TESTDATA/copilot-api"
cp ~/.local/share/copilot-api/github_token "$TESTDATA/copilot-api/github_token"   # 真 GHC 认证
cp ~/.local/share/copilot-api/config.yaml  "$TESTDATA/copilot-api/config.yaml"    # 真实路由/model_overrides
# 起服务器：必须带 `start` 子命令（`bun run start` 的 npm 脚本无子命令，会把 --port 当未知命令报错）
XDG_DATA_HOME="$TESTDATA" NODE_ENV=production bun run ./src/main.ts start --port 4142 > "$TESTDATA/server.log" 2>&1 &
echo $! > "$TESTDATA/server.pid"
sleep 8   # boot 做 github→copilot token 交换 + model catalog fetch，需几秒
curl -s http://localhost:4142/health   # 期望 {"status":"healthy","checks":{"copilotToken":true,"githubToken":true,"models":true}}
```

boot 细节与 CLI spawn 的更多坑（token 真实路径用 `homedir()` 基非沙箱重定向、`bun run` 父子进程树）见 skill `client-proxy-e2e-testing` §spawn 真 proxy。

**先列可用模型 + 挑便宜的**（省额度）：
```bash
curl -s http://localhost:4142/v1/models | grep -oE '"id":"[^"]+"' | sed 's/"id":"//;s/"//' | tr '\n' ' '
```
实测便宜档（各家最小）：anthropic `claude-haiku-4.5`、openai `gpt-5.4-mini`、gemini `gemini-3.5-flash`。模型名随时间漂移，**每次现列**别背。

## 2. 分格式真请求配方（4 入站 × 出站腿）

`max_tokens` 压到 40 上下、prompt 让模型回一个可辨识短串（`PONG-X`）确认往返正确。四个入站格式 + 后缀钉出站腿（翻译矩阵）：

```bash
# A) anthropic 直连 /v1/messages（流式）
curl -s -N http://localhost:4142/v1/messages -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4.5","stream":true,"max_tokens":40,"messages":[{"role":"user","content":"Reply with exactly: PONG-A"}]}'
# 期望事件序列: message_start content_block_start content_block_delta content_block_stop message_delta message_stop

# B) openai-cc /chat/completions（流式，直连 CC）
curl -s -N http://localhost:4142/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4-mini","stream":true,"max_tokens":40,"messages":[{"role":"user","content":"Reply with exactly: PONG-C"}]}'

# C) openai-cc → /responses 翻译腿（@responses 后缀，via-responses：上游 Responses SSE 翻回 CC 帧）
curl -s -N http://localhost:4142/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4-mini@responses","stream":true,"max_tokens":40,"messages":[{"role":"user","content":"Reply with exactly: PONG-VR"}]}'
# 期望 CC 帧结构: 首帧 delta:{role:"assistant"} → content deltas → 末 delta:{},finish_reason:"stop" → usage chunk(choices:[]) → data:[DONE]

# D) gemini generateContent（非流式；流式用 :streamGenerateContent）
curl -s "http://localhost:4142/v1beta/models/gemini-3.5-flash:generateContent" -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with exactly: PONG-G"}]}],"generationConfig":{"maxOutputTokens":40}}'
# 期望: candidates[0].content.parts[].text 拼出 PONG-G, finishReason:"STOP", usageMetadata{promptTokenCount,candidatesTokenCount,totalTokenCount}
```

**反向 `@messages` 腿**（cc/responses/gemini 客户端 → Anthropic 上游）：给 openai/gemini 请求的 model 加 `@messages` 后缀（如 `gpt-5.4-mini@messages`），上游走 `/v1/messages`、响应经反向 translator 翻回客户端格式。**流完整性看协议终止符**（Anthropic `message_stop` / CC `[DONE]` / Responses `response.completed` / Gemini flush 前 `finishReason`）非传输 EOF（→ `empirical-verification`）。

## 3. History API 当核验 oracle（richest-data-flow 落库真相）

响应 200 + 内容对**只证了客户端可见半边**。真验证要看后端记了什么——路由决策、双轨、**真实 usage（计费）**、转发帧。测试服务器自带 History REST（同 4141）：

```bash
# 最近 entry id
EID=$(curl -s "http://localhost:4142/history/api/entries?limit=1" | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"//')
curl -s "http://localhost:4142/history/api/entries/$EID" | python3 -m json.tool | less   # 全量
```

**实测字段地图**（2026-07-07 history 重构后的形态，`empirical-verification` 记「旧 inboundRequest/outbound* 腿名已迁 client/upstream」）——每个字段证什么：

| 字段 | 位置 | 证什么 |
|---|---|---|
| `model.{requested,resolved,outboundEndpoint,translated}` | 顶层 | 路由决策：客户端要的 alias → 解析名 → 实际出站腿 + 是否翻译。例 `{requested:"gpt-5.4-mini@responses", resolved:"gpt-5.4-mini", outboundEndpoint:"/responses", translated:true}` 证 cell-assembly 路由对 |
| `clientRequest.{messages,body,format,headers}` | 顶层 | 客户端轨（入站原样） |
| `attempts[].upstreamRequest.{format,messages,body,headers}` | per-attempt | **wire 轨**（真正发给 GHC 的字节）。`format` 证走对了上游协议（`openai-responses`/`anthropic-messages`/…） |
| `attempts[].upstreamResponse.usage` | per-attempt | **真实计费/usage**（GHC 计的，honest outbound）。例 `{input_tokens:14, output_tokens:35, output_tokens_details:{reasoning_tokens:25}}`——reasoning token 也计费 |
| `attempts[].effectiveSource.{messages,body,format}` | per-attempt | **effective 轨**（post-rewrite 逻辑请求）。注意字段名是 `effectiveSource` **不是** `effectiveRequest`（探针写错 key 会假报「没记」——先 dump 顶层 keys 再断言） |
| `clientResponse.sseEvents[]` | 顶层 | 转发给客户端的帧（含合成帧的 `synthetic` 标记，richest-data-flow） |
| `pipelineInfo` | 顶层 | retry-rebuild 产物（message-mapping/sanitization/truncation）。**单尝试无 retry 时几乎空**（只 `streamIdleTimeoutMs` 等），属正确非缺陷 |

**探针纪律**（`empirical-verification` 的 pass-null）：断言某字段「没记」前，先 `print(list(d.keys()))` / `print(list(attempt.keys()))` 确认真实字段名——`effectiveSource` vs `effectiveRequest`、`state` vs `status` 这类 key 名差会让你假报缺陷。用**真实应命中的正样本**证探针触达（我一次把 effective 判「False」纯因探 `effectiveRequest` 而真名 `effectiveSource`）。

## 4. 靶向：只验真被改的路径

烧额度前先问「**这个改动的真行为变化是什么**」，只发能触发它的请求，别把四格式全跑一遍当仪式。判据：
- **纯 dead-code 删除 / 重命名 / 内部重构**（真实请求路径不变）→ 每格式发**一发**冒烟确认没炸即可，不必深挖。
- **真行为改动**（改了帧结构/翻译/路由/持久化）→ 精准构造能走到那条路径的请求 + 对着预期字节/字段核验。
  实例：cell-assembly 收尾里，「删 codec 出站方法」对真实请求零行为变化（恒走 cell），而「HIGH-1 提 Responses→CC renderer 进 hub」是**唯一**真行为变化——所以重点发 **C) via-responses**（`@responses`）核验 CC 帧逐字段结构，其余格式只冒烟。

## 5. 盲点（诚实边界，别声称超出实测的覆盖）

- **`live=旧码`**：验新码必确认测试服务器跑的是当前 worktree（`git log --oneline -1` 对账 + 隔离端口非 4141）。
- **单尝试 ≠ retry 路径**：一次成功请求**不触发** retry-only 逻辑（message-mapping 重建走 `ctx.currentAttempt.effectiveRequest.messages`、cacheControlStripped、反应式重试策略）。要 live 验 retry 得刻意触发（畸形请求/thinking-signature/rate-limit mock），额外烧额度；否则如实说「retry 路径由单测 + 数据流追踪覆盖，未 live 验」。
- **单请求 ≠ 多轮/会话**：prompt-cache 命中、会话注册、reverse-exchange id 跨轮保全需多轮请求（`empirical-verification` prompt-cache 诊断）。
- **合成帧污染**：验功能对之外，查 history `clientResponse.sseEvents` 里合成 keepalive/anchor/message-start 是否打了 `synthetic` 标记（`empirical-verification` 完备性维度③可观测性）。

## 6. 清理（PID 精确、绝不泛杀）

`bun run ./src/main.ts` 的父进程（`bun run` launcher）与真正监听端口的**子进程 PID 不同**——kill `server.pid`（父）后端口可能仍被子进程占。清理两步：
```bash
kill "$(cat /tmp/copilot-test-4142/server.pid)"          # 杀父 launcher
ss -tlnp | grep ':4142'                                   # 找真正监听的子进程 PID
# 确认该 PID != 4141 主服务器 PID 后再精确 kill 子进程；绝不 pkill/killall（会误伤 4141/peer worktree）
kill <子进程PID>
rm -rf /tmp/copilot-test-4142                             # 隔离临时数据，可恢复
curl -s http://localhost:4141/health                      # 复核 4141 主服务器毫发无损
```
`protect-user-main-server`：清理只按**端口/PID 精确**认自己起的那个；`kill`/`rm -rf` 可能被权限护栏拦（拆成单命令或让用户执行），别用 `pkill -f`/`killall` 泛匹配。

## 交叉引用
- 服务器 spawn/隔离/清理的更多坑（token 路径、进程树、config hook 加载）→ skill `client-proxy-e2e-testing`（那个 mock 上游，本 skill 打真 GHC，机制共享）。
- 4141 只读探针（不自启、不改动，看真实历史流量当参考）+ pass-null 探针纪律 → skill `empirical-verification`。
- 各端点/字段语义权威 → `docs/API.md`（端点 SSOT）、运行实例 `GET /openapi.json`；GHC 上游行为 → skill `ghc-api-reference` / `ghc-anthropic-upstream`。
