import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { ENDPOINT } from "~/lib/models/endpoint"
import { errorLabelFor } from "~/lib/transport/http-transport"

describe("errorLabelFor", () => {
  test("Anthropic messages endpoint gets a messages-specific label", () => {
    expect(errorLabelFor(ENDPOINT.MESSAGES)).toBe("Failed to create messages")
  })

  test("Responses endpoint gets a responses-specific label", () => {
    expect(errorLabelFor(ENDPOINT.RESPONSES)).toBe("Failed to create responses")
  })

  test("Chat Completions endpoint keeps the chat completions label", () => {
    expect(errorLabelFor(ENDPOINT.CHAT_COMPLETIONS)).toBe("Failed to create chat completions")
  })

  // Gemini translates to /chat/completions upstream, so it shares the chat
  // completions label (legacy parity — no dedicated generateContent label).
  test("unknown / translated endpoints fall back to chat completions", () => {
    expect(errorLabelFor("/embeddings")).toBe("Failed to create chat completions")
  })
})
