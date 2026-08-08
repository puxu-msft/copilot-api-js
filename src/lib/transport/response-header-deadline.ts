/** Build the canonical error for an expired response-header deadline. */
export function createResponseHeaderTimeoutError(ms: number): DOMException {
  return new DOMException(`Upstream response headers not received within ${ms}ms`, "TimeoutError")
}

/** Build a response-header deadline that can be disarmed when headers arrive. */
export function createResponseHeaderDeadline(ms: number): { signal: AbortSignal; complete(): boolean } {
  const controller = new AbortController()
  let finished = false
  const finish = (reason?: Error): boolean => {
    if (finished) return false
    finished = true
    clearTimeout(timer)
    if (reason) controller.abort(reason)
    return true
  }
  const timer = setTimeout(() => finish(createResponseHeaderTimeoutError(ms)), ms)
  ;(timer as { unref?: () => void }).unref?.()
  return { signal: controller.signal, complete: () => finish() }
}
