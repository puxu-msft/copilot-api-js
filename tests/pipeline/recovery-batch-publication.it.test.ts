import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import type { OwnerRawSink } from "~/lib/pipeline/delivery/types"
import type {
  //
  ClientFrame,
  LegSource,
  WireBlockAllocationPort,
} from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import {
  //
  createDownstreamDeliverySession,
  DeliveryOwnerError,
  setDeliverySessionTestHooksForTests,
} from "~/lib/pipeline/delivery/session"
import { StreamClientAbortError } from "~/lib/stream"

import { ownerValue } from "../helpers/owner-result"

const RECOVERY: LegSource = { candidateId: "candidate-recovery", dispatchId: "dispatch-recovery" }
const PRIMARY: LegSource = { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }

const frame = (type: string, text: string): ClientFrame => ({
  event: type,
  data: JSON.stringify({ type, text }),
})

function setup(sink: OwnerRawSink = { write: async () => {}, close() {} }) {
  const writes: Array<ClientFrame> = []
  const delivery = createDownstreamDeliverySession({
    sink: {
      ...sink,
      write: async (entry) => {
        writes.push(entry)
        await sink.write(entry)
      },
    },
    wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
    isRealContentFrame: (entry) => JSON.parse(entry.data ?? "{}").type === "content_block_delta",
  })
  return { delivery, port: delivery.allocationPort, writes }
}

function publish(port: WireBlockAllocationPort, source: LegSource, frames: ReadonlyArray<ClientFrame>) {
  return port.publishRecoveryBatch(source, ({ envelope }) => frames.map((entry) => envelope.real(entry)))
}

afterEach(() => setDeliverySessionTestHooksForTests(undefined))

test("empty recovery batch fails before C9 without writing and leaves primary fallback available", async () => {
  const { port, writes } = setup()

  await expect(publish(port, RECOVERY, [])).rejects.toThrow("no wire frames")
  expect(writes).toEqual([])
  expect(ownerValue(await port.beginLeg("primary", PRIMARY))).toBeDefined()
})

test("recovery batch build throw happens before C9 without writing", async () => {
  const { port, writes } = setup()

  await expect(
    port.publishRecoveryBatch(RECOVERY, () => {
      throw new Error("stage failed")
    }),
  ).rejects.toThrow("stage failed")
  expect(writes).toEqual([])
  expect(ownerValue(await port.beginLeg("primary", PRIMARY))).toBeDefined()
})

test("terminating session rejects recovery batch before C9 without writing", async () => {
  const { delivery, port, writes } = setup()
  await delivery.terminate({ kind: "client-aborted" })

  expect(await publish(port, RECOVERY, [frame("content_block_delta", "recovered")])).toEqual({ ok: false, reason: "client-gone", committed: false })
  expect(writes).toEqual([])
})

test("successful recovery batch preserves order and candidate provenance while advancing the semantic gate", async () => {
  const observed: Array<{ candidateId: string; dispatchId: string }> = []
  setDeliverySessionTestHooksForTests({
    onWrite(entry) {
      if (entry.provenance.kind === "candidate") observed.push({ candidateId: entry.provenance.candidateId, dispatchId: entry.provenance.dispatchId })
    },
  })
  const { delivery, port, writes } = setup()

  expect(ownerValue(await publish(port, RECOVERY, [frame("message_start", ""), frame("content_block_delta", "recovered")]))).toBe("published")

  expect(writes.map((entry) => JSON.parse(entry.data ?? "{}").type)).toEqual(["message_start", "content_block_delta"])
  expect(observed).toEqual([
    { candidateId: RECOVERY.candidateId, dispatchId: RECOVERY.dispatchId },
    { candidateId: RECOVERY.candidateId, dispatchId: RECOVERY.dispatchId },
  ])
  expect(delivery.hasEmittedRealClientContent).toBeTrue()
})

test("pre-C9 recovery hook rejection writes nothing and reports committed false", async () => {
  setDeliverySessionTestHooksForTests({
    onBeforeRecoveryBatchCommit() {
      throw new Error("preflight hook rejected")
    },
  })
  const { port, writes } = setup()

  await expect(publish(port, RECOVERY, [frame("content_block_delta", "recovered")])).rejects.toMatchObject({ committed: false })
  expect(writes).toEqual([])
  expect(ownerValue(await port.beginLeg("primary", PRIMARY))).toBeDefined()
})

test("first recovery batch write client abort is committed and finalizes delivery", async () => {
  let finalized = 0
  const { delivery, port, writes } = setup({
    async write() {
      throw new StreamClientAbortError()
    },
    async finalize() {
      finalized++
    },
    close() {},
  })

  expect(await publish(port, RECOVERY, [frame("content_block_delta", "recovered")])).toEqual({ ok: false, reason: "client-gone", committed: true })
  expect(writes).toHaveLength(1)
  expect(finalized).toBe(1)
  expect(delivery.snapshot.state).toBe("closed")
})

test("first non-client recovery batch write tears the frontier while terminal error and finalization remain available", async () => {
  let failRecoveryWrite = true
  let finalized = 0
  const { delivery, port, writes } = setup({
    async write() {
      if (failRecoveryWrite) throw new Error("sink torn")
    },
    async finalize() {
      finalized++
    },
    close() {},
  })

  let failure: unknown
  try {
    await publish(port, RECOVERY, [frame("content_block_delta", "recovered")])
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(DeliveryOwnerError)
  expect((failure as DeliveryOwnerError).committed).toBeTrue()
  expect(writes).toHaveLength(1)
  expect(await port.beginLeg("primary", PRIMARY)).toEqual({ ok: false, reason: "wire-torn", committed: false })
  expect(await port.publishRecoveryBatch(PRIMARY, ({ envelope }) => [envelope.real(frame("content_block_delta", "primary"))])).toEqual({
    ok: false,
    reason: "wire-torn",
    committed: false,
  })

  failRecoveryWrite = false
  await delivery.terminate({
    kind: "upstream-nonretryable",
    frames: [
      { frame: frame("error", "recovery terminal"), sequence: 0, observedAtMonotonic: 0, provenance: { kind: "synthetic", syntheticKind: "synthetic" } },
    ],
  })
  expect(writes.map((entry) => JSON.parse(entry.data ?? "{}").type)).toEqual(["content_block_delta", "error"])
  expect(finalized).toBe(1)
  expect(delivery.snapshot.state).toBe("closed")
})

test("Nth non-client recovery batch write leaves only the written prefix and tears the wire", async () => {
  let writeCount = 0
  const { port, writes } = setup({
    async write() {
      if (++writeCount === 2) throw new Error("second write torn")
    },
    close() {},
  })

  let failure: unknown
  try {
    await publish(port, RECOVERY, [frame("message_start", ""), frame("content_block_delta", "recovered")])
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(DeliveryOwnerError)
  expect((failure as DeliveryOwnerError).committed).toBeTrue()
  expect(writes.map((entry) => JSON.parse(entry.data ?? "{}").type)).toEqual(["message_start", "content_block_delta"])
  expect(await port.publishRecoveryBatch(PRIMARY, ({ envelope }) => [envelope.real(frame("error", "primary terminal"))])).toEqual({
    ok: false,
    reason: "wire-torn",
    committed: false,
  })
})
