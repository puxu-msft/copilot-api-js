/**
 * The generation owner's PRIVATE authorization registry.
 *
 * The central invariant of the command algebra: **authorization state is never derived from
 * observation state**. The wire ledger (`ClientBlockLedger`) records what the client has been sent;
 * this registry records what the owner has authorized. They agree most of the time, and the defects
 * this RFC exists to fix are exactly the moments they do not — a block whose stop already went out
 * and whose mapping is released still has a history in the post-wire ledger, so a command that
 * picks its target from the ledger will happily address a block that no longer exists.
 *
 * Nothing here is reachable from a caller. There is no public lease token to hand back: a caller
 * says "close the current open anchor" and the owner reads its own `currentAnchorLease` inside the
 * serialized command. A token that travels out and back is a token that can be replayed, stored,
 * or swapped between generations, and none of those are states this registry can represent.
 *
 * Not wired into any production root — the owner that uses it is published in Commit 4.
 */

import type { LegToken } from "../types"

/** Runtime identity for one anchor lease. Branded for the type layer AND checked at runtime — a `as` cast or a structurally identical object must not pass. */
export type AnchorLeaseId = string & { readonly __anchorLease: unique symbol }

/** Runtime identity for one real-block authorization. */
export type RealBlockAuthorizationId = string & { readonly __realBlockAuthorization: unique symbol }

export type AnchorKind = "gap" | "precontent"

/** One authorized open anchor. Every field is frozen at creation except `lastPulseAtMonotonic`. */
export interface OpenAnchorLease {
  readonly leaseId: AnchorLeaseId
  readonly generationIdentity: symbol
  readonly wireIndex: number
  readonly anchorKind: AnchorKind
  readonly openedAtMonotonic: number
  /** The only mutable field, and only a successful pulse moves it. */
  readonly lastPulseAtMonotonic: number
}

/** One authorized real block: the owner's own record that a given wire index belongs to a given upstream block on a given leg. */
export interface RealBlockAuthorization {
  readonly authorizationId: RealBlockAuthorizationId
  readonly generationIdentity: symbol
  readonly wireIndex: number
  readonly upstreamIndex: number
  readonly leg: LegToken
  readonly openedAtMonotonic: number
}

/**
 * Two authorization records claim the same wire index, or a record that must exist does not.
 *
 * Named rather than a bare `Error` because the caller-facing behaviour is specific: zero wire side
 * effects, reservation rolled back, lease/mapping/frontier exactly as they were when phase A began.
 */
export class AuthorizationCardinalityError extends Error {
  readonly wireIndex: number
  readonly claims: ReadonlyArray<string>

  constructor(wireIndex: number, claims: ReadonlyArray<string>) {
    super(`[delivery-authorization] wire index ${wireIndex} is claimed by ${claims.length} records: ${claims.join(", ")}`)
    this.name = "AuthorizationCardinalityError"
    this.wireIndex = wireIndex
    this.claims = claims
  }
}

/** A wire index taken out of the frontier but not yet committed to a record. */
export interface WireIndexReservation {
  readonly wireIndex: number
  /** Bind the index to a record. After this the index is spent. */
  commit(): void
  /** Give the index back. Only legal while uncommitted; the frontier does NOT rewind, the index is simply never used. */
  rollback(): void
}

/**
 * A proposed set of claims to validate together.
 *
 * A compound `close anchor → start real block` has to be checked twice: once against the set that
 * is active right now, and once against the set that WOULD be active after applying its steps in
 * order. Checking only the first passes a compound that collides with its own second half;
 * checking only the second passes a compound whose first half was already invalid.
 */
export interface ProposedClaim {
  readonly wireIndex: number
  readonly describe: string
}

export interface AuthorizationRegistry {
  /** Bumps on every mutation, so an envelope minted earlier is recognizable as stale afterwards. */
  readonly stateVersion: number
  readonly currentAnchorLease: OpenAnchorLease | undefined
  reserveWireIndex(): WireIndexReservation
  openAnchorLease(input: { wireIndex: number; anchorKind: AnchorKind; now: number }): OpenAnchorLease
  pulseAnchorLease(leaseId: AnchorLeaseId, now: number): OpenAnchorLease
  clearAnchorLease(leaseId: AnchorLeaseId): void
  registerRealBlock(input: { wireIndex: number; upstreamIndex: number; leg: LegToken; now: number }): RealBlockAuthorization
  findRealBlock(leg: LegToken, upstreamIndex: number): RealBlockAuthorization | undefined
  releaseRealBlock(authorizationId: RealBlockAuthorizationId): void
  /** Every real block currently authorized. Read-only view — callers get a copy, never the live map. */
  activeRealBlocks(): ReadonlyArray<RealBlockAuthorization>
  /**
   * Phase-A guard. Runs against the COMPLETE population — every lease and every mapping, not just
   * the current leg, and not anchor-first-then-mapping with a short circuit. Both of those miss the
   * cross-kind collision, which is the one that actually happened.
   */
  assertCardinality(proposed?: ReadonlyArray<ProposedClaim>): void
}

/** Create an empty registry for one generation. `generationIdentity` is what makes a foreign lease detectable at runtime. */
export function createAuthorizationRegistry(generationIdentity: symbol): AuthorizationRegistry {
  const leases = new Map<AnchorLeaseId, OpenAnchorLease>()
  const realBlocks = new Map<RealBlockAuthorizationId, RealBlockAuthorization>()
  let currentLeaseId: AnchorLeaseId | undefined
  let nextWireIndex = 0
  let nextId = 0
  let version = 0

  const bump = (): void => {
    version++
  }

  const claimsAt = (wireIndex: number, proposed: ReadonlyArray<ProposedClaim>): Array<string> => {
    const claims: Array<string> = []
    for (const lease of leases.values()) if (lease.wireIndex === wireIndex) claims.push(`anchor-lease ${lease.leaseId}`)
    for (const block of realBlocks.values()) if (block.wireIndex === wireIndex) claims.push(`real-block ${block.authorizationId}`)
    for (const claim of proposed) if (claim.wireIndex === wireIndex) claims.push(claim.describe)
    return claims
  }

  const assertCardinality = (proposed: ReadonlyArray<ProposedClaim> = []): void => {
    // The union of every index any record touches — existing or proposed. Iterating only the
    // proposed set would miss a collision between two records that are already registered.
    const indices = new Set<number>()
    for (const lease of leases.values()) indices.add(lease.wireIndex)
    for (const block of realBlocks.values()) indices.add(block.wireIndex)
    for (const claim of proposed) indices.add(claim.wireIndex)

    for (const wireIndex of indices) {
      const claims = claimsAt(wireIndex, proposed)
      if (claims.length > 1) throw new AuthorizationCardinalityError(wireIndex, claims)
    }
  }

  const requireOwnLease = (leaseId: AnchorLeaseId): OpenAnchorLease => {
    const lease = leases.get(leaseId)
    // A branded type alone is not enough: `as AnchorLeaseId` and a structurally identical object
    // both satisfy the compiler. Membership in THIS registry is the check that cannot be forged.
    if (!lease || lease.generationIdentity !== generationIdentity) {
      throw new Error(`[delivery-authorization] lease ${leaseId} does not belong to this generation`)
    }
    return lease
  }

  return {
    get stateVersion() {
      return version
    },

    get currentAnchorLease() {
      return currentLeaseId === undefined ? undefined : leases.get(currentLeaseId)
    },

    reserveWireIndex() {
      const wireIndex = nextWireIndex++
      let settled = false
      return {
        wireIndex,
        commit() {
          if (settled) throw new Error(`[delivery-authorization] wire index ${wireIndex} reservation already settled`)
          settled = true
        },
        rollback() {
          if (settled) throw new Error(`[delivery-authorization] wire index ${wireIndex} reservation already settled`)
          settled = true
          // The frontier deliberately does NOT rewind. A rolled-back index is burned, never reused:
          // rewinding would let a later record take an index a client may already have seen on a
          // frame that was written before the failure.
        },
      }
    },

    openAnchorLease({ wireIndex, anchorKind, now }) {
      if (currentLeaseId !== undefined) throw new Error("[delivery-authorization] an anchor lease is already open")
      const leaseId = `anchor-lease:${nextId++}` as AnchorLeaseId
      const lease: OpenAnchorLease = Object.freeze({
        leaseId,
        generationIdentity,
        wireIndex,
        anchorKind,
        openedAtMonotonic: now,
        lastPulseAtMonotonic: now,
      })
      leases.set(leaseId, lease)
      currentLeaseId = leaseId
      bump()
      return lease
    },

    pulseAnchorLease(leaseId, now) {
      const lease = requireOwnLease(leaseId)
      // Frozen everywhere else, so a pulse replaces the record rather than mutating it — that keeps
      // any envelope already minted against the old record pointing at the old values.
      const pulsed: OpenAnchorLease = Object.freeze({ ...lease, lastPulseAtMonotonic: now })
      leases.set(leaseId, pulsed)
      bump()
      return pulsed
    },

    clearAnchorLease(leaseId) {
      requireOwnLease(leaseId)
      leases.delete(leaseId)
      if (currentLeaseId === leaseId) currentLeaseId = undefined
      bump()
    },

    registerRealBlock({ wireIndex, upstreamIndex, leg, now }) {
      const authorizationId = `real-block:${nextId++}` as RealBlockAuthorizationId
      const authorization: RealBlockAuthorization = Object.freeze({
        authorizationId,
        generationIdentity,
        wireIndex,
        upstreamIndex,
        leg,
        openedAtMonotonic: now,
      })
      realBlocks.set(authorizationId, authorization)
      bump()
      return authorization
    },

    findRealBlock(leg, upstreamIndex) {
      for (const block of realBlocks.values()) if (block.leg === leg && block.upstreamIndex === upstreamIndex) return block
      return undefined
    },

    releaseRealBlock(authorizationId) {
      const block = realBlocks.get(authorizationId)
      if (!block || block.generationIdentity !== generationIdentity) {
        throw new Error(`[delivery-authorization] real block ${authorizationId} does not belong to this generation`)
      }
      realBlocks.delete(authorizationId)
      bump()
    },

    activeRealBlocks() {
      return [...realBlocks.values()]
    },

    assertCardinality,
  }
}
