import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { assertNever } from "~/lib/observability"

import {
  //
  processAnthropicSystem,
  processOpenAIMessages,
  processResponsesInstructions,
} from "./override"

/**
 * 单一格式分发入口（spec docs/spec/2026-07-20-inbound-system-prompt-dispatch-hook.md §3.1）：
 * 按 `env.clientFormat` 路由到既有 per-format system-prompt 注入函数。anthropic/cc/responses
 * 三个 codec 的 translateInbound（S1b）委托本函数，得到一个可插拔入站锚点。每分支逐字节镜像
 * 对应 codec 的现状逻辑（anthropic 有 !system early-return；cc/responses 无外层 early-return）。
 *
 * gemini 不经此入口：它在 translateInbound 中段对中间 CC messages 注入、且被 truncateBaseline
 * 时序钉死（gemini/codec.ts）——这里的 `gemini` case 是 passthrough，生产不触达，仅为穷尽 ClientFormat
 * + 自文档。新增第 5 个 ClientFormat 时 `assertNever` 编译期报错。
 */
export async function applyInboundSystemPrompt(env: RequestEnvelope): Promise<RequestEnvelope> {
  switch (env.clientFormat) {
    case "anthropic": {
      const body = env.body as MessagesPayload
      if (!body.system) return env
      const system = await processAnthropicSystem(body.system, body.model, "anthropic")
      return env.with({ body: { ...body, system } })
    }
    case "openai-cc": {
      const body = env.body as ChatCompletionsPayload
      const messages = await processOpenAIMessages(body.messages, body.model, "openai-cc")
      return env.with({ body: { ...body, messages } })
    }
    case "openai-responses": {
      const body = env.body as ResponsesPayload
      const instructions = await processResponsesInstructions(body.instructions, body.model, "openai-responses")
      return env.with({ body: { ...body, instructions } })
    }
    case "gemini": {
      return env
    }
    default: {
      return assertNever(env.clientFormat)
    }
  }
}
