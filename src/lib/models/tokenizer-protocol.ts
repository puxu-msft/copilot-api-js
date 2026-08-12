/**
 * Wire protocol between the main thread and the tokenizer Worker.
 *
 * Kept in its own module so the Worker entry and the client agree on one definition, and so importing the protocol costs nothing: neither side pulls in `gpt-tokenizer` or the counting code just to describe a message.
 *
 * Everything crossing the boundary must survive `structuredClone`. `Model` is the object the Copilot catalog hands back as JSON, and the payload types are the parsed request bodies, so both are plain data — but see `assertCloneable` in the client for why that is checked rather than assumed.
 */

import type {
  //
  ChatCompletionsPayload,
  Message,
} from "~/types/api/openai-chat-completions"

import type { Model } from "./client"

/**
 * A unit of counting work, at the granularity of one public API call.
 *
 * The granularity is the whole point of the split. The natural seam is `Encoder.encode(text)`, but it is called in tight loops — a payload with fifty messages and thirty tools encodes hundreds of strings — so putting the thread boundary there would buy a responsive main thread at the cost of hundreds of round trips per request. Sending the whole job instead costs exactly one.
 */
export type TokenizerRequest =
  | { id: number; op: "text"; model: Model; text: string }
  | { id: number; op: "payload"; model: Model; payload: ChatCompletionsPayload }
  | { id: number; op: "perMessage"; model: Model; messages: Array<Message> }
  | { id: number; op: "tools"; model: Model; payload: ChatCompletionsPayload }

export type TokenizerOp = TokenizerRequest["op"]

/** `Omit` that distributes over a union instead of collapsing it to its common keys — without this the four request shapes would lose their `op` discriminant. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A job as the caller describes it; the client assigns the `id`. */
export type TokenizerJob = DistributiveOmit<TokenizerRequest, "id">

/** Every value any op can produce. */
export type TokenizerResultValue = number | Array<number> | { input: number; output: number }

/** The result type each op produces, so the client can stay typed across a boundary that is inherently `unknown`. */
export type TokenizerResultFor<Op extends TokenizerOp> =
  Op extends "payload" ? { input: number; output: number }
  : Op extends "perMessage" ? Array<number>
  : number

/**
 * The Worker's answer.
 *
 * `threadId` rides along on every response, success or failure. It is what lets a test assert that the work actually happened off the main thread — the one property this whole module exists to provide, and one that no timing measurement can establish deterministically. `node:worker_threads` gives the main thread id 0, so a non-zero value here IS the proof.
 */
export type TokenizerResponse =
  | { id: number; ok: true; value: TokenizerResultValue; threadId: number }
  | { id: number; ok: false; error: string; threadId: number }
