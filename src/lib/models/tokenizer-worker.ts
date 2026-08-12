/**
 * Tokenizer Worker entry: runs the token counting so the main thread does not have to.
 *
 * Why this thread exists at all. Token counting is pure CPU with no yield points — BPE over a large payload runs to completion or not at all — so on the main thread it is not "slow", it is a stall: nothing else on the event loop advances while it runs, including timers, health checks, and signal handlers. That last one is what made this visible in production: a `SIGUSR2` handler is ordinary JavaScript, so it cannot run until the loop is free, and a process being asked to hand over its port kept accepting requests for as long as it was busy counting.
 *
 * Imports are deliberately narrow — the protocol types and the counting core, nothing else. A Worker entry that reached the server, config, or logging modules would boot a second copy of the application, not a thread.
 */

import {
  //
  parentPort,
  threadId,
} from "node:worker_threads"

import type {
  //
  TokenizerRequest,
  TokenizerResponse,
  TokenizerResultValue,
} from "./tokenizer-protocol"

import {
  //
  computePerMessageTokenCounts,
  computeTextTokens,
  computeTokenCount,
  computeToolsTokenCount,
} from "./tokenizer-core"

const port = parentPort
if (!port) {
  // Reached only if this module is imported on the main thread, which would silently give the importer a tokenizer that answers nobody. Fail loudly instead.
  throw new Error("tokenizer-worker must be started as a Worker; it has no parentPort")
}

const compute = async (request: TokenizerRequest): Promise<TokenizerResultValue> => {
  switch (request.op) {
    case "text": {
      return await computeTextTokens(request.text, request.model)
    }
    case "payload": {
      return await computeTokenCount(request.payload, request.model)
    }
    case "perMessage": {
      return await computePerMessageTokenCounts(request.messages, request.model)
    }
    case "tools": {
      return await computeToolsTokenCount(request.payload, request.model)
    }
  }
}

port.on("message", (request: TokenizerRequest) => {
  void (async () => {
    try {
      const value = await compute(request)
      port.postMessage({ id: request.id, ok: true, value, threadId } satisfies TokenizerResponse)
    } catch (error) {
      // The failure is reported, never swallowed: the client turns it back into a rejected promise for the caller, and a counting error must not silently become a plausible-looking number.
      port.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error), threadId } satisfies TokenizerResponse)
    }
  })()
})
