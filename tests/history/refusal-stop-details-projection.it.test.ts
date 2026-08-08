import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  PartialResponseInfo,
  ResponseData,
} from "~/lib/context/request"
import type { HistoryEntry } from "~/lib/history/types"

import { createRequestContext } from "~/lib/context/request"
import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { recordToHistoryEntry } from "~/lib/history/v3/projection"
import {
  //
  drainV3Writer,
  enqueueModelOperation,
  getV3Operation,
  resetV3WriterForTests,
} from "~/lib/history/v3/store"
import {
  //
  drainModelOperationTerminalSubscribers,
  resetModelOperationTerminalBusForTests,
  subscribeModelOperationTerminals,
} from "~/lib/history/v3/terminal-bus"

const NULL_CATEGORY_BYTES = '{"type":"refusal","category":null,"explanation":"API integrators: you can reduce refusals..."}'
const BIO_CATEGORY_BYTES = '{"type":"refusal","category":"bio","explanation":"API integrators: you can reduce refusals..."}'
const CYBER_CATEGORY_BYTES = '{"type":"refusal","category":"cyber","explanation":"This request triggered restrictions on violative cyber content..."}'

function rawStopDetails(bytes: string): unknown {
  return JSON.parse(bytes)
}

function assertVerbatimStopDetails(entry: HistoryEntry, expectedBytes: string): void {
  const projected = entry.attempts?.at(-1)?.upstreamResponse?.stopDetails
  expect(projected).toBeDefined()
  expect(JSON.stringify(projected)).toBe(expectedBytes)
}

async function persistAndProject(settle: (ctx: RequestContext) => void): Promise<HistoryEntry> {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  ctx.beginAttempt({})
  settle(ctx)
  ctx.finalizeModelOperationDelivery()
  await ctx.whenModelOperationFinalized()
  await drainModelOperationTerminalSubscribers()
  await drainV3Writer()

  const stored = getV3Operation(ctx.id)
  expect(stored).toBeDefined()
  return recordToHistoryEntry(stored!)
}

function response(stopDetails: unknown): ResponseData {
  return {
    success: true,
    model: "claude-opus-5",
    usage: { input_tokens: 8, output_tokens: 3 },
    content: null,
    stop_reason: "refusal",
    stopDetails,
  }
}

function partial(stopDetails: unknown): PartialResponseInfo {
  return {
    usage: { input_tokens: 8, output_tokens: 3 },
    content: null,
    stop_reason: "refusal",
    stopDetails,
  }
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
  subscribeModelOperationTerminals(enqueueModelOperation)
})

afterEach(async () => {
  await drainV3Writer()
  closeDatabase()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
})

describe("History V3 refusal stop_details projection", () => {
  test("complete persists and projects category:null without collapsing provenance", async () => {
    const entry = await persistAndProject((ctx) => ctx.complete(response(rawStopDetails(NULL_CATEGORY_BYTES))))

    expect(entry.state).toBe("completed")
    assertVerbatimStopDetails(entry, NULL_CATEGORY_BYTES)
  })

  test("proxy-introduced fail preserves the successful upstream leg's raw stop_details", async () => {
    const entry = await persistAndProject((ctx) =>
      ctx.fail("claude-opus-5", new Error("proxy suppressed refusal"), partial(rawStopDetails(BIO_CATEGORY_BYTES)), {
        upstreamSucceeded: true,
      }),
    )

    expect(entry.state).toBe("failed")
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
    assertVerbatimStopDetails(entry, BIO_CATEGORY_BYTES)
  })

  test("ordinary fail persists and projects raw stop_details", async () => {
    const entry = await persistAndProject((ctx) =>
      ctx.fail("claude-opus-5", new Error("upstream refusal failed"), partial(rawStopDetails(CYBER_CATEGORY_BYTES))),
    )

    expect(entry.state).toBe("failed")
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    assertVerbatimStopDetails(entry, CYBER_CATEGORY_BYTES)
  })

  test("abort persists and projects raw stop_details observed before disconnect", async () => {
    const entry = await persistAndProject((ctx) => ctx.abort("claude-opus-5", partial(rawStopDetails(NULL_CATEGORY_BYTES))))

    expect(entry.state).toBe("aborted")
    assertVerbatimStopDetails(entry, NULL_CATEGORY_BYTES)
  })
})
