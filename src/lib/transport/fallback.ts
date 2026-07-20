export type UpstreamFallbackKind = "ws-before-first-event"

/**
 * A single physical transport dispatch could not produce a response, but the
 * scheduler may retry the SAME candidate through a different transport.
 *
 * This is a control-flow error rather than an upstream semantic failure. The
 * driver settles the current dispatch as discarded, starts a fresh dispatch
 * with `strategy:"ws-fallback"`, and forces the HTTP transport for that turn.
 */
export class UpstreamTransportFallbackError extends Error {
  readonly fallbackKind: UpstreamFallbackKind
  readonly dispatchError: unknown

  constructor(fallbackKind: UpstreamFallbackKind, dispatchError: unknown) {
    super(`Upstream transport fallback requested: ${fallbackKind}`, { cause: dispatchError })
    this.name = "UpstreamTransportFallbackError"
    this.fallbackKind = fallbackKind
    this.dispatchError = dispatchError
  }
}
