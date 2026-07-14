// Abortable sleep —— 可被取消信号中断的退避等待(RFC RC3)。
//
// driver 的退避原本是裸 `setTimeout` Promise、不接任何 signal(driver.ts:1053),reaper 的
// lifecycleSignal / shutdown / client-abort 对它**都无效**——一次 631s 指数退避里,请求已被
// reaper settle 但底层仍 sleep,循环恢复后还起新 attempt(2800s 溢出的一环)。
//
// 本 util 让退避接受一个可选 signal:signal abort → 立即 reject `OperationCancelledError`
// 并清 timer(不泄漏 handle)。driver 在退避后 gate 该信号即可 break、不起新 attempt。

export class OperationCancelledError extends Error {
  constructor(reason?: string) {
    // Message contains "aborted" so the existing `isAbortError` classifier (classify.ts —
    // matches on message) treats a backoff-cancel as an abort, flowing through the same
    // settled-abort / stream-error handling as reaper/shutdown/client aborts.
    super(reason ?? "Operation aborted during backoff")
    this.name = "OperationCancelledError"
  }
}

/**
 * Sleep `ms`, but reject with {@link OperationCancelledError} the moment `signal` aborts
 * (or immediately if already aborted). Clears the timer on abort so no handle lingers.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(new OperationCancelledError())

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new OperationCancelledError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
