import type {
  //
  ClientFrame,
  ResponseFailureSource,
} from "~/lib/pipeline/types"

import type { CandidateResponseSession } from "./candidate-response-session"

import {
  //
  asResponseCodecRenderError,
  isResponseCodecRenderError,
} from "../stream/response-processor"

export interface ProbeCandidate<TCandidate> {
  readonly candidate: TCandidate
  readonly session: CandidateResponseSession
  readonly upstream: Parameters<CandidateResponseSession["processor"]["stream"]>[0]
}

export type CandidateProbeOutcome<TCandidate> =
  | {
      readonly kind: "boundary"
      readonly candidate: TCandidate
      readonly bufferedFrames: ReadonlyArray<ClientFrame>
      readonly liveFrames: AsyncIterable<ClientFrame>
      close(): Promise<void>
    }
  | {
      readonly kind: "terminal"
      readonly candidate: TCandidate
      readonly bufferedFrames: ReadonlyArray<ClientFrame>
    }
  | {
      readonly kind: "failure"
      readonly candidate: TCandidate
      readonly error: unknown
      readonly source: Extract<ResponseFailureSource, "upstream-transport" | "codec-render">
    }

/** Probe one candidate up to its first complete client-format block without writing any sink. */
export async function probeCandidateResponse<TCandidate>(input: ProbeCandidate<TCandidate>): Promise<CandidateProbeOutcome<TCandidate>> {
  const { candidate, session, upstream } = input
  const iterator = session.processor.stream(upstream, session.responseOpts)[Symbol.asyncIterator]()
  const bufferedFrames: Array<ClientFrame> = []

  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return { kind: "terminal", candidate, bufferedFrames }
      if (next.value.data === "[DONE]") continue
      const transformed = transformCandidateFrame(next.value, session)
      if (!transformed) continue
      bufferedFrames.push(transformed)
      if (session.boundary.result) {
        return {
          kind: "boundary",
          candidate,
          bufferedFrames,
          liveFrames: continueCandidateFrames(iterator, session),
          async close() {
            await iterator.return?.()
          },
        }
      }
      if (shouldStopAfterCandidateFrame(transformed, session)) {
        await iterator.return?.()
        return { kind: "terminal", candidate, bufferedFrames }
      }
    }
  } catch (error) {
    try {
      await iterator.return?.()
    } catch {
      // The original response failure is the candidate outcome; cleanup failure is joined by its lifecycle owner.
    }
    return { kind: "failure", candidate, error, source: candidateFailureSource(error) }
  }
}

function candidateFailureSource(error: unknown): Extract<ResponseFailureSource, "upstream-transport" | "codec-render"> {
  return isResponseCodecRenderError(error) ? "codec-render" : "upstream-transport"
}

function transformCandidateFrame(frame: ClientFrame, session: CandidateResponseSession): ClientFrame | undefined {
  try {
    return session.responseOpts.onRenderedFrame ? session.responseOpts.onRenderedFrame(frame) : frame
  } catch (error) {
    throw asResponseCodecRenderError(error)
  }
}

function shouldStopAfterCandidateFrame(frame: ClientFrame, session: CandidateResponseSession): boolean {
  try {
    return session.responseOpts.stopAfterFrame?.(frame) ?? false
  } catch (error) {
    throw asResponseCodecRenderError(error)
  }
}

function continueCandidateFrames(iterator: AsyncIterator<ClientFrame>, session: CandidateResponseSession): AsyncIterable<ClientFrame> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ClientFrame>> {
          for (;;) {
            const next = await iterator.next()
            if (next.done) return next
            if (next.value.data === "[DONE]") continue
            const transformed = transformCandidateFrame(next.value, session)
            if (!transformed) continue
            if (shouldStopAfterCandidateFrame(transformed, session)) {
              await iterator.return?.()
              return { done: false, value: transformed }
            }
            return { done: false, value: transformed }
          }
        },
        async return(): Promise<IteratorResult<ClientFrame>> {
          await iterator.return?.()
          return { done: true, value: undefined as never }
        },
      }
    },
  }
}
