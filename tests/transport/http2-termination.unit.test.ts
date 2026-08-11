import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

import type {
  //
  GoawaySnapshotSource,
  Http2TerminationCommitPort,
  TransportTerminationSnapshot,
} from "~/lib/transport/http2-observation-types"

import {
  //
  registerHttp2BodyTerminationHandlers,
  registerHttp2PreResponseTerminationHandlers,
} from "~/lib/transport/http2-client"
import {
  //
  createDefaultGoawaySnapshotSource,
  createHttp2TerminationRecorder,
  createLocalTerminationCommitPort,
  toBoundedObservationText,
} from "~/lib/transport/http2-termination"

const ROOT = path.resolve(import.meta.dir, "../..")
const HTTP2_CLIENT_PATH = path.join(ROOT, "src/lib/transport/http2-client.ts")

function isExactDataCallback(source: string): boolean {
  const file = ts.createSourceFile(HTTP2_CLIENT_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const matches: Array<ts.ArrowFunction> = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "on"
      && node.arguments.length === 2
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === "data"
      && ts.isArrowFunction(node.arguments[1])
    ) {
      matches.push(node.arguments[1])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (matches.length !== 1) return false

  const callback = matches[0]
  if (callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0].name)) return false
  const body = unwrapParentheses(callback.body)
  if (!ts.isCallExpression(body) || body.arguments.length !== 1) return false
  if (!ts.isPropertyAccessExpression(body.expression)) return false
  if (!ts.isIdentifier(body.expression.expression) || body.expression.expression.text !== "controller" || body.expression.name.text !== "enqueue") return false
  const allocation = unwrapParentheses(body.arguments[0])
  if (!ts.isNewExpression(allocation) || !ts.isIdentifier(allocation.expression) || allocation.expression.text !== "Uint8Array") return false
  if (allocation.arguments?.length !== 1) return false
  const argument = unwrapParentheses(allocation.arguments[0])
  return ts.isIdentifier(argument) && argument.text === callback.parameters[0].name.text
}

function unwrapParentheses(node: ts.Node): ts.Node {
  let current: ts.Node = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function snapshotHarness(
  options: {
    commitPort?: Http2TerminationCommitPort
    onTermination?: (snapshot: TransportTerminationSnapshot) => void
  } = {},
) {
  const snapshots: Array<TransportTerminationSnapshot> = []
  const recorder = createHttp2TerminationRecorder({
    commitPort: options.commitPort ?? createLocalTerminationCommitPort(),
    onTermination: options.onTermination ?? ((snapshot) => snapshots.push(snapshot)),
    now: () => 1_725_000_000_123,
  })
  return { recorder, snapshots }
}

describe("HTTP/2 termination schema and local commit port", () => {
  test("default source freezes as ordinary zero-event rather than source-unavailable", () => {
    expect(createDefaultGoawaySnapshotSource().freezeAtTerminal()).toEqual({
      snapshot: {
        availability: "not-observed-before-snapshot",
        events: [],
        protocolViolation: { availability: "none" },
      },
      operationLease: null,
    })
  })

  test("local port owns its source and performs one CAS before freeze/build", () => {
    let freezes = 0
    let builds = 0
    const source: GoawaySnapshotSource = {
      freezeAtTerminal: () => {
        freezes += 1
        return createDefaultGoawaySnapshotSource().freezeAtTerminal()
      },
    }
    const port = createLocalTerminationCommitPort(source)
    const build = () => {
      builds += 1
      return {} as TransportTerminationSnapshot
    }

    expect(port.trySetTransportTermination(build)).toBe(true)
    expect(port.trySetTransportTermination(build)).toBe(false)
    expect({ freezes, builds }).toEqual({ freezes: 1, builds: 1 })
  })
})

describe("HTTP/2 first-terminal recorder", () => {
  test("records end before notifying exactly once", () => {
    const order: Array<string> = []
    const { recorder, snapshots } = snapshotHarness({ onTermination: (snapshot) => (snapshots.push(snapshot), order.push("observer")) })
    recorder.observeHeaders(17)
    recorder.observeTrailers()
    recorder.recordEnd(0)
    order.push("controller.close")

    expect(order).toEqual(["observer", "controller.close"])
    expect(snapshots).toEqual([
      {
        schemaVersion: 1,
        firstObservedSignal: "end",
        terminalEpochMs: 1_725_000_000_123,
        headersReceived: true,
        streamId: 17,
        rstCode: 0,
        error: {
          code: { value: null, originalByteLength: 0, truncated: false },
          message: { value: null, originalByteLength: 0, truncated: false },
        },
        localCancel: {
          source: null,
          reason: { value: null, originalByteLength: 0, truncated: false },
        },
        trailers: "observed-before-snapshot",
        physicalClose: "not-observed-before-snapshot",
        goaway: {
          availability: "not-observed-before-snapshot",
          events: [],
          protocolViolation: { availability: "none" },
        },
      },
    ])
  })

  test("records errors with bounded code and message", () => {
    const { recorder, snapshots } = snapshotHarness()
    recorder.observeHeaders(19)
    const error = Object.assign(new Error("m".repeat(2_000)), { code: "C".repeat(200) })
    recorder.recordError(error, 8)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].firstObservedSignal).toBe("error")
    expect(snapshots[0].error.code).toEqual({ value: "C".repeat(128), originalByteLength: 200, truncated: true })
    expect(snapshots[0].error.message).toEqual({ value: "m".repeat(1_024), originalByteLength: 2_000, truncated: true })
  })

  test("records bare close-before-end with physical close already observed", () => {
    const { recorder, snapshots } = snapshotHarness()
    recorder.observeHeaders(23)
    recorder.observePhysicalClose()
    recorder.recordCloseBeforeEnd(new Error("bare close"), 2)

    expect(snapshots[0]).toMatchObject({
      firstObservedSignal: "close-before-end",
      physicalClose: "observed-before-snapshot",
      rstCode: 2,
      error: { message: { value: "bare close", truncated: false } },
    })
  })

  test("distinguishes body cancel from post-response signal abort", () => {
    const body = snapshotHarness()
    body.recorder.observeHeaders(25)
    body.recorder.recordLocalCancel("body-cancel", "reader stopped", 0)

    const signal = snapshotHarness()
    signal.recorder.observeHeaders(27)
    signal.recorder.recordLocalCancel("post-response-signal-abort", new DOMException("deadline", "AbortError"), 0)

    expect(body.snapshots[0].localCancel).toEqual({
      source: "body-cancel",
      reason: { value: "reader stopped", originalByteLength: 14, truncated: false },
    })
    expect(signal.snapshots[0].localCancel.source).toBe("post-response-signal-abort")
    expect(signal.snapshots[0].localCancel.reason.value).toBe("deadline")
  })

  test("late close and a second terminal cannot mutate or notify the frozen snapshot", () => {
    const { recorder, snapshots } = snapshotHarness()
    recorder.observeHeaders(29)
    recorder.recordEnd(0)
    recorder.observePhysicalClose()
    recorder.recordError(new Error("late"), 8)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].firstObservedSignal).toBe("end")
    expect(snapshots[0].physicalClose).toBe("not-observed-before-snapshot")
  })

  test("observer cannot mutate any nested GOAWAY or termination union leaf", () => {
    const source: GoawaySnapshotSource = {
      freezeAtTerminal: () => ({
        snapshot: {
          availability: "observed-before-snapshot",
          events: [
            {
              sequence: 1,
              errorCode: 1,
              lastStreamID: 7,
              lastStreamIdOrder: "first",
              opaqueDataLength: {
                availability: "unavailable-at-source",
                reason: { value: "opaque unavailable", originalByteLength: 18, truncated: false },
              },
              evidence: {
                availability: "unavailable-at-capture",
                byteLength: 3,
                reason: { value: "capture failed", originalByteLength: 14, truncated: false },
              },
            },
          ],
          protocolViolation: {
            availability: "unattributed-protocol-error-before-callback",
            code: "PROTOCOL_ERROR",
            offendingFrame: "unavailable-at-source",
            attribution: "unattributed",
            reason: { value: "protocol failed", originalByteLength: 15, truncated: false },
          },
        },
        operationLease: null,
      }),
    }
    let observedSerialization = ""
    const mutations: Array<() => void> = []
    const recorder = createHttp2TerminationRecorder({
      commitPort: createLocalTerminationCommitPort(source),
      onTermination: (snapshot) => {
        observedSerialization = JSON.stringify(snapshot)
        const event = snapshot.goaway.availability === "observed-before-snapshot" ? snapshot.goaway.events[0] : undefined
        mutations.push(
          () => ((snapshot.error.code as { value: string | null }).value = "mutated"),
          () => ((snapshot.error.message as { value: string | null }).value = "mutated"),
          () => ((snapshot.localCancel.reason as { value: string | null }).value = "mutated"),
          () => ((event?.opaqueDataLength as { reason: { value: string | null } }).reason.value = "mutated"),
          () => ((event?.evidence as { reason: { value: string | null } }).reason.value = "mutated"),
          () => ((snapshot.goaway.protocolViolation as { reason: { value: string | null } }).reason.value = "mutated"),
          () => (snapshot.goaway.events as unknown as Array<unknown>).push("mutated"),
        )
      },
      now: () => 1,
    })

    recorder.recordLocalCancel("body-cancel", "reader stopped", 8)

    for (const mutate of mutations) expect(mutate).toThrow()
    expect(mutations).toHaveLength(7)
    expect(observedSerialization).toContain("opaque unavailable")
    expect(observedSerialization).toBe(JSON.stringify(JSON.parse(observedSerialization)))
  })

  test("remote error facts never acquire local-cancel provenance", () => {
    const { recorder, snapshots } = snapshotHarness()
    recorder.observeHeaders(31)
    recorder.recordError(new Error("remote reset"), 8)

    expect(snapshots[0].localCancel).toEqual({
      source: null,
      reason: { value: null, originalByteLength: 0, truncated: false },
    })
  })

  test("hostile and non-JSON unknown values always produce serializable bounded text", () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    const hostileGetPrototype = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap")
        },
      },
    )
    const hostileGet = new Proxy(
      {},
      {
        get() {
          throw new Error("get trap")
        },
      },
    )
    const hostileToString = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === Symbol.toStringTag || property === "toString") throw new Error("toString trap")
          return Reflect.get(target, property, receiver)
        },
      },
    )
    const values: Array<unknown> = [hostileGetPrototype, hostileGet, hostileToString, Symbol("reason"), () => undefined, 1n, circular]

    for (const value of values) {
      let snapshot: TransportTerminationSnapshot | undefined
      const recorder = createHttp2TerminationRecorder({
        commitPort: createLocalTerminationCommitPort(),
        onTermination: (observed) => {
          snapshot = observed
        },
        now: () => 1,
      })
      expect(() => recorder.recordLocalCancel("body-cancel", value, 0)).not.toThrow()
      expect(snapshot).toBeDefined()
      const serialized = JSON.stringify(snapshot)
      expect(serialized).toContain('"value":')
      expect(snapshot?.localCancel.reason.value === null || typeof snapshot?.localCancel.reason.value === "string").toBe(true)
      expect(snapshot?.localCancel.reason.originalByteLength).toBeGreaterThanOrEqual(0)
    }
  })

  test("CAS rejection leaves freeze, builder, and observer counts unchanged", () => {
    let freezes = 0
    let initialBuilds = 0
    let notifications = 0
    const source: GoawaySnapshotSource = {
      freezeAtTerminal: () => {
        freezes += 1
        return createDefaultGoawaySnapshotSource().freezeAtTerminal()
      },
    }
    const commitPort = createLocalTerminationCommitPort(source)
    expect(
      commitPort.trySetTransportTermination(() => {
        initialBuilds += 1
        return {} as TransportTerminationSnapshot
      }),
    ).toBe(true)
    const recorder = createHttp2TerminationRecorder({
      commitPort,
      onTermination: () => {
        notifications += 1
      },
      now: () => {
        throw new Error("rejected recorder builder ran")
      },
    })

    expect(recorder.recordEnd(0)).toBe(false)
    expect({ freezes, initialBuilds, notifications }).toEqual({ freezes: 1, initialBuilds: 1, notifications: 0 })
  })

  test("throwing observer cannot replace the original consumer close or error outcome", () => {
    let closed = false
    const close = snapshotHarness({
      onTermination: () => {
        throw new Error("observer close")
      },
    })
    expect(() => {
      close.recorder.recordEnd(0)
      closed = true
    }).not.toThrow()
    expect(closed).toBe(true)

    const bodyError = new Error("body error")
    const error = snapshotHarness({
      onTermination: () => {
        throw new Error("observer error")
      },
    })
    const consumerError = (): never => {
      error.recorder.recordError(bodyError, 8)
      throw bodyError
    }
    expect(consumerError).toThrow(bodyError)
  })

  test("bounded text truncates at a UTF-8 code point boundary", () => {
    expect(toBoundedObservationText("ééé", 5)).toEqual({ value: "éé", originalByteLength: 6, truncated: true })
    expect(toBoundedObservationText(null, 5)).toEqual({ value: null, originalByteLength: 0, truncated: false })
  })
})

class FakeTerminalStream {
  rstCode: number | null = 0
  private readonly listeners = new Map<string, Array<(...args: Array<unknown>) => void>>()

  readonly actions: Array<string>

  constructor(actions: Array<string> = []) {
    this.actions = actions
  }

  once(event: "end" | "error" | "close", listener: (...args: Array<unknown>) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  close(code: number): void {
    this.actions.push(`req.close:${String(code)}`)
  }

  emit(event: "end" | "error" | "close", ...args: Array<unknown>): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
    this.listeners.delete(event)
  }
}

function seamHarness(options: { observerThrows?: boolean } = {}) {
  const order: Array<string> = []
  const stream = new FakeTerminalStream(order)
  const snapshots: Array<TransportTerminationSnapshot> = []
  const recorder = createHttp2TerminationRecorder({
    commitPort: createLocalTerminationCommitPort(),
    onTermination: (snapshot) => {
      order.push(`observer:${snapshot.firstObservedSignal}`)
      snapshots.push(snapshot)
      if (options.observerThrows) throw new Error("observer failure")
    },
    now: () => 1,
  })
  return { stream, order, snapshots, recorder }
}

describe("HTTP/2 production terminal seam", () => {
  test("end and error notify before the real controller seam, including throwing observers", () => {
    const ended = seamHarness({ observerThrows: true })
    registerHttp2BodyTerminationHandlers(
      ended.stream,
      {
        close: () => ended.order.push("controller.close"),
        error: () => ended.order.push("controller.error"),
      },
      ended.recorder,
    )
    ended.stream.emit("end")
    expect(ended.order).toEqual(["observer:end", "controller.close"])

    const errored = seamHarness({ observerThrows: true })
    const original = new Error("body failed")
    let consumerError: unknown
    registerHttp2BodyTerminationHandlers(
      errored.stream,
      {
        close: () => errored.order.push("controller.close"),
        error: (error) => {
          consumerError = error
          errored.order.push("controller.error")
        },
      },
      errored.recorder,
    )
    errored.stream.emit("error", original)
    expect(errored.order).toEqual(["observer:error", "controller.error"])
    expect(consumerError).toBe(original)
  })

  test("bare close and pre-response error notify before controller error or reject", () => {
    const bare = seamHarness({ observerThrows: true })
    registerHttp2BodyTerminationHandlers(
      bare.stream,
      {
        close: () => bare.order.push("controller.close"),
        error: () => bare.order.push("controller.error"),
      },
      bare.recorder,
    )
    bare.stream.emit("close")
    expect(bare.order).toEqual(["observer:close-before-end", "controller.error"])

    const preResponse = seamHarness({ observerThrows: true })
    registerHttp2PreResponseTerminationHandlers(preResponse.stream, undefined, preResponse.recorder, () => preResponse.order.push("reject"))
    preResponse.stream.emit("error", new Error("pre-response"))
    expect(preResponse.order).toEqual(["observer:error", "reject"])
  })

  test("pre-response abort notifies before NGHTTP2_CANCEL and reject", () => {
    const aborted = seamHarness({ observerThrows: true })
    const abort = new AbortController()
    registerHttp2PreResponseTerminationHandlers(aborted.stream, abort.signal, aborted.recorder, () => aborted.order.push("reject"))

    abort.abort(new Error("cancelled"))

    expect(aborted.order).toEqual(["observer:local-cancel", `req.close:${String(8)}`, "reject"])
  })

  test("body cancel and signal abort notify before NGHTTP2_CANCEL", () => {
    const body = seamHarness({ observerThrows: true })
    const bodyHandlers = registerHttp2BodyTerminationHandlers(
      body.stream,
      { close: () => body.order.push("controller.close"), error: () => body.order.push("controller.error") },
      body.recorder,
    )
    bodyHandlers.cancel("reader stopped")
    expect(body.order).toEqual(["observer:local-cancel", `req.close:${String(8)}`])

    const signal = seamHarness({ observerThrows: true })
    const abort = new AbortController()
    registerHttp2BodyTerminationHandlers(
      signal.stream,
      { close: () => signal.order.push("controller.close"), error: () => signal.order.push("controller.error") },
      signal.recorder,
      abort.signal,
    )
    abort.abort(new Error("deadline"))
    expect(signal.order).toEqual(["observer:local-cancel", `req.close:${String(8)}`])
  })

  test("first terminal wins in end-close and error-close races", () => {
    const endClose = seamHarness()
    registerHttp2BodyTerminationHandlers(
      endClose.stream,
      { close: () => endClose.order.push("controller.close"), error: () => endClose.order.push("controller.error") },
      endClose.recorder,
    )
    endClose.stream.emit("end")
    endClose.stream.emit("close")
    expect(endClose.snapshots.map((snapshot) => snapshot.firstObservedSignal)).toEqual(["end"])

    const errorClose = seamHarness()
    registerHttp2BodyTerminationHandlers(
      errorClose.stream,
      { close: () => errorClose.order.push("controller.close"), error: () => errorClose.order.push("controller.error") },
      errorClose.recorder,
    )
    errorClose.stream.emit("error", new Error("failed"))
    errorClose.stream.emit("close")
    expect(errorClose.snapshots.map((snapshot) => snapshot.firstObservedSignal)).toEqual(["error"])
  })
})

describe("HTTP/2 DATA hot-path architecture guard", () => {
  const productionSource = readFileSync(HTTP2_CLIENT_PATH, "utf8")
  const callbackLine = 'req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))'
  const variant = (replacement: string): string => productionSource.replace(callbackLine, replacement)

  test("the sole DATA callback remains the exact AST shape", () => {
    expect(isExactDataCallback(productionSource)).toBe(true)
  })

  test("accepts formatting, parentheses, parameter rename, and omitted type annotation", () => {
    expect(isExactDataCallback(variant('req.on("data", value => ((controller.enqueue(new Uint8Array((value))))))'))).toBe(true)
  })

  test.each([
    ["clock", 'req.on("data", (chunk: Buffer) => (Date.now(), controller.enqueue(new Uint8Array(chunk))))'],
    ["object", 'req.on("data", (chunk: Buffer) => ({ chunk }, controller.enqueue(new Uint8Array(chunk))))'],
    ["copy", 'req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk.slice())))'],
    ["callback", 'req.on("data", (chunk: Buffer) => (init.onStreamClosed?.(), controller.enqueue(new Uint8Array(chunk))))'],
  ])("rejects the %s mutation", (_name, replacement) => {
    expect(isExactDataCallback(variant(replacement))).toBe(false)
  })
})
