---
name: empirical-probe-via-history-api
description: "如何实证测试上游/协议行为——从 history API 拉取真实请求（含真实 thinking signature），拼接最小测试请求，POST 到 4141 上运行的后端"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 6d66b9bc-324c-453c-9c7e-d6e9100240e2
---

裁决"上游 Copilot 会不会接受某种 payload 形态"这类**环境能力主张**的实证途径(不靠推理,原则6:亲手实测 > 文档推断):

1. 后端常驻 `localhost:4141`(`curl -s localhost:4141/health` 探测确认在跑;**不要自己启动/kill**——CLAUDE.md 原则3)。
2. history API 拿真实数据:
   - `GET /history/api/entries?limit=N` — 列表(轻量,看 id/model/success)
   - `GET /history/api/entries/:id` — 完整 entry(含 `inboundRequest`/`inboundResponse`/`sseEvents`/`outbound*`,可达数 MB)
   - entry 的 `inboundRequest.messages` 里有**真实有效、上游已接受过**的 thinking signature block(opus 多为 `thinking:""` + 长 signature 的 `display:omitted` 形态)。
3. jq 提取真实 block + 构造 minimal 请求(`--slurpfile` 避免 signature 转义):
   `jq -n --slurpfile tb block.json '{model:"claude-opus-4.8",max_tokens:64,thinking:{type:"adaptive"},stream:false,messages:[...]}'`
4. 发真实上游:`curl -X POST localhost:4141/v1/messages -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' --data @req.json -w '\nHTTP %{http_code}\n'`

每次请求消耗少量真实 Copilot token → 用 minimal payload(max_tokens 小)。这是裁决协议/上游主张的最高可信度手段。用此法实证了 [[thinking-signature-self-contained]]。
