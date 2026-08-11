import type { DispatchHandle } from "~/lib/context/model-operation-record"
import type { TransportDispatchOptions } from "~/lib/pipeline/types"

let counter = 0

/**
 * Mints a syntactically valid {@link DispatchHandle} for a test that must satisfy the mandatory
 * dispatch ownership on {@link TransportDispatchOptions} but has no request context at all.
 *
 * This handle is deliberately NOT registered with any `ModelOperationRecorder`. That is the point:
 * it lets a transport-level test compile without quietly acquiring an attribution it never
 * established, and any code that does try to record against it fails loudly with
 * `unknown generation dispatch` instead of writing to whichever attempt happened to be current.
 *
 * So: fine for tests whose subject is transport behaviour. NOT for tests that assert where a
 * diagnostic landed — those must begin a real dispatch on a real context and use that handle.
 */
export function compatDispatchHandleForTests(label = "compat"): DispatchHandle {
  counter += 1
  return `test-${label}-${counter}` as DispatchHandle
}

/** Convenience wrapper: the mandatory options bag with an unregistered compat handle. */
export function compatDispatchOptionsForTests(overrides: Omit<Partial<TransportDispatchOptions>, "dispatch"> = {}): TransportDispatchOptions {
  return { dispatch: compatDispatchHandleForTests(), ...overrides }
}
