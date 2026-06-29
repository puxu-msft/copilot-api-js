# Anthropic API 兼容

Anthropic 直连为 **bypass-direct** codec（translate/render = identity），上游就是协议权威，代理只做兼容 shim。codec 在 `src/lib/codec/anthropic/`。

## codec 与改写

- `codec.ts`：per-request 有状态工厂，承 B1–B12 wire 准备。
- `request-rewrite-adapter.ts`：sanitize 链作为 S3 RequestRewrite 注入。
- `response-rewrite-adapters.ts`：5 条 S5 ResponseRewrite——recover-tool-call(100) / thinking-signature-compat(150) / decode(200) / server-tool-filter(300) / refusal-recovery(400)，order 编码硬序契约。
- `strategies.ts`：10 个重试策略组装。

## 兼容协商

`src/lib/anthropic/feature-negotiation.ts`：per-(endpoint,model) 永久缓存上游学到的特性/beta/effort/deferred-tool 拒绝，配合 config 孪生（`partner_strip_features`、`beta_strip_headers`）首发即剥。

## 功能矩阵（配置）

thinking signature 自包含（块级保护）、adaptive thinking 强制、model_capabilities 名单、cache_control 模式、L2 protect_streaming、refusal 恢复——逐项见运行时选项表。refusal 细节见 [refusal-recovery.md](refusal-recovery.md)；thinking 中毒诊断见 memory。

详见 DESIGN.md「活的架构现状」「改写词汇」与 anthropic.* 运行时选项。
