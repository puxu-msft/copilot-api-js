/**
 * The generation owner's heartbeat, and the batch scope that borrows it.
 *
 * The heartbeat is the owner's, not the caller's. `freezeHeartbeat` / `suspendHeartbeat` /
 * `resumeHeartbeat` never appear on the command port: a caller that can pause the heartbeat can
 * also forget to resume it, and the failure mode is a stream that silently stops keeping itself
 * alive. Callers get {@link runBatch} instead, which brackets the suspend/re-arm around their work
 * so there is no state where a batch ended and the heartbeat did not come back.
 *
 * **A batch containing the terminal does not re-arm.** Re-arming after the terminal frame would
 * schedule a keepalive for a stream that already ended.
 *
 * The timer is injectable so tests can drive it without wall-clock waits. Not wired into any
 * production root — the owner that uses this is published in Commit 4.
 */

export interface HeartbeatTimerSeam {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

const REAL_TIMER: HeartbeatTimerSeam = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    // Never hold the process open for a keepalive.
    ;(handle as unknown as { unref?: () => void }).unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface HeartbeatController {
  readonly armed: boolean
  readonly stopped: boolean
  /** Start (or restart) the interval. No-op once stopped. */
  arm(): void
  /** Stop the interval permanently. After the terminal, there is nothing left to keep alive. */
  stopPermanently(): void
  /**
   * Suspend, run `body`, then re-arm — unless `body` reports that it terminated the generation.
   *
   * The re-arm is a FRESH interval rather than the remainder of the suspended one: a batch that
   * took most of an interval would otherwise fire a keepalive immediately after it, which reads to
   * the client as a stall that was not there.
   */
  runBatch<T>(body: () => Promise<T>, terminatedAfter: (result: T) => boolean): Promise<T>
}

export interface CreateHeartbeatControllerInput {
  readonly intervalMs: number
  tick(): void
  readonly timer?: HeartbeatTimerSeam
}

export function createHeartbeatController(input: CreateHeartbeatControllerInput): HeartbeatController {
  const timer = input.timer ?? REAL_TIMER
  let handle: unknown
  let suspended = false
  let stopped = false

  const disarm = (): void => {
    if (handle !== undefined) timer.clear(handle)
    handle = undefined
  }

  const arm = (): void => {
    if (stopped || suspended || input.intervalMs <= 0) return
    disarm()
    handle = timer.set(() => {
      handle = undefined
      if (stopped || suspended) return
      input.tick()
      arm()
    }, input.intervalMs)
  }

  return {
    get armed() {
      return handle !== undefined
    },
    get stopped() {
      return stopped
    },

    arm,

    stopPermanently() {
      stopped = true
      disarm()
    },

    async runBatch(body, terminatedAfter) {
      suspended = true
      disarm()
      try {
        const result = await body()
        if (terminatedAfter(result)) stopped = true
        return result
      } finally {
        suspended = false
        // Re-arm even when `body` threw: a failed batch is not a reason to stop keeping the stream
        // alive, and `stopPermanently` is the only thing that ends the heartbeat for good.
        arm()
      }
    },
  }
}
