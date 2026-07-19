/**
 * Phase P0-T3 transport cleanup fault oracles.
 *
 * This suite intentionally separates three things:
 * - a positive control that proves each oracle observes the leaked resource/work;
 * - the cleanup behavior the legacy transport already gets right;
 * - future per-dispatch cancellation contracts that stay RED assets until P5.
 *
 * No production behavior or protocol is replaced here: HTTP uses the real node:http2 adapter, frames use guardSseIterable, and rate limiting uses the current AdaptiveRateLimiter implementation.
 */

import type { AddressInfo } from "node:net"

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import http2 from "node:http2"

import type { RateLimitedResult } from "~/lib/adaptive-rate-limiter"

import { AdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { HTTPError } from "~/lib/error"
import {
  //
  StreamClientAbortError,
  guardSseIterable,
} from "~/lib/stream"
import {
  //
  closeHttp2Sessions,
  http2Fetch,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"

import { waitUntil } from "../helpers/wait-until"

interface PendingHeadersHarness {
  readonly url: string
  readonly opened: Promise<void>
  readonly activeStreams: () => number
  close(): Promise<void>
}

async function createPendingHeadersHarness(): Promise<PendingHeadersHarness> {
  const server = http2.createServer()
  const sessions = new Set<http2.ServerHttp2Session>()
  let activeStreams = 0
  let resolveOpened!: () => void
  const opened = new Promise<void>((resolve) => {
    resolveOpened = resolve
  })

  server.on("session", (session) => {
    sessions.add(session)
    session.on("close", () => sessions.delete(session))
  })
  server.on("sessionError", () => {})
  server.on("stream", (stream) => {
    activeStreams += 1
    resolveOpened()
    stream.once("close", () => {
      activeStreams -= 1
    })
    // Deliberately never send response headers. The client owns cleanup.
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}/pending-headers`,
    opened,
    activeStreams: () => activeStreams,
    async close() {
      for (const session of sessions) session.destroy()
      sessions.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function createPendingFrameSource(): {
  source: AsyncIterable<{ data: string }>
  active: () => boolean
  returnCalls: () => number
} {
  let active = false
  let returnCalls = 0

  return {
    source: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<{ data: string }>> {
            active = true
            return new Promise(() => {
              // Pending upstream frame. Cleanup must arrive through return().
            })
          },
          async return(): Promise<IteratorResult<{ data: string }>> {
            returnCalls += 1
            active = false
            return { done: true, value: undefined }
          },
        }
      },
    },
    active: () => active,
    returnCalls: () => returnCalls,
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function executeWithCandidateSignal<T>(limiter: AdaptiveRateLimiter, fn: () => Promise<T>, signal: AbortSignal): Promise<RateLimitedResult<T>> {
  return limiter.execute(fn, { signal })
}

function rateLimitError(): HTTPError {
  return new HTTPError("Rate limited", 429, "")
}

afterEach(() => {
  setHttp2SessionFactoryForTests(undefined)
  closeHttp2Sessions()
})

describe("pending response headers cleanup", () => {
  test("oracle positive control: ignoring abort leaves the h2 stream active", async () => {
    const harness = await createPendingHeadersHarness()
    const session = http2.connect(new URL(harness.url).origin)
    session.on("error", () => {})
    const request = session.request({ ":method": "POST", ":path": "/pending-headers" })
    const ignoredAbort = new AbortController()

    try {
      request.end("{}")
      await harness.opened
      ignoredAbort.abort()
      await drainMicrotasks()

      expect(harness.activeStreams()).toBe(1)
    } finally {
      request.close(http2.constants.NGHTTP2_CANCEL)
      session.close()
      await waitUntil(() => harness.activeStreams() === 0, { label: "positive-control h2 stream close" })
      await harness.close()
    }
  })

  test("http2Fetch abort rejects pending headers and releases its owned stream", async () => {
    const harness = await createPendingHeadersHarness()
    setHttp2SessionFactoryForTests(() => http2.connect(new URL(harness.url).origin))
    const abort = new AbortController()

    try {
      const response = http2Fetch(harness.url, { method: "POST", body: "{}", signal: abort.signal })
      await harness.opened
      expect(harness.activeStreams()).toBe(1)

      abort.abort()

      await expect(response).rejects.toThrow(/abort/i)
      await waitUntil(() => harness.activeStreams() === 0, { label: "http2Fetch pending-header stream close" })
    } finally {
      closeHttp2Sessions()
      await harness.close()
    }
  })
})

describe("pending SSE frame cleanup", () => {
  test("oracle positive control: abort without guard leaves iterator.next active", async () => {
    const fixture = createPendingFrameSource()
    const iterator = fixture.source[Symbol.asyncIterator]()
    const ignoredAbort = new AbortController()

    void iterator.next()
    await drainMicrotasks()
    ignoredAbort.abort()
    await drainMicrotasks()

    expect(fixture.active()).toBe(true)
    expect(fixture.returnCalls()).toBe(0)

    await iterator.return?.()
    expect(fixture.active()).toBe(false)
    expect(fixture.returnCalls()).toBe(1)
  })

  test("guardSseIterable abort wakes pending next and invokes iterator.return", async () => {
    const fixture = createPendingFrameSource()
    const clientAbort = new AbortController()
    const guarded = guardSseIterable(fixture.source, {
      idleTimeoutMs: 0,
      clientSignal: clientAbort.signal,
    })
    const iterator = guarded[Symbol.asyncIterator]()

    const pending = iterator.next()
    await drainMicrotasks()
    expect(fixture.active()).toBe(true)

    clientAbort.abort()

    await expect(pending).rejects.toBeInstanceOf(StreamClientAbortError)
    await drainMicrotasks()
    expect(fixture.returnCalls()).toBe(1)
    expect(fixture.active()).toBe(false)
  })
})

describe("adaptive rate-limit queue and backoff cleanup", () => {
  test("P5 contract: candidate abort removes only that queued admission", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0.2,
      requestIntervalSeconds: 0.2,
    })
    let blockerCalls = 0
    const blocker = limiter.execute(async () => {
      blockerCalls += 1
      if (blockerCalls <= 2) throw rateLimitError()
      return "blocker"
    })
    // Attach immediately: cleanup in finally rejects this promise synchronously.
    void blocker.catch(() => {})
    const candidateAbort = new AbortController()
    let queuedCalls = 0

    try {
      await waitUntil(() => limiter.getStatus().mode === "rate-limited" && limiter.getStatus().queueLength === 1, {
        label: "rate limiter blocker backoff",
      })
      const queued = executeWithCandidateSignal(
        limiter,
        async () => {
          queuedCalls += 1
          return "queued"
        },
        candidateAbort.signal,
      )
      void queued.catch(() => {})
      const observed = queued.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      )
      candidateAbort.abort()

      const outcome = await Promise.race([observed, delay(50).then(() => ({ kind: "pending" as const }))])
      expect(outcome.kind).toBe("rejected")
      expect(limiter.getStatus().queueLength).toBe(1)
      expect(queuedCalls).toBe(0)
    } finally {
      limiter.rejectQueued()
      await Promise.allSettled([blocker])
    }
  })

  test("P5 contract: candidate abort stops a pending 429 backoff replay", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0.01,
      requestIntervalSeconds: 0.01,
      consecutiveSuccessesForRecovery: 1,
      gradualRecoverySteps: [0],
    })
    const candidateAbort = new AbortController()
    let calls = 0

    try {
      const result = executeWithCandidateSignal(
        limiter,
        async () => {
          calls += 1
          if (calls <= 2) throw rateLimitError()
          return "must-not-replay"
        },
        candidateAbort.signal,
      )
      await waitUntil(() => calls === 2 && limiter.getStatus().mode === "rate-limited" && limiter.getStatus().queueLength === 1, {
        label: "rate limiter retry backoff",
      })
      candidateAbort.abort()

      const outcome = await result.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      )
      expect(outcome.kind).toBe("rejected")
      expect(calls).toBe(2)
    } finally {
      limiter.rejectQueued()
    }
  })

  test("aborted in-flight request cannot shift the next queued admission when upstream also rejects", async () => {
    const limiter = new AdaptiveRateLimiter({ baseRetryIntervalSeconds: 0.01, requestIntervalSeconds: 0.01 })
    const gate = new AbortController()
    const firstAbort = new AbortController()
    let firstStarted = false
    const first = limiter.execute(
      async () => {
        firstStarted = true
        await new Promise<void>((resolve) => gate.signal.addEventListener("abort", () => resolve(), { once: true }))
        throw new Error("upstream unwound after abort")
      },
      { signal: firstAbort.signal },
    )
    await waitUntil(() => firstStarted, { label: "first in-flight limiter request" })
    limiter.forceRateLimitedMode()
    const second = limiter.execute(async () => "second-survived")

    firstAbort.abort()
    gate.abort()

    await expect(first).rejects.toThrow(/abort/i)
    await expect(second).resolves.toMatchObject({ result: "second-survived" })
    expect(limiter.getStatus().queueLength).toBe(0)
  })

  test("legacy global rejectQueued remains a green cleanup baseline", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 60,
      requestIntervalSeconds: 60,
    })
    let calls = 0
    const result = limiter.execute(async () => {
      calls += 1
      if (calls <= 2) throw rateLimitError()
      return "must-not-run"
    })

    await waitUntil(() => limiter.getStatus().mode === "rate-limited" && limiter.getStatus().queueLength === 1, {
      label: "global rejectQueued backoff",
    })
    const rejected = limiter.rejectQueued()

    await expect(result).rejects.toThrow(/shutting down/i)
    await delay(20)
    expect(rejected).toBe(1)
    expect(calls).toBe(2)
    expect(limiter.getStatus().queueLength).toBe(0)
  })
})
