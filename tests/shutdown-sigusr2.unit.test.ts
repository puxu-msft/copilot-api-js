/**
 * SIGUSR2 = 交接信号（lifecycle.md「优雅重启」）：与 SIGTERM 完全一致地停止
 * ingress 并无损 drain，仅日志标签区分。裸手动/systemd/pm2 三环境共用同一 handler，差异仅在
 * 「谁按下」。本测试锁定两条契约：
 *   1. handleShutdownSignal 对 SIGUSR2 与其它 signal 一样透传标签给 gracefulShutdown。
 *   2. setupShutdownHandlers 额外注册了 SIGUSR2 监听（与既有 SIGINT/SIGTERM 并存）。
 */
import {
  //
  expect,
  test,
} from "bun:test"

import {
  //
  _resetShutdownState,
  handleShutdownSignal,
  setupShutdownHandlers,
} from "~/lib/shutdown"

test("SIGUSR2 经 handleShutdownSignal 触发 gracefulShutdown 且透传 signal 标签", async () => {
  _resetShutdownState()
  const calls: Array<string> = []
  const gracefulShutdownFn = (signal: string): Promise<void> => {
    calls.push(signal)
    return Promise.resolve()
  }
  await handleShutdownSignal("SIGUSR2", { gracefulShutdownFn, exitFn: () => {} })
  expect(calls).toEqual(["SIGUSR2"])
  _resetShutdownState()
})

test("setupShutdownHandlers 注册 SIGUSR2 监听", () => {
  const before = process.listenerCount("SIGUSR2")
  setupShutdownHandlers()
  expect(process.listenerCount("SIGUSR2")).toBe(before + 1)
  // 清理：移除本测试新增的监听，避免污染其它测试
  process.removeAllListeners("SIGUSR2")
})
