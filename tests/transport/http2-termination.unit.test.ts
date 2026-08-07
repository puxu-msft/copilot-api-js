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
  createDefaultGoawaySnapshotSource,
  createHttp2TerminationRecorder,
  createLocalTerminationCommitPort,
  toBoundedObservationText,
} from "~/lib/transport/http2-termination"

const ROOT = path.resolve(import.meta.dir, "../..")
const HTTP2_CLIENT_PATH = path.join(ROOT, "src/lib/transport/http2-client.ts")

function dataCallbackBody(source: string): string {
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
  expect(matches).toHaveLength(1)
  return matches[0].body.getText(file)
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

  test("observer cannot mutate nested fields of the frozen snapshot", () => {
    let mutationThrew = false
    const snapshots: Array<TransportTerminationSnapshot> = []
    const { recorder } = snapshotHarness({
      onTermination: (snapshot) => {
        snapshots.push(snapshot)
        try {
          ;(snapshot.error.message as { value: string | null }).value = "mutated"
        } catch {
          mutationThrew = true
        }
      },
    })

    recorder.recordError(new Error("original"), 8)

    expect(mutationThrew).toBe(true)
    expect(snapshots[0].error.message.value).toBe("original")
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

  test("non-string local cancel reasons remain bounded and never throw", () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    const { recorder, snapshots } = snapshotHarness()

    expect(() => recorder.recordLocalCancel("body-cancel", circular, 0)).not.toThrow()
    expect(snapshots[0].localCancel.source).toBe("body-cancel")
    expect(snapshots[0].localCancel.reason.originalByteLength).toBeLessThanOrEqual(1_024)
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

describe("HTTP/2 DATA hot-path architecture guard", () => {
  test("the sole DATA callback remains the exact one-expression enqueue", () => {
    const source = readFileSync(HTTP2_CLIENT_PATH, "utf8")
    expect(dataCallbackBody(source)).toBe("controller.enqueue(new Uint8Array(chunk))")
  })
})
