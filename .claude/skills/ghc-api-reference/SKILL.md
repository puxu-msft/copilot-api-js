---
name: ghc-api-reference
description: "Use when 需要以 GitHub Copilot Chat 官方源码为准，核对/新增 GHC API 的请求格式、anthropic-beta header、模型能力（thinking/context-editing/tool-search/memory）、context_management、Messages/Responses body、usage wire 形状，或调试 Copilot 返回意外响应、新模型上线时同步官方判断逻辑。区别于 ghc-anthropic-upstream（排查上游异常症状）。"
---

# GHC API 权威参考：GitHub Copilot Chat 扩展源码

## 这是什么、为什么重要

GitHub Copilot Chat 扩展的源码是 **GHC API 行为的定义者**——它决定向上游 Copilot 发什么 header、启用哪些 `anthropic-beta` feature、对每个模型启用什么能力、`context_management`/usage 怎么构建。**本项目（copilot-api-js）是模仿者**，其 `src/lib/anthropic/features.ts`、`client.ts`、`models/` 等镜像自此源码。

凡涉及与 Copilot API 交互的实现/调试，**以此源码为准**，而非凭记忆或猜测。

## ⚠️ 上游已归档迁移（2026-05-20）—— 先讲清楚

原仓库 `microsoft/vscode-copilot-chat` **已归档**（末次提交 `5863f5a`）。活跃开发**已并入 `microsoft/vscode`**，源码在 `extensions/copilot/src/`。目录布局基本一一对应：旧 `src/platform/...` ↔ 新 `extensions/copilot/src/platform/...`。本 skill 路径以 `src/` 为基准，新仓库前加 `extensions/copilot/`。

| | 旧（归档·冻结） | 新（活跃） |
|---|---|---|
| 仓库 | `microsoft/vscode-copilot-chat` | `microsoft/vscode` |
| 本地副本 | `refs/vscode-copilot-chat/`（symlink，冻结在归档点） | `refs/vscode-copilot-chat-upstream/`（sparse-checkout） |

> **本地副本环境说明**：两个 `refs/` 目录受 `refs/.gitignore` 忽略、**不入库**——**本机已就位**，但 fresh clone / 别的 worktree / 别的机器上**没有**，须先跑 `bash refs/sync-refs.sh`（已存在则增量 `git pull --ff-only`，不存在则首次 sparse-clone，子树 ~49M；**禁止整仓 clone**）。

## 双向漂移：冻结副本 ≠ 最新源 ≠ 本项目

三者都可能不一致，对照前先想清信谁。**裁决原则**：
- 核对**新模型 / 新 beta / 新能力门槛** → 一律以**最新源**为准（下方获取命令）。
- 查**稳定的协议形状 / 历史逻辑** → 本地冻结副本即可（快、离线）。
- 「本项目比冻结副本多某能力/模型」往往是**正确的领先**（2026-07 三特性对齐后），不是 bug；确认请查最新源，别拿冻结副本当裁判。

已实测的具体漂移（modelAliasRegistry 已删并入 chatModelCapabilities、tool-search 改 default-allow、TOOL_SEARCH_SUPPORTED_MODELS 已删等）→ 见 `references/capability-matrix.md` / `references/project-mapping.md`。

## 获取最新源码

```bash
bash refs/sync-refs.sh    # 首选：已存在则增量 pull，不存在则 sparse-clone

# 单点核对（无需 clone）：
gh api repos/microsoft/vscode/contents/extensions/copilot/src/platform/networking/common/anthropic.ts --jq '.content' | base64 -d
# 定位文件是否还在 / 已改名：
gh search code --repo microsoft/vscode "isAnthropicToolSearchEnabled" --json path
```

## 参考文件（按需加载，勿全量front-load）

| 想查 | 读 |
|---|---|
| 模型能力判断表（thinking/context-editing/tool-search/memory/cache-ttl）、anthropic-beta header、context_management 形状、thinking 配置、关键常量 | `references/capability-matrix.md` |
| **模型目录 + 能力检测**（某模型支持哪些 endpoint/adaptive_thinking/reasoning_effort/vision、tokenizer、billing；`Model` 类型形状 + `src/lib/models/` 消费地图 + grep 食谱 + 刷新） | `references/models-catalog.md`（原始快照 `references/AVAILABLE_MODELS.json`，即 `GET /models` 实抓） |
| 本项目↔上游 映射总表、文件地图（想查什么→哪个文件+grep）、同步维护 checklist | `references/project-mapping.md` |
| GHC usage 数据升级的 wire 事实（cache_write / `include:[usage]` 被拒 → 客户端 chat `stream_options.include_usage` 流式为何 400 / copilot_usage sidecar 帧 / usage 0/0 / 实测手法） | `references/usage-wire.md` |

## 典型工作流

**新增/核对一个 beta feature**：最新源 `chatEndpoint.ts` grep `betaFeatures.push` 取全部 beta + 启用条件函数 → 进 `anthropic.ts` 看模型门槛 + config key → 对照本项目 `features.ts:buildAnthropicBetaHeaders` 补齐（注意 `mergeAnthropicBeta` 别覆盖客户端 beta）。细节表见 `references/capability-matrix.md`。

**新模型上线**：**必须用最新源**——`anthropic.ts` 看四个 `modelSupports*` + `chatModelCapabilities.ts` 看能力声明是否纳入新模型 → 对照本项目 `features.ts` allowlist + `resolver.ts`（本项目可能已领先，确认即可）。

**调试「Copilot 返回意外响应」**：① 比对实发 header（`X-Initiator`/`anthropic-beta`/`X-Model-Provider-Preference`/`anthropic-version`）与上游 `getExtraHeaders`；② 比对 body（thinking adaptive vs enabled、`context_management` edits、cache_control 位置 tools→system→messages ≤4 断点）；③ model name 是否正确解析（`resolver.ts`）；④ 查 history 的 `sseEvents` 看上游原始帧。**症状类排查**（thinking signature 400 / tool_use 降级 / usage 异常）→ 转 skill `ghc-anthropic-upstream`。

## 何时用本 skill vs 相邻 skill

- **本 skill（ghc-api-reference）**：以官方客户端源码为准，**对齐**请求格式/能力/wire 形状（正向核对、新增 feature、新模型同步）。
- **`ghc-anthropic-upstream`**：排查上游返回的**异常症状**（signature 400、空 thinking 毒化、tool_use 文本降级等）。
- **`ghc-api-reference` 的 usage 段（references/usage-wire.md）**：GHC usage 数据升级的 wire 事实与已修 bug 指针。
