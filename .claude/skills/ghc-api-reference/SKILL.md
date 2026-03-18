---
name: ghc-api-reference
description: "查询 VSCode Copilot Chat 扩展源码（refs/vscode-copilot-chat/），了解 GHC API 的请求格式、header 构建、模型能力检测、协议处理等官方实现。使用场景：(1) 了解 Copilot API 如何处理特定模型的请求 (2) 查找 header/beta feature 构建逻辑 (3) 对比官方实现验证本项目的正确性 (4) 新模型/新特性支持时同步官方行为"
---

# 查询 VSCode Copilot Chat 扩展源码

## 概述

`refs/vscode-copilot-chat/` 是 **VSCode Copilot Chat 扩展的源码**（即 `@anthropic/vscode-github-chat`），是理解 GitHub Copilot Chat API 行为的**最权威参考**。

本项目的许多核心逻辑（header 构建、模型特性检测、context management、beta features 等）都是从 vscode-copilot-chat 源码中镜像而来。当需要新增功能或验证实现正确性时，**首先查阅此参考项目**。

### 关键原则

**vscode-copilot-chat 是 API 行为的定义者**——它决定发什么 header、启用什么 beta feature、如何处理各种模型。本项目是**模仿者**，需要跟随其行为。因此在实现任何与 Copilot API 交互相关的功能时，都应以 vscode-copilot-chat 的实现为准。

## 源码目录结构

```
refs/vscode-copilot-chat/src/
├── platform/                          # 平台层（核心 API 交互逻辑）
│   ├── endpoint/
│   │   ├── common/                    # 类型定义、能力检测、模型别名
│   │   │   ├── chatModelCapabilities.ts    ★ 模型能力检测
│   │   │   ├── endpointTypes.ts            ★ endpoint 类型定义
│   │   │   ├── modelAliasRegistry.ts       ★ 模型别名注册
│   │   │   ├── endpointProvider.ts         endpoint provider 接口
│   │   │   ├── domainService.ts            域名服务
│   │   │   └── licenseAgreement.ts         许可协议
│   │   ├── node/                      # Node.js 实现
│   │   │   ├── chatEndpoint.ts             ★★★ 核心：header 构建、请求配置
│   │   │   ├── messagesApi.ts              ★★ Anthropic Messages API 实现
│   │   │   ├── responsesApi.ts             ★★ OpenAI Responses API 实现
│   │   │   ├── copilotChatEndpoint.ts      ★ Copilot 特定 endpoint 配置
│   │   │   ├── proxyModelHelper.ts         proxy model helper
│   │   │   ├── automodeService.ts          automode 服务
│   │   │   ├── modelMetadataFetcher.ts     模型元数据获取
│   │   │   ├── embeddingsEndpoint.ts       embeddings endpoint
│   │   │   ├── routerDecisionFetcher.ts    路由决策
│   │   │   └── proxy*.ts                   各种 proxy endpoint
│   │   └── vscode-node/               # VSCode 特定实现
│   │       ├── extChatEndpoint.ts          扩展 chat endpoint
│   │       └── extChatTokenizer.ts         tokenizer
│   └── networking/common/
│       └── anthropic.ts                ★★★ Anthropic 协议层（模型特性检测、context management）
│
├── extension/                         # 扩展层（VSCode 集成逻辑）
│   ├── agents/node/adapters/
│   │   ├── anthropicAdapter.ts         ★ Anthropic adapter（tool 处理等）
│   │   └── types.ts                    adapter 类型
│   └── byok/                          # BYOK（Bring Your Own Key）
│       ├── common/
│       │   ├── geminiMessageConverter.ts        Gemini 消息格式转换
│       │   ├── geminiFunctionDeclarationConverter.ts  Gemini 函数声明转换
│       │   ├── anthropicMessageConverter.ts     Anthropic 消息格式转换
│       │   └── test/                            转换器测试
│       └── vscode-node/
│           ├── geminiNativeProvider.ts           Gemini 原生 provider
│           ├── anthropicProvider.ts              Anthropic provider
│           └── ...
│
└── test/                              # 测试
```

## 核心文件详解

### ★★★ `chatEndpoint.ts` — 请求配置核心

**本项目镜像目标**：`src/lib/anthropic/features.ts`

关键函数和搜索模式：

| 函数/概念 | Grep 模式 | 说明 |
|----------|-----------|------|
| Header 构建 | `getExtraHeaders` | anthropic-beta、capi-beta-1 等 header |
| Beta features | `anthropic-beta` | beta feature 字符串列表 |
| 模型判断 | `isAnthropicModel`、`isGeminiModel` | 按 vendor/family 区分模型 |
| 请求参数 | `maxTokens`、`temperature` | 请求 body 构建逻辑 |

### ★★★ `anthropic.ts`（platform/networking） — 模型特性检测

**本项目镜像目标**：`src/lib/anthropic/features.ts`

| 函数 | 本项目对应 | 说明 |
|------|-----------|------|
| `modelSupportsInterleavedThinking` | `features.ts:modelSupportsInterleavedThinking` | 哪些模型支持 interleaved thinking |
| `modelSupportsContextEditing` | `features.ts:modelSupportsContextEditing` | 哪些模型支持 context editing |
| `modelSupportsToolSearch` | `features.ts:modelSupportsToolSearch` | 哪些模型支持 tool search |
| `buildContextManagement` | `features.ts:buildContextManagement` | context management 配置构建 |
| `getContextManagementFromConfig` | （内联于 buildContextManagement） | 默认参数值来源 |

### ★★ `messagesApi.ts` — Anthropic Messages API

**本项目镜像目标**：`src/lib/anthropic/client.ts`

关注：请求 body 构建、system prompt 处理、streaming 处理。

### ★★ `responsesApi.ts` — OpenAI Responses API

**本项目镜像目标**：`src/lib/openai/responses-client.ts`

### ★ `chatModelCapabilities.ts` — 模型能力

**本项目镜像目标**：`src/lib/models/endpoint.ts`

### ★ `modelAliasRegistry.ts` — 模型别名

**本项目镜像目标**：`src/lib/models/resolver.ts`

### ★ `anthropicAdapter.ts` — Tool 处理

**本项目镜像目标**：`src/lib/anthropic/sanitize.ts`

关注：server tool use 转换、tool_use/tool_result 配对处理。

## 本项目与 vscode-copilot-chat 的功能映射

| vscode-copilot-chat | 本项目 | 同步状态 |
|---------------------|--------|---------|
| `chatEndpoint.ts:getExtraHeaders` | `features.ts:buildAnthropicBetaHeaders` | 需定期检查 |
| `anthropic.ts:modelSupportsInterleavedThinking` | `features.ts:modelSupportsInterleavedThinking` | 需定期检查 |
| `anthropic.ts:modelSupportsContextEditing` | `features.ts:modelSupportsContextEditing` | 需定期检查 |
| `anthropic.ts:modelSupportsToolSearch` | `features.ts:modelSupportsToolSearch` | 需定期检查 |
| `anthropic.ts:buildContextManagement` | `features.ts:buildContextManagement` | 需定期检查 |
| `modelAliasRegistry.ts` | `models/resolver.ts` MODEL_PREFERENCE | 需定期检查 |
| `chatModelCapabilities.ts` | `models/endpoint.ts` | 已覆盖 |
| server tool use 处理 | `sanitize.ts:processToolBlocks` | 已覆盖 |
| BYOK Gemini/Anthropic converters | 不需要（本项目直连 Copilot API） | N/A |

## 查询流程

### Step 1：确定查询目标

| 想了解的内容 | 首选文件 | 搜索模式 |
|-------------|---------|---------|
| Header 构建逻辑 | `chatEndpoint.ts` | `getExtraHeaders`、`anthropic-beta` |
| 模型特性检测 | `anthropic.ts` | `modelSupports`、`Interleaved` |
| Context management | `anthropic.ts` | `buildContextManagement`、`clear_thinking` |
| 模型别名/解析 | `modelAliasRegistry.ts` | `alias`、`family` |
| Messages API 请求 | `messagesApi.ts` | `sendRequest`、`createMessage` |
| Responses API 请求 | `responsesApi.ts` | `sendRequest`、`createResponse` |
| Tool 处理 | `anthropicAdapter.ts` | `server_tool_use`、`tool_search` |
| 模型能力声明 | `chatModelCapabilities.ts` | `capabilities`、`supports` |
| Gemini 格式转换 | `byok/common/gemini*.ts` | `Content`、`Part`、`FunctionDeclaration` |

### Step 2：使用 Grep 搜索

```
# 在参考项目中搜索
Grep pattern="your_pattern" path="refs/vscode-copilot-chat/src"

# 限定特定子目录（减少噪音）
Grep pattern="your_pattern" path="refs/vscode-copilot-chat/src/platform/endpoint"
Grep pattern="your_pattern" path="refs/vscode-copilot-chat/src/platform/networking"
Grep pattern="your_pattern" path="refs/vscode-copilot-chat/src/extension/agents"
```

### Step 3：对比验证

找到参考实现后，与本项目对应模块对比，确保行为一致。

## 常见查询场景

### 场景 1：新增 beta feature

```
1. Grep "anthropic-beta" 在 chatEndpoint.ts 中
2. 找到 getExtraHeaders，获取完整的 beta feature 列表和条件
3. 对比本项目 features.ts 的 buildAnthropicBetaHeaders
4. 补充缺失的 feature
```

### 场景 2：新模型支持检查

```
1. 在 chatModelCapabilities.ts 中搜索模型名/family
2. 在 anthropic.ts 中检查 modelSupports* 函数的模型列表
3. 在 chatEndpoint.ts 中检查是否有特殊 header 处理
4. 验证本项目的 features.ts 和 resolver.ts 是否覆盖
```

### 场景 3：理解某个 API 行为

```
1. 确定是 Anthropic 还是 OpenAI 端点
2. 读取对应的 messagesApi.ts 或 responsesApi.ts
3. 追踪请求构建流程：payload → headers → fetch
4. 对比本项目的 client.ts 实现
```

### 场景 4：调试「为什么 Copilot 返回了意外的响应」

```
1. 先看本项目发送的 header 和 body 是否与 vscode-copilot-chat 一致
2. 重点检查：anthropic-beta header、capi-beta-1、X-Initiator
3. 检查 model name 是否正确解析
4. 检查是否遗漏了必要的请求参数（如 context_management）
```

## 同步更新提醒

当 `refs/vscode-copilot-chat/` 通过 `refs/sync-refs.sh` 更新后，应检查以下文件的变化：

1. **`chatEndpoint.ts`** — 新的 header 或 beta feature？
2. **`anthropic.ts`** — 新的模型特性检测或 context management 参数变化？
3. **`modelAliasRegistry.ts`** — 新的模型别名？
4. **`messagesApi.ts`** / **`responsesApi.ts`** — API 调用方式变化？
5. **`chatModelCapabilities.ts`** — 模型能力声明变化？

变化应同步到本项目的对应模块（参见上方映射表）。
