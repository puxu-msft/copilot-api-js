import type { OwnerTerminalDecision } from "~/lib/pipeline/delivery/owner-failure"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"

export function settleMessagesOwnerFailure(
  decision: OwnerTerminalDecision | undefined,
  env: RequestEnvelope,
  model: string,
  recordForwarded: () => void,
  partial: Parameters<RequestEnvelope["ctx"]["fail"]>[2],
  options?: { upstreamSucceeded?: boolean; cause?: unknown },
): boolean {
  if (!decision || (decision.kind === "fail-loud" && decision.reason === "wire-torn")) return false
  recordForwarded()
  if (decision.kind === "client-aborted") env.ctx.abort(model, partial)
  else if (decision.kind === "fail-loud") {
    env.ctx.fail(
      model,
      options?.cause === undefined ? decision.error : new Error(decision.error.message, { cause: options.cause }),
      partial,
      options?.upstreamSucceeded === undefined ? undefined : { upstreamSucceeded: options.upstreamSucceeded },
    )
  }
  return true
}
