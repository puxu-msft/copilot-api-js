---
name: methodology-client-source-grep-not-rest-capability-probe-endpoint
description: client 扩展源码 grep 只证 client 行为，不等于 REST 上游能力上限；核 GHC 是否支持某端点须实测打真实端点。实例=GHC count_tokens
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2edeb07f-f446-4c5d-96b8-1afb7f58b8f6
---

**「查 vscode-copilot-chat 源码零结果」不能推断「GHC REST 上游无此端点」——源码 grep 只反映 client 自己怎么用，不等于上游 API 的能力上限。核对 GHC 是否支持某端点/能力，要实测打真实 REST 端点，别只查官方 client 源码。**

**Why:** `docs/todo/better-count-tokens.md` 曾把「GHC API 没有 count_tokens 端点（查 microsoft/vscode 最新源码零结果；官方 Copilot 客户端也是本地 tiktoken 估算）」列为「已确认的事实（不要重新质疑）」。2026-07-13 实测 curl `POST https://api.githubcopilot.com/v1/messages/count_tokens`（复用 copilot token）**返回 `{"input_tokens":N}` HTTP 200**——端点真实存在。前作者的错误是把「client 扩展内部用本地 tokenizer 计数」当成了「REST 上游不暴露该端点」；二者正交：GHC 代理了 Anthropic 的 `/v1/messages`，也一并代理了 `/v1/messages/count_tokens`，只是官方 client 恰好不调它。这是「实测 > 文档推断」可信度阶梯的典型（[[feedback-pass-null-clean-not-self-validating]] 同簇）。

**How to apply:** 遇到「GHC/上游不支持 X」且证据只是「源码里搜不到」时——把它当**未验证的文档推断**，不当事实。用 [[ghc-api-reference]] 记的手法拿 copilot token、直接打真实端点实测（探针见 `exp/ghc-count-tokens-probe/`）。尤其当上游是「代理某个第三方 API」（GHC 代理 Anthropic/OpenAI/Google）时，REST 表面常**大于** client 实际用到的子集。落点：GHC count_tokens 支持边界=账号 live `/models` 目录、完全容忍真实 wire——见 spec `docs/spec/2026-07-13-ghc-count-tokens-default.md`。通用手法见 user skill `verifying-authoritative-claims` + 项目 skill `empirical-verification`。
