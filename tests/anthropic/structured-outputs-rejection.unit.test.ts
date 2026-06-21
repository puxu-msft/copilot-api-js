/**
 * structured-outputs-rejection-retry + the `strip-structured-outputs` prepare
 * step (Vertex `allowedPartnerModelFeatures` org-policy 400).
 *
 * Root cause reproduced from a real history entry: Claude Code's title
 * generator sends `output_config.format` (a `{ title }` json_schema). For GHC
 * accounts routed to Vertex AI whose org policy disallows `structured_outputs`,
 * the upstream returns a 400 whose detail lives in the raw HTTPError
 * responseText (a JSON *array*). The strategy strips `output_config.format`,
 * retries, and fixates the incompatibility so prepare pre-emptively strips it.
 */

import {
  //
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ApiError } from "~/lib/error"
import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  isAnthropicPartnerFeatureUnsupported,
  loadPersistedFeatureNegotiation,
  markAnthropicPartnerFeatureUnsupported,
  persistFeatureNegotiation,
  resetAnthropicFeatureNegotiationForTesting,
  STRUCTURED_OUTPUTS_PARTNER_FEATURE,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  ANTHROPIC_PREPARE_STEPS,
  prepareAnthropicRequest,
  type PrepareStep,
} from "~/lib/anthropic/request-preparation"
import { PATHS } from "~/lib/config/paths"
import { HTTPError } from "~/lib/error"
import {
  //
  createStructuredOutputsRejectionStrategy,
  parseDisallowedPartnerFeature,
} from "~/lib/request/strategies/structured-outputs-rejection-retry"

const MODEL = "claude-sonnet-4.6"

// The real upstream rawBody (array-wrapped) captured from history req_1782051200430_1.
const VERTEX_RAW_BODY = JSON.stringify([
  {
    error: {
      code: 400,
      message:
        "Organization Policy constraint constraints/vertexai.allowedPartnerModelFeatures violated for `projects/524636045653` attempting to use a disallowed feature structured_outputs for Partner model claude-sonnet-4-6. Please contact your organization administrator to fix this violation by adding `publishers/anthropic/models/claude-sonnet-4-6:structured_outputs` to the allowed values.",
      status: "FAILED_PRECONDITION",
    },
  },
])

function makeVertexError(feature = "structured_outputs"): ApiError {
  const body = VERTEX_RAW_BODY.replace("structured_outputs", feature)
  const http = new HTTPError("Failed to create chat completions", 400, body)
  return { type: "bad_request", status: 400, message: "HTTP 400: Failed to create chat completions", raw: http }
}

function basePayload(): MessagesPayload {
  return {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    },
  }
}

// Sandbox the persisted path so mark()'s debounced persist never touches the
// real negotiation-states.json.
let tmpDir = ""
let realPath = ""

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neg-structured-"))
  realPath = PATHS.NEGOTIATION_STATES
  PATHS.NEGOTIATION_STATES = path.join(tmpDir, "negotiation-states.json")
})

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

afterAll(async () => {
  PATHS.NEGOTIATION_STATES = realPath
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("parseDisallowedPartnerFeature", () => {
  test("extracts structured_outputs from the array-form responseText", () => {
    expect(parseDisallowedPartnerFeature(makeVertexError())).toBe("structured_outputs")
  })

  test("extracts other partner feature names too", () => {
    expect(parseDisallowedPartnerFeature(makeVertexError("extended_thinking"))).toBe("extended_thinking")
  })

  test("returns null for an unrelated 400", () => {
    const http = new HTTPError("bad", 400, JSON.stringify({ error: { message: "messages: Field required" } }))
    const err: ApiError = { type: "bad_request", status: 400, message: "HTTP 400: bad", raw: http }
    expect(parseDisallowedPartnerFeature(err)).toBeNull()
  })
})

describe("createStructuredOutputsRejectionStrategy", () => {
  test("canHandle matches the Vertex structured_outputs 400", () => {
    const strategy = createStructuredOutputsRejectionStrategy<MessagesPayload>()
    expect(strategy.canHandle(makeVertexError())).toBe(true)
  })

  test("canHandle ignores other disallowed partner features (no safe strip target)", () => {
    const strategy = createStructuredOutputsRejectionStrategy<MessagesPayload>()
    expect(strategy.canHandle(makeVertexError("extended_thinking"))).toBe(false)
  })

  test("canHandle ignores unrelated 400s and non-400s", () => {
    const strategy = createStructuredOutputsRejectionStrategy<MessagesPayload>()
    const unrelated: ApiError = {
      type: "bad_request",
      status: 400,
      message: "HTTP 400: bad",
      raw: new HTTPError("bad", 400, JSON.stringify({ error: { message: "messages: Field required" } })),
    }
    expect(strategy.canHandle(unrelated)).toBe(false)
    expect(strategy.canHandle({ ...makeVertexError(), type: "server_error", status: 500 })).toBe(false)
  })

  test("is one-shot per request instance", async () => {
    const strategy = createStructuredOutputsRejectionStrategy<MessagesPayload>()
    expect(strategy.canHandle(makeVertexError())).toBe(true)
    await strategy.handle(makeVertexError(), basePayload(), { attempt: 0, originalPayload: basePayload(), model: undefined, maxRetries: 5 })
    expect(strategy.canHandle(makeVertexError())).toBe(false)
  })

  test("handle strips output_config.format (keeping effort) and fixates the feature", async () => {
    const strategy = createStructuredOutputsRejectionStrategy<MessagesPayload>()
    const action = await strategy.handle(makeVertexError(), basePayload(), {
      attempt: 0,
      originalPayload: basePayload(),
      model: undefined,
      maxRetries: 5,
    })

    expect(action.action).toBe("retry")
    if (action.action !== "retry") throw new Error("expected retry")
    expect(action.payload.output_config).toEqual({ effort: "high" })
    expect(isAnthropicPartnerFeatureUnsupported(MODEL, STRUCTURED_OUTPUTS_PARTNER_FEATURE)).toBe(true)
  })

  test("handle drops output_config entirely when format was its only key", async () => {
    const strategy = createStructuredOutputsRejectionStrategy<MessagesPayload>()
    const payload: MessagesPayload = { ...basePayload(), output_config: { format: { type: "json_schema", schema: {} } } }
    const action = await strategy.handle(makeVertexError(), payload, { attempt: 0, originalPayload: payload, model: undefined, maxRetries: 5 })
    if (action.action !== "retry") throw new Error("expected retry")
    expect(action.payload.output_config).toBeUndefined()
  })
})

describe("strip-structured-outputs prepare step", () => {
  // Isolate the single step via the DI seam — avoids cache-control / build-headers
  // (which read runtime state/token). buildWirePayload still deep-clones
  // output_config, so the input payload is never mutated.
  const stripStep = ANTHROPIC_PREPARE_STEPS.find((s) => s.name === "strip-structured-outputs") as PrepareStep
  const stripOnly: ReadonlyArray<PrepareStep> = [stripStep]

  test("preserves output_config.format when the feature is NOT marked unsupported", () => {
    const { wire } = prepareAnthropicRequest(basePayload(), undefined, stripOnly)
    expect((wire.output_config as { format?: unknown }).format).toBeDefined()
  })

  test("strips output_config.format (keeping effort) once the feature is fixated", () => {
    markAnthropicPartnerFeatureUnsupported(MODEL, STRUCTURED_OUTPUTS_PARTNER_FEATURE)
    const { wire } = prepareAnthropicRequest(basePayload(), undefined, stripOnly)
    expect(wire.output_config).toEqual({ effort: "high" })
  })

  test("drops output_config entirely when format was its only key", () => {
    markAnthropicPartnerFeatureUnsupported(MODEL, STRUCTURED_OUTPUTS_PARTNER_FEATURE)
    const payload: MessagesPayload = { ...basePayload(), output_config: { format: { type: "json_schema", schema: {} } } }
    const { wire } = prepareAnthropicRequest(payload, undefined, stripOnly)
    expect(wire.output_config).toBeUndefined()
  })

  test("does not strip for a different (still-allowed) model", () => {
    markAnthropicPartnerFeatureUnsupported(MODEL, STRUCTURED_OUTPUTS_PARTNER_FEATURE)
    const payload: MessagesPayload = { ...basePayload(), model: "claude-opus-4-6" }
    const { wire } = prepareAnthropicRequest(payload, undefined, stripOnly)
    expect((wire.output_config as { format?: unknown }).format).toBeDefined()
  })
})

describe("partner-feature negotiation persistence", () => {
  test("roundtrips the partnerFeatures category through persist + reload", async () => {
    markAnthropicPartnerFeatureUnsupported(MODEL, STRUCTURED_OUTPUTS_PARTNER_FEATURE)
    await persistFeatureNegotiation()
    await resetAnthropicFeatureNegotiationForTesting()
    expect(isAnthropicPartnerFeatureUnsupported(MODEL, STRUCTURED_OUTPUTS_PARTNER_FEATURE)).toBe(false)
    await loadPersistedFeatureNegotiation()
    expect(isAnthropicPartnerFeatureUnsupported(MODEL, STRUCTURED_OUTPUTS_PARTNER_FEATURE)).toBe(true)
  })
})
