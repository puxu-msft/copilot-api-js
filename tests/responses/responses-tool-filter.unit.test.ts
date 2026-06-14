/**
 * Tests for Responses API tool filtering (image_generation stripping).
 *
 * Verifies stripImageGenerationTool respects the
 * `openai-responses.strip_image_generation_tool` config flag and removes only
 * the image_generation builtin tool, leaving other tools intact.
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ResponsesPayload } from "~/types/api/openai-responses"

import { stripImageGenerationTool } from "~/lib/openai/responses-tool-filter"
import { setResponsesConfig } from "~/lib/state"

function payloadWith(tools: ResponsesPayload["tools"]): ResponsesPayload {
  return { model: "gpt-5", input: "hi", tools } as ResponsesPayload
}

describe("stripImageGenerationTool", () => {
  afterEach(() => {
    // Restore default (disabled) so tests don't leak state.
    setResponsesConfig({ stripImageGenerationTool: false })
  })

  test("does nothing when the flag is disabled", () => {
    setResponsesConfig({ stripImageGenerationTool: false })
    const payload = payloadWith([{ type: "image_generation" } as never, { type: "web_search" } as never])
    const removed = stripImageGenerationTool(payload)
    expect(removed).toBe(0)
    expect(payload.tools).toHaveLength(2)
  })

  test("removes image_generation when enabled, keeping other tools", () => {
    setResponsesConfig({ stripImageGenerationTool: true })
    const payload = payloadWith([{ type: "function", name: "do_thing" } as never, { type: "image_generation" } as never, { type: "web_search" } as never])
    const removed = stripImageGenerationTool(payload)
    expect(removed).toBe(1)
    expect(payload.tools?.map((t) => (t as { type?: string }).type)).toEqual(["function", "web_search"])
  })

  test("matches image_generation on the name field too", () => {
    setResponsesConfig({ stripImageGenerationTool: true })
    const payload = payloadWith([{ type: "function", name: "image_generation" } as never])
    const removed = stripImageGenerationTool(payload)
    expect(removed).toBe(1)
    expect(payload.tools).toHaveLength(0)
  })

  test("is a no-op when there are no tools", () => {
    setResponsesConfig({ stripImageGenerationTool: true })
    const payload = payloadWith(undefined)
    expect(stripImageGenerationTool(payload)).toBe(0)
  })

  test("leaves payload untouched when no image_generation present", () => {
    setResponsesConfig({ stripImageGenerationTool: true })
    const payload = payloadWith([{ type: "web_search" } as never])
    const removed = stripImageGenerationTool(payload)
    expect(removed).toBe(0)
    expect(payload.tools).toHaveLength(1)
  })
})
