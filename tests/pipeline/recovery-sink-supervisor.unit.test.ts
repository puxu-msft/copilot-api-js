import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

import {
  //
  createDownstreamDeliverySession,
  getDownstreamDeliverySession,
} from "~/lib/pipeline/delivery/session"
import { createRecoverySinkSupervisor } from "~/lib/pipeline/generation/recovery-sink-supervisor"

import { FakeClock } from "../helpers/fake-clock"

function namedFrame(name: string): ClientFrame {
  return { event: name, data: JSON.stringify({ type: name }) }
}

async function drain(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("recovery sink lifetime supervisor", () => {
  const clock = new FakeClock()
  afterEach(() => clock.restore())

  test("forwards every write method and recoverable heartbeat control unchanged", async () => {
    const calls: Array<{ method: string; frame?: ClientFrame }> = []
    const inner: ClientSink = {
      async write(frame) {
        calls.push({ method: "write", frame })
      },
      async writeSynthetic(frame) {
        calls.push({ method: "writeSynthetic", frame })
      },
      async writeKeepalive(frame) {
        calls.push({ method: "writeKeepalive", frame })
      },
      async writeSyntheticEnvelope(frame) {
        calls.push({ method: "writeSyntheticEnvelope", frame })
      },
      async writeAnchor(frame) {
        calls.push({ method: "writeAnchor", frame })
      },
      freezeHeartbeat() {
        calls.push({ method: "freezeHeartbeat" })
      },
      suspendHeartbeat() {
        calls.push({ method: "suspendHeartbeat" })
      },
      resumeHeartbeat() {
        calls.push({ method: "resumeHeartbeat" })
      },
    }
    const supervisor = createRecoverySinkSupervisor(inner)
    const frames = {
      write: namedFrame("write"),
      synthetic: namedFrame("synthetic"),
      keepalive: namedFrame("keepalive"),
      envelope: namedFrame("envelope"),
      anchor: namedFrame("anchor"),
    }

    await supervisor.sink.write(frames.write)
    await supervisor.sink.writeSynthetic?.(frames.synthetic)
    await supervisor.sink.writeKeepalive?.(frames.keepalive)
    await supervisor.sink.writeSyntheticEnvelope?.(frames.envelope)
    await supervisor.sink.writeAnchor?.(frames.anchor)
    supervisor.sink.freezeHeartbeat?.()
    supervisor.sink.suspendHeartbeat?.()
    supervisor.sink.resumeHeartbeat?.()

    expect(calls).toEqual([
      { method: "write", frame: frames.write },
      { method: "writeSynthetic", frame: frames.synthetic },
      { method: "writeKeepalive", frame: frames.keepalive },
      { method: "writeSyntheticEnvelope", frame: frames.envelope },
      { method: "writeAnchor", frame: frames.anchor },
      { method: "freezeHeartbeat" },
      { method: "suspendHeartbeat" },
      { method: "resumeHeartbeat" },
    ])
  })

  test("preserves the generation-owned delivery session identity for driver writes", async () => {
    const delivery = createDownstreamDeliverySession({ sink: { async write() {} } })
    const supervisor = createRecoverySinkSupervisor(delivery.clientSink)

    expect(getDownstreamDeliverySession(supervisor.sink)).toBe(delivery)

    await supervisor.settleFinal()
  })

  test("suppresses attempt-local close and finalize until settleFinal", async () => {
    const calls: Array<string> = []
    const inner: ClientSink = {
      async write(frame) {
        calls.push(`write:${frame.data}`)
      },
      close() {
        calls.push("close")
      },
      finalize() {
        calls.push("finalize")
      },
    }
    const supervisor = createRecoverySinkSupervisor(inner)

    await supervisor.sink.write({ data: "primary" })
    supervisor.sink.close?.()
    supervisor.sink.finalize?.()
    await supervisor.sink.write({ data: "recovery" })

    expect(calls).toEqual(["write:primary", "write:recovery"])

    await supervisor.settleFinal()
    expect(calls).toEqual(["write:primary", "write:recovery", "close", "finalize"])
  })

  test("settleFinal waits for an asynchronously completing inner finalize", async () => {
    let finalized = false
    const supervisor = createRecoverySinkSupervisor({
      async write() {},
      finalize: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            finalized = true
            resolve()
          }, 1)
        }),
    })

    await supervisor.settleFinal()

    expect(finalized).toBeTrue()
  })

  test("settleFinal propagates an asynchronous inner finalize rejection", async () => {
    const supervisor = createRecoverySinkSupervisor({
      async write() {},
      finalize: () => Promise.reject(new Error("async finalize failed")),
    })

    await expect(supervisor.settleFinal()).rejects.toThrow("async finalize failed")
  })

  test("settleFinal is idempotent", async () => {
    let closeCalls = 0
    let finalizeCalls = 0
    const supervisor = createRecoverySinkSupervisor({
      async write() {},
      close() {
        closeCalls++
      },
      finalize() {
        finalizeCalls++
      },
    })

    await Promise.all([supervisor.settleFinal(), supervisor.settleFinal()])
    await supervisor.settleFinal()

    expect(closeCalls).toBe(1)
    expect(finalizeCalls).toBe(1)
  })

  test("keeps the generation heartbeat alive between attempts and stops it at final settlement", async () => {
    clock.install()
    const writes: Array<string> = []
    let rawCloseCalls = 0
    let rawFinalizeCalls = 0
    const delivery = createDownstreamDeliverySession({
      sink: {
        async write(frame) {
          writes.push(frame.event ?? "write")
        },
        async writeKeepalive(frame) {
          writes.push(frame.event ?? "keepalive")
        },
        close() {
          rawCloseCalls++
        },
        finalize() {
          rawFinalizeCalls++
        },
      },
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        frame: () => namedFrame("ping"),
      },
    })
    const supervisor = createRecoverySinkSupervisor(delivery.clientSink)

    expect(clock.liveTimerCount).toBe(1)
    supervisor.sink.close?.()
    supervisor.sink.finalize?.()
    expect(clock.liveTimerCount).toBe(1)

    await clock.advance(20_000)
    await drain()
    expect(writes).toEqual(["ping"])
    expect(clock.liveTimerCount).toBe(1)

    await supervisor.settleFinal()
    expect(clock.liveTimerCount).toBe(0)
    expect(rawCloseCalls).toBe(1)
    expect(rawFinalizeCalls).toBe(1)

    await clock.advance(60_000)
    await drain()
    expect(writes).toEqual(["ping"])
    expect(clock.liveTimerCount).toBe(0)
  })
})
