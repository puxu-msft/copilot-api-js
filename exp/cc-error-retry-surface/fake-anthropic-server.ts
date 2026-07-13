// 最小 fake Anthropic /v1/messages 服务器 —— 直接喂 Claude Code 客户端精确 SSE 帧序列，
// 观察它对 pre-content / post-content × overloaded_error / api_error 的真实反应（是否重发整轮）。
// 用途：验证 exp/cc-error-retry-surface/FINDINGS.md 的待实测项（uLs 前台白名单 / pre-vs-post-content 分叉）。
// 绝不碰 4141 主服务器；本 server 只监听自己的端口。
//
// 每个进入的请求都会自增计数并打到 stderr（带时间戳）——一次 `claude -p` 若触发重发，会看到 >1 次命中。
// VARIANT 环境变量选帧序列；PORT 选端口。

const VARIANT = process.env.VARIANT ?? "happy"
const PORT = Number(process.env.PORT ?? "4199")

let hitCount = 0

// pre-commit 400 error 变体：返回真 HTTP 400 + 特定 error.message，测 CC 自愈重试腿（§1c）是否触发。
// 每个 message 对准一条 CC onError A-leg（app.pretty.js 的 H8i/C8i/mid-conv-system/media 等）。
const ERROR_400_BODIES: Record<string, { status: number; type: string; message: string }> = {
  "err-thinking-signature": {
    status: 400,
    type: "invalid_request_error",
    // H8i (170081): thinking signature 相关 → retry:thinking-signature-strip（剥所有 thinking 块）
    message: "messages.1.content.0: Invalid `signature` in `thinking` block. The signature could not be verified.",
  },
  "err-thinking-cannot-modify": {
    status: 400,
    type: "invalid_request_error",
    // H8i 另一支：thinking block cannot be modified（本项目 quarantine 处理的那个 400）
    message: "messages.1.content.0.thinking: thinking blocks or redacted_thinking blocks cannot be modified",
  },
  "err-thinking-type": {
    status: 400,
    type: "invalid_request_error",
    // C8i (170088): thinking.type not supported → retry:thinking-type（切 enabled↔adaptive）
    message: "thinking.type: `enabled` is not supported for this model. Use `adaptive` instead.",
  },
  "err-mid-conv-system": {
    status: 400,
    type: "invalid_request_error",
    // _7n (170073): Unexpected role system → retry:mid-conv-system
    message: "messages.2.role: Unexpected role \"system\". The input message role must be `user` or `assistant`.",
  },
  "err-plain-400": {
    status: 400,
    type: "invalid_request_error",
    // 不匹配任何自愈腿 → 应硬停不重试（负样本对照）
    message: "some unmatched 400 error that no self-heal leg claims",
  },
  "err-media-image": {
    status: 400,
    type: "invalid_request_error",
    // d7n media：图片处理错 → retry:media-strip（需请求里有 image 块才有意义，此处测是否仍重试）
    message: "messages.1.content.0.image: Could not process image. The image format is not supported.",
  },
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const MSG_ID = "msg_fake_0001"

function messageStart(): string {
  return sse("message_start", {
    type: "message_start",
    message: {
      id: MSG_ID,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  })
}

function textBlock(text: string, index = 0): string {
  return (
    sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }) +
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }) +
    sse("content_block_stop", { type: "content_block_stop", index })
  )
}

function thinkingBlock(text: string, index = 0): string {
  return (
    sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }) +
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } }) +
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "fakesig" } }) +
    sse("content_block_stop", { type: "content_block_stop", index })
  )
}

function errorFrame(errType: string, message: string): string {
  return sse("error", { type: "error", error: { type: errType, message } })
}

function cleanEnd(): string {
  return (
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
    sse("message_stop", { type: "message_stop" })
  )
}

// 帧序列变体
function buildBody(): string {
  switch (VARIANT) {
    case "happy":
      return messageStart() + textBlock("Hello from fake server.") + cleanEnd()

    // pre-content：message_start 后无真实内容块就发 overloaded error
    case "pre-content-overloaded":
      return messageStart() + sse("ping", { type: "ping" }) + errorFrame("overloaded_error", "fake overloaded (pre-content)")

    // pre-content 但先有 thinking 块（thinking 不算真实内容）
    case "pre-content-thinking-overloaded":
      return messageStart() + thinkingBlock("thinking hard...") + errorFrame("overloaded_error", "fake overloaded (post-thinking)")

    // post-content：先吐真实 text 块，再发 overloaded error
    case "post-content-overloaded":
      return messageStart() + textBlock("Partial answer so far. ") + errorFrame("overloaded_error", "fake overloaded (post-content)")

    // 边界：仅 message_start（无 ping 无块），再 overloaded —— 测 message_start 是否影响重试
    case "bare-overloaded":
      return messageStart() + errorFrame("overloaded_error", "fake overloaded (bare)")

    // 边界：连 message_start 都没有，直接 overloaded —— 极端情形
    case "nothing-overloaded":
      return errorFrame("overloaded_error", "fake overloaded (nothing)")

    // 边界：未完成的 thinking 块（start+delta，无 stop），再 overloaded —— 测「完成」vs「开始」
    case "incomplete-thinking-overloaded":
      return (
        messageStart() +
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "partial think" } }) +
        errorFrame("overloaded_error", "fake overloaded (incomplete-thinking)")
      )

    // pre-content api_error（预期：降级非流式重发）
    case "pre-content-api-error":
      return messageStart() + sse("ping", { type: "ping" }) + errorFrame("api_error", "fake api_error (pre-content)")

    // post-content api_error（预期：partial-finalize 注入 text，不重试）
    case "post-content-api-error":
      return messageStart() + textBlock("Partial answer so far. ") + errorFrame("api_error", "fake api_error (post-content)")

    default:
      return messageStart() + textBlock("unknown variant") + cleanEnd()
  }
}

Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/hits") {
      return new Response(JSON.stringify({ hitCount }), { headers: { "content-type": "application/json" } })
    }
    // 任意 /v1/messages（及变体前缀）都当作一次请求
    if (req.method === "POST" && url.pathname.endsWith("/messages")) {
      hitCount++
      const n = hitCount
      const bodyText = await req.text().catch(() => "")

      // 有状态变体 sig-conv：hit1 返回带签名 thinking + text（进 CC 历史）；hit2+ 该请求应含 thinking 块，
      // 返回 thinking-signature 400 → 看 CC 是否剥块并重发（旗舰自愈委派：对应本项目 quarantine）。
      if (VARIANT === "sig-conv") {
        const reqHasThinking = bodyText.includes('"thinking"')
        process.stderr.write(`[fake ${new Date().toISOString()}] HIT #${n} sig-conv reqHasThinking=${reqHasThinking} bytes_in=${bodyText.length}\n`)
        if (n === 1) {
          const body = messageStart() + thinkingBlock("let me think") + textBlock("Turn 1 answer.") + cleanEnd()
          return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
        }
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block. The signature could not be verified." } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }

      // pre-commit 400 变体：返回真 HTTP 400 error（尚未 commit 200），测 CC 自愈重试腿
      const err400 = ERROR_400_BODIES[VARIANT]
      if (err400) {
        process.stderr.write(`[fake ${new Date().toISOString()}] HIT #${n} → returning HTTP ${err400.status} (${VARIANT}) bytes_in=${bodyText.length}\n`)
        return new Response(JSON.stringify({ type: "error", error: { type: err400.type, message: err400.message } }), {
          status: err400.status,
          headers: { "content-type": "application/json" },
        })
      }

      // 抽 querySource 相关线索：CC 会带 metadata.user_id / system prompt；记录 body 大小 + 是否流式
      let stream = false
      try {
        stream = JSON.parse(bodyText)?.stream === true
      } catch {}
      process.stderr.write(`[fake ${new Date().toISOString()}] HIT #${n} ${url.pathname} stream=${stream} bytes=${bodyText.length} VARIANT=${VARIANT}\n`)

      if (!stream) {
        // 非流式（CC 降级路径会打这个）——回一个合法非流式 JSON
        process.stderr.write(`[fake] HIT #${n} is NON-STREAM (CC downgraded to non-streaming)\n`)
        const nonStream = {
          id: MSG_ID,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "non-stream fallback reply" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }
        return new Response(JSON.stringify(nonStream), { headers: { "content-type": "application/json" } })
      }

      // reset-* 变体：流出若干帧后 abrupt 断流（controller.error 制造非正常终止 ≈ 连接错误/premature close），
      // 测 CC 在「不同块完成状态」下是否把它当可重试连接错误而重发（对比 error 帧的窗口）。
      if (VARIANT.startsWith("reset-")) {
        const prefix = buildResetPrefix(VARIANT)
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(prefix))
            // 稍等后 abrupt error（不发 message_stop、不 close）
            setTimeout(() => {
              try {
                controller.error(new Error("simulated upstream connection reset"))
              } catch {}
            }, 120)
          },
        })
        process.stderr.write(`[fake ${new Date().toISOString()}] HIT #${n} reset variant=${VARIANT} → abrupt abort after prefix\n`)
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
      }

      const body = buildBody()
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      })
    }
    return new Response("ok", { status: 200 })
  },
})

// reset-* 变体的前缀帧（断流前发的部分）
function buildResetPrefix(variant: string): string {
  switch (variant) {
    case "reset-nothing":
      return messageStart() // 只 message_start，无块
    case "reset-after-thinking":
      return messageStart() + thinkingBlock("thinking done") // 完成的 thinking 块
    case "reset-after-anchor-closed":
      return messageStart() + textBlock("", 0) // 完成的【空 text】块（模拟 anchor 关闭后）
    case "reset-after-anchor-open":
      // 打开的空 text 块（无 stop，模拟 anchor 未关）
      return (
        messageStart() +
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
      )
    case "reset-after-text":
      return messageStart() + textBlock("Real partial answer.", 0) // 完成的【真实 text】块
    default:
      return messageStart()
  }
}

process.stderr.write(`[fake] listening on :${PORT} VARIANT=${VARIANT}\n`)
