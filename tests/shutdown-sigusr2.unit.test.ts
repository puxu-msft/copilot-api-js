/**
 * SIGUSR2 = 交接信号（lifecycle.md「优雅重启」）：与 SIGTERM 完全一致的 4-phase
 * drain，仅日志标签区分。裸手动/systemd/pm2 三环境共用同一 handler，差异仅在
 * 「谁按下」。本测试锁定三条契约：
 *   1. handleShutdownSignal 对 SIGUSR2 与其它 signal 一样透传标签给 gracefulShutdown。
 *   2. graceful shutdown 进行中，SIGUSR2 幂等复用在途 task，不进入终止信号强退分支。
 *   3. setupShutdownHandlers 额外注册了 SIGUSR2 监听（与既有 SIGINT/SIGTERM 并存）。
 */
import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import {
  //
  _resetShutdownState,
  handleShutdownSignal,
  setupShutdownHandlers,
} from "~/lib/shutdown"

afterEach(() => {
  _resetShutdownState()
})

test("SIGUSR2 经 handleShutdownSignal 触发 gracefulShutdown 且透传 signal 标签", async () => {
  const calls: Array<string> = []
  const gracefulShutdownFn = (signal: string): Promise<void> => {
    calls.push(signal)
    return Promise.resolve()
  }
  await handleShutdownSignal("SIGUSR2", { gracefulShutdownFn, exitFn: () => {} })
  expect(calls).toEqual(["SIGUSR2"])
})

for (const initialSignal of ["SIGINT", "SIGUSR2"] as const) {
  test(`${initialSignal} graceful shutdown 期间的 SIGUSR2 复用在途 shutdown 而不强退`, async () => {
    let finishShutdown!: () => void
    const heldShutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve
    })
    const exitCodes: Array<number> = []

    const shutdownPromise = handleShutdownSignal(initialSignal, {
      gracefulShutdownFn: () => heldShutdown,
      exitFn: (code) => exitCodes.push(code),
    })
    const repeatedPromise = handleShutdownSignal("SIGUSR2", {
      exitFn: (code) => exitCodes.push(code),
    })

    expect(repeatedPromise).toBe(shutdownPromise)
    expect(exitCodes).toEqual([])

    finishShutdown()
    await shutdownPromise
  })
}

test("setupShutdownHandlers 注册 SIGUSR2 监听", () => {
  const before = process.listenerCount("SIGUSR2")
  setupShutdownHandlers()
  expect(process.listenerCount("SIGUSR2")).toBe(before + 1)
})
