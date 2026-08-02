import type { OwnerResult } from "~/lib/pipeline/delivery/types"

export function ownerValue<T>(result: OwnerResult<T>): T {
  if (!result.ok) throw new Error(`owner unexpectedly rejected: ${result.reason}`)
  return result.value
}
