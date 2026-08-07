# Responses reasoning 跨模型 carrier 探针

## 回答什么问题

RFC `docs/rfc/2026-07-14-anthropic-responses-direct-bridge.md:162-165` 曾解释：Responses 模型 A 签发的 `encrypted_content` 回喂模型 B 会被拒，因此 Scenario B 必须剥密文。本探针用真实 GHC Responses 上游比较：同模型/跨模型 × 带原密文/无密文，观察 HTTP 接受性和最小续接信号。

## 2026-08-06 观测

这是一份历史快照，不是脚本对未来运行的固定断言。脱敏原始输出与 provenance 保存在 `observed-2026-08-06.json`。脚本只要求首轮存在某个非空 `encrypted_content`；它不会强制未来复跑仍得到 encrypted-only reasoning 或可见文本 `323`，这些只属于本次快照。

审计基线 `192dce69f1bf482b1c3130d519991594a3fe46ab`；隔离测试服务器端口 `56235`，独立 `XDG_DATA_HOME`/History，复制真实 token/config，确认无 upstream hooks；模型 A=`gpt-5.4-mini`，模型 B=`gpt-5.6-sol`。

该次运行中，A 首轮生成了 encrypted-only reasoning（`summary:[]`、非空 `encrypted_content`）并在可见 message 中回答 `323`。四组续接：

| 组 | HTTP | 输出 |
|---|---:|---|
| A→A，带 A 密文 | 200 | `UNKNOWN` |
| A→A，不带密文 | 200 | `UNKNOWN` |
| A→B，带 A 密文 | 200 | `UNKNOWN` |
| A→B，不带密文 | 200 | `UNKNOWN` |

结论：当前 GHC Responses 不会因为跨模型旧 `encrypted_content` **必然**返回 400；RFC 的“必被拒”机制解释被证伪。

## 它没有证明什么

同模型带密文的正控也返回 `UNKNOWN`，说明该 prompt/oracle 无法证明 reasoning item 的隐藏语义是否被恢复。因此本探针**没有证明**：

- `encrypted_content` 跨模型可移植；
- 同模型密文一定恢复隐藏计算；
- 剥除密文不影响质量或 token；
- 所有 Responses 模型/版本都同样宽松。

Scenario B request-leg 漏接仍是已冻结配置契约的实现缺口，但风险应写成“旧模型 opaque state 未按声明剥离，语义/token 影响未证”，不能写成“必然400”。

## 复跑

先按项目 skill `live-ghc-e2e-verification` 在**非 4141**端口启动当前代码的隔离服务器，确认 hooks 未启用，并从 `/v1/models` 选择两个 Responses-native 模型。然后运行：

```bash
python3 exp/thinking-cross-model-reasoning/probe.py \
  --base-url http://127.0.0.1:<port> \
  --model-a gpt-5.4-mini \
  --model-b gpt-5.6-sol
```

脚本只打印模型名、HTTP/status、可见文本、summary 数量、carrier 是否存在及 SHA-256；不打印 token、认证信息、`encrypted_content` 正文或 HTTP error body。复跑后按 skill 用精确 PID/端口清理隔离服务器，并复核 `http://127.0.0.1:4141/health`。
