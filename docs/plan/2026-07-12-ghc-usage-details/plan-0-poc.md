# Phase 0 — 门控 PoC：净输入公式

**Goal:** 实测确定 GHC 的 `prompt_tokens` 是否把 `cache_write_tokens` 算作子集，从而钉死 Phase 1/2 的净公式。**这是全特性的门控**——结论不出，不写减法。

**为何是 PoC 而非直接编码：** 净公式选错会让计费与历史 token 双向偏差且不可逆（spec §1.3）。可信度：亲手实测 > 文档推断。

**产出：** `exp/ghc-cache-write/CONCLUSION.md`（结论 + 原始样本 + 判定）。

---

### Task 0.1：取一条真实 cache-create 请求的原始 GHC usage

**Files:**
- Create: `exp/ghc-cache-write/CONCLUSION.md`

**背景：** 服务器已在 `localhost:4141` 运行（用户侧，勿启停）。History API 存了每条请求的上游原始 sseEvents。要找一条**触发缓存写**（cache_write_tokens 非 null）的 OpenAI/Responses 家族流式请求。

- [ ] **Step 1：搜含非空 cache_write_tokens 的上游响应**

Run:
```bash
curl -s --max-time 20 'http://localhost:4141/history/api/search?source=rewrites-resp&q=cache_write_tokens&limit=20' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(r["ownerReqId"], r["summary"]["endpoint"]) for r in d.get("rows",[])]'
```
Expected: 若干 reqId + endpoint。挑一个 endpoint 为 `openai-chat-completions` / `openai-responses` / `gemini-generate-content` 的。

> 若全是 `anthropic-messages`（cache_write 是 Anthropic 原生腿的字段名巧合），改用**发起一次真实请求**：让用户用 OpenAI 客户端对一个大 system prompt 发两次 `/chat/completions`（第一次写缓存），或直接读用户提供的样本。**不要自己启服务器。** 若无法取到真实 OpenAI 家族的 cache_write 样本，在 CONCLUSION.md 记「无法实测，采用保守子集假设」并说明依据。

- [ ] **Step 2：取该 reqId 的完整明细，读上游原始 usage 帧**

Run（把 `<REQ_ID>` 替换）：
```bash
curl -s --max-time 20 'http://localhost:4141/history/api/entry?id=<REQ_ID>' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get("attempts",[{}])[-1].get("upstreamResponse",{}).get("usage",{}),indent=2)); [print("FRAME",e.get("type"),e.get("raw")[:400]) for e in d.get("attempts",[{}])[-1].get("upstreamResponse",{}).get("sseEvents",[]) if "usage" in (e.get("raw") or "")]'
```
Expected: 打印归一化后的 usage + 含 usage 的原始帧。**核实 endpoint 路由查看正确的 entry 端点**（若 `/entry` 路径不对，先 `curl -s localhost:4141/openapi.json | python3 -c 'import sys,json;print([p for p in json.load(sys.stdin)["paths"] if "entry" in p or "history" in p])'` 找活的真相）。

- [ ] **Step 3：判定子集 vs additive，写 CONCLUSION.md**

从原始帧取 `prompt_tokens`、`prompt_tokens_details.cached_tokens`、`prompt_tokens_details.cache_write_tokens`（responses 帧是 `input_tokens` / `input_tokens_details.*`）。判定：

```
CONCLUSION.md 内容模板：

# PoC 结论：GHC cache_write_tokens 净公式

## 原始样本（reqId <REQ_ID>, endpoint <...>）
prompt_tokens = <P>
cached_tokens = <C>
cache_write_tokens = <W>
（贴完整原始 usage JSON）

## 判定
- 若 P == (P - C - W) + C + W 恒等，且观察到 W>0 时 P 仍 == fresh + C + W：**子集**（cache_write ⊂ prompt_tokens）
  → 净公式：input = prompt - cached - cache_write；oracle：input + cache_read + cache_creation == prompt_tokens
- 若 W>0 且 P == fresh + C（cache_write 独立于 prompt_tokens）：**additive**
  → 净公式：input = prompt - cached（不减 cache_write）；oracle：input + cache_read == prompt_tokens

## 采纳：<子集 | additive>
（写明依据；若无法实测，采用保守子集假设 + 说明风险）
```

- [ ] **Step 4：提交**

```bash
git add -- exp/ghc-cache-write/CONCLUSION.md
git commit -F <msgfile> -- exp/ghc-cache-write/CONCLUSION.md
# msg: "docs(poc): GHC cache_write net-formula conclusion (<子集|additive>)"
```

**Phase 0 完成判据：** CONCLUSION.md 明确记录「子集」或「additive」，Phase 1/2 据此选分支。
