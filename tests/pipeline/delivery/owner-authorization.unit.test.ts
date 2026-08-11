/**
 * Commit 2's two load-bearing properties: the serializer cannot be re-entered, and the
 * authorization registry catches two records claiming one wire index.
 *
 * Deliberately NOT a sweep of every method. These are the main path plus the shapes that have
 * actually gone wrong: a compound command deadlocking on its own queue, a deferred callback being
 * mistaken for a nested one, and a cross-kind index collision (an anchor lease and a real block on
 * the same index), which is the collision an anchor-first-then-mapping short circuit misses.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { LegToken } from "~/lib/pipeline/types"

import {
  //
  AuthorizationCardinalityError,
  createAuthorizationRegistry,
} from "~/lib/pipeline/delivery/authorization"
import {
  //
  createOwnerSerializer,
  OwnerSerializerReentrancyError,
} from "~/lib/pipeline/delivery/owner-serializer"

const LEG = "leg:primary" as LegToken

describe("owner serializer", () => {
  test("runInternal runs a compound step inline, without a second ordering point", async () => {
    const serializer = createOwnerSerializer()
    const order: Array<string> = []

    await serializer.run(async () => {
      order.push("outer-start")
      await serializer.runInternal(async () => {
        order.push("inner")
      })
      order.push("outer-end")
    })

    expect(order).toEqual(["outer-start", "inner", "outer-end"])
  })

  test("a compound command holds the queue for its whole duration", async () => {
    const serializer = createOwnerSerializer()
    const order: Array<string> = []
    let releaseCompound: () => void = () => undefined
    let announceParked: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      releaseCompound = resolve
    })
    // Handshake rather than a guessed tick count: the queue starts on a microtask, so asserting
    // straight after `run()` would read an empty array and prove nothing about interleaving.
    const parked = new Promise<void>((resolve) => {
      announceParked = resolve
    })

    const compound = serializer.run(async () => {
      order.push("compound-close")
      announceParked()
      await barrier
      await serializer.runInternal(() => {
        order.push("compound-start")
      })
    })
    const other = serializer.run(() => {
      order.push("other")
    })

    await parked
    // The second command must not have interleaved between the compound's two halves.
    expect(order).toEqual(["compound-close"])
    releaseCompound()
    await Promise.all([compound, other])
    expect(order).toEqual(["compound-close", "compound-start", "other"])
  })

  test("enqueueing from inside a command throws instead of deadlocking", async () => {
    const serializer = createOwnerSerializer()
    // The natural symptom of a non-reentrant queue re-entered is a promise that never settles, which
    // a test cannot tell apart from a slow machine. Throwing makes it a decidable failure.
    await expect(serializer.run(async () => serializer.run(() => undefined))).rejects.toBeInstanceOf(OwnerSerializerReentrancyError)
  })

  test("a callback armed inside a command is not treated as inside it once the command finished", async () => {
    const serializer = createOwnerSerializer()
    let seenFromTimer: boolean | undefined

    await serializer.run(() => {
      setTimeout(() => {
        seenFromTimer = serializer.inCommand
      }, 0)
    })
    await new Promise((resolve) => setTimeout(resolve, 5))

    // AsyncLocalStorage propagates the store into that timer, so this is false ONLY because the
    // command's token was retired. Without that, a heartbeat armed inside a command would start
    // throwing reentrancy errors at its next tick.
    expect(seenFromTimer).toBe(false)
    expect(serializer.inCommand).toBe(false)
  })

  test("runInternal outside a command is refused — an unserialized primitive is a second writer", async () => {
    const serializer = createOwnerSerializer()
    await expect(serializer.runInternal(() => undefined)).rejects.toThrow(/runInternal called outside a command/u)
  })
})

describe("authorization registry", () => {
  test("an anchor lease and a real block cannot hold the same wire index", () => {
    const registry = createAuthorizationRegistry(Symbol("generation"))
    registry.openAnchorLease({ wireIndex: 0, anchorKind: "gap", now: 0 })
    registry.registerRealBlock({ wireIndex: 0, upstreamIndex: 0, leg: LEG, now: 0 })

    expect(() => {
      registry.assertCardinality()
    }).toThrow(AuthorizationCardinalityError)
  })

  test("two real blocks cannot hold the same wire index", () => {
    const registry = createAuthorizationRegistry(Symbol("generation"))
    registry.registerRealBlock({ wireIndex: 3, upstreamIndex: 0, leg: LEG, now: 0 })
    registry.registerRealBlock({ wireIndex: 3, upstreamIndex: 1, leg: LEG, now: 0 })

    expect(() => {
      registry.assertCardinality()
    }).toThrow(AuthorizationCardinalityError)
  })

  test("a compound's proposed claim is checked against what is already active", () => {
    const registry = createAuthorizationRegistry(Symbol("generation"))
    registry.openAnchorLease({ wireIndex: 1, anchorKind: "gap", now: 0 })

    // Nothing is wrong yet — the collision only exists in what the compound intends to do.
    expect(() => {
      registry.assertCardinality()
    }).not.toThrow()
    expect(() => {
      registry.assertCardinality([{ wireIndex: 1, describe: "proposed real-block" }])
    }).toThrow(AuthorizationCardinalityError)
  })

  test("a healthy population passes — the check discriminates, it does not just always throw", () => {
    const registry = createAuthorizationRegistry(Symbol("generation"))
    registry.openAnchorLease({ wireIndex: 0, anchorKind: "gap", now: 0 })
    registry.registerRealBlock({ wireIndex: 1, upstreamIndex: 0, leg: LEG, now: 0 })
    registry.registerRealBlock({ wireIndex: 2, upstreamIndex: 1, leg: LEG, now: 0 })

    expect(() => {
      registry.assertCardinality([{ wireIndex: 3, describe: "proposed real-block" }])
    }).not.toThrow()
  })

  test("a lease from another generation is refused at runtime, not just by the type", () => {
    const mine = createAuthorizationRegistry(Symbol("generation-a"))
    const theirs = createAuthorizationRegistry(Symbol("generation-b"))
    const foreign = theirs.openAnchorLease({ wireIndex: 0, anchorKind: "gap", now: 0 })

    expect(() => {
      mine.clearAnchorLease(foreign.leaseId)
    }).toThrow(/does not belong to this generation/u)
  })

  test("a rolled-back wire index is burned, never handed out again", () => {
    const registry = createAuthorizationRegistry(Symbol("generation"))
    const first = registry.reserveWireIndex()
    first.rollback()
    const second = registry.reserveWireIndex()

    // Rewinding the frontier would let a later record take an index the client may already have
    // seen on a frame written before the failure.
    expect(second.wireIndex).toBe(first.wireIndex + 1)
  })

  test("closing the anchor clears it, so the next command sees no current lease", () => {
    const registry = createAuthorizationRegistry(Symbol("generation"))
    const lease = registry.openAnchorLease({ wireIndex: 0, anchorKind: "gap", now: 0 })
    expect(registry.currentAnchorLease?.leaseId).toBe(lease.leaseId)

    registry.clearAnchorLease(lease.leaseId)
    expect(registry.currentAnchorLease).toBeUndefined()
  })

  test("a pulse moves only lastPulseAtMonotonic, and bumps the state version", () => {
    const registry = createAuthorizationRegistry(Symbol("generation"))
    const lease = registry.openAnchorLease({ wireIndex: 0, anchorKind: "gap", now: 10 })
    const before = registry.stateVersion

    const pulsed = registry.pulseAnchorLease(lease.leaseId, 25)

    expect(pulsed.lastPulseAtMonotonic).toBe(25)
    expect(pulsed.openedAtMonotonic).toBe(lease.openedAtMonotonic)
    expect(pulsed.wireIndex).toBe(lease.wireIndex)
    expect(registry.stateVersion).toBeGreaterThan(before)
  })
})
