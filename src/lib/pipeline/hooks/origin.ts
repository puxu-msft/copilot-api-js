import type { UpstreamStream } from "~/lib/pipeline/types"

export const HOOK_ORIGIN = Symbol("hookOrigin")
export type HookOrigin = "hook-mock" | "hook-replay"

/** Tag an UpstreamStream with its hook origin (read by the driver at sampling to mark history synthetic). */
export function tagStream(s: UpstreamStream, origin: HookOrigin): UpstreamStream {
  return Object.assign(s, { [HOOK_ORIGIN]: origin })
}

/** Read the hook origin off a stream (undefined = real upstream, not hook-produced). */
export function readOrigin(s: UpstreamStream): HookOrigin | undefined {
  return (s as unknown as Record<symbol, unknown>)[HOOK_ORIGIN] as HookOrigin | undefined
}
