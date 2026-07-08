/**
 * HTTP tests for POST /api/debug/dry-run-truncate.
 *
 * Verifies the offline dry-run endpoint replays the real tokenize+truncate
 * functions, surfaces the three token calibers side-by-side, and handles both
 * inline-payload and stored-history-entry inputs plus the 404/400 error paths.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { insertEntry } from "~/lib/history"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"
import { generateId } from "~/lib/utils"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-app"

const app = createFullTestApp()

function largeMessage(size: number): string {
  return "x".repeat(size)
}

function seedModel(): void {
  setModels({
    object: "list",
    data: [
      mockModel("claude-sonnet-4", {
        vendor: "Anthropic",
        capabilities: {
          family: "claude",
          type: "chat",
          tokenizer: "o200k_base",
          limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 16000, max_prompt_tokens: 1_000_000 },
        },
      }),
    ],
  })
}

async function postDryRun(body: unknown) {
  return app.request("/api/debug/dry-run-truncate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/debug/dry-run-truncate", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    seedModel()
    setStateForTests({ autoTruncate: true })
  })

  test("inline payload returns all three calibers side by side", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: largeMessage(4000) }))
    const res = await postDryRun({ format: "anthropic", payload: { model: "claude-sonnet-4", max_tokens: 1024, messages } })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.input.mode).toBe("payload")
    expect(body.input.format).toBe("anthropic")
    // The caliber gap is the whole point — char/4 and gpt-tokenizer must differ.
    expect(typeof body.calibers.gptTokenizer).toBe("number")
    expect(typeof body.calibers.charOver4).toBe("number")
    expect(body.calibers.charOver4).not.toBe(body.calibers.gptTokenizer)
    expect(body.preCheck).toBeDefined()
    expect(body.truncate).toBeDefined()
    expect(typeof body.truncate.wasTruncated).toBe("boolean")
  })

  test("entry replay parses the upstream-reported caliber from the error text", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: largeMessage(4000) }))
    const id = generateId()
    insertEntry({
      id,
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      state: "failed",
      clientRequest: { format: "anthropic-messages", model: "claude-sonnet-4", messages: messages as any, stream: true, body: { model: "claude-sonnet-4", messages, stream: true } },
      attempts: [
        {
          index: 0,
          durationMs: 0,
          error: "prompt is too long: 1001332 tokens > 1000000 maximum",
          upstreamResponse: {
            success: false,
            model: "claude-sonnet-4",
            usage: { input_tokens: 0, output_tokens: 0 },
            rawBody: "prompt is too long: 1001332 tokens > 1000000 maximum",
            body: null,
          },
        },
      ],
      _index: { derived: { failureReason: "prompt is too long: 1001332 tokens > 1000000 maximum" } },
    })

    const res = await postDryRun({ entryId: id })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.input.mode).toBe("entry")
    expect(body.input.entryId).toBe(id)
    expect(body.calibers.reported).toEqual({ current: 1001332, limit: 1000000 })
    // Anthropic real count is ~2x the gpt-tokenizer caliber — the core diagnostic.
    expect(body.ratios.reportedOverGpt).toBeGreaterThan(1)
    // The applied gpt-caliber target is derived from the reported numbers.
    expect(typeof body.limit.appliedGptTarget).toBe("number")
  })

  test("returns 404 for an unknown entry id", async () => {
    const res = await postDryRun({ entryId: "req_does_not_exist" })
    expect(res.status).toBe(404)
  })

  test("returns 400 when neither entryId nor payload is provided", async () => {
    const res = await postDryRun({})
    expect(res.status).toBe(400)
  })

  test("returns 400 for an unknown model", async () => {
    const res = await postDryRun({ payload: { model: "no-such-model", messages: [{ role: "user", content: "hi" }] } })
    expect(res.status).toBe(400)
  })

  test("returns 400 for invalid JSON body", async () => {
    const res = await app.request("/api/debug/dry-run-truncate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    expect(res.status).toBe(400)
  })

  test("returns 400 (not 500) for malformed payload — messages not an array", async () => {
    const res = await postDryRun({ payload: { model: "claude-sonnet-4", messages: "oops" } })
    expect(res.status).toBe(400)
  })

  test("returns 400 (not 500) for malformed payload — missing messages", async () => {
    const res = await postDryRun({ payload: { model: "claude-sonnet-4" } })
    expect(res.status).toBe(400)
  })

  test("returns 400 (not 500) for malformed block content inside an array payload", async () => {
    // messages IS an array (passes the structural guard) but content is a non-iterable
    // number — the deeper try/catch must turn the tokenizer TypeError into a 400.
    const res = await postDryRun({ payload: { model: "claude-sonnet-4", messages: [{ role: "user", content: 42 }] } })
    expect(res.status).toBe(400)
  })
})
