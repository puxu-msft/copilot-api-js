/**
 * Fake async stream generator for testing streaming handlers with abort support.
 */

/** Creates an async iterable that yields chunks with configurable delay and abort support */
export async function* createFakeStream<T>(
  chunks: Array<T>,
  opts?: { delayMs?: number; signal?: AbortSignal },
): AsyncGenerator<T> {
  for (const chunk of chunks) {
    if (opts?.signal?.aborted) return
    if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    yield chunk
  }
}
