import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import {
  //
  notifyReady,
  notifyStopping,
  sdNotify,
} from "../../src/lib/restart/notify"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

test("sdNotify 无 NOTIFY_SOCKET → no-op（不抛）", () => {
  expect(() => sdNotify("READY=1", {})).not.toThrow()
})

test("sdNotify 有 NOTIFY_SOCKET 但发送失败 → never-throw", () => {
  // 不存在的 socket 路径：sendDatagram 内部失败必须被吞（never-throw 契约）
  expect(() => sdNotify("READY=1", { NOTIFY_SOCKET: "/nonexistent/notify.sock" })).not.toThrow()
})

test("notifyReady 在 pm2（有 process.send）时调 process.send('ready')", () => {
  const calls: Array<unknown> = []
  const orig = process.send
  ;(process as { send?: unknown }).send = (m: unknown) => {
    calls.push(m)
    return true
  }
  cleanups.push(() => {
    ;(process as { send?: unknown }).send = orig
  })
  notifyReady({}) // 无 NOTIFY_SOCKET，只测 pm2 腿
  expect(calls).toContain("ready")
})

test("notifyReady 无 process.send 时（非 pm2）不抛", () => {
  const orig = process.send
  ;(process as { send?: unknown }).send = undefined
  cleanups.push(() => {
    ;(process as { send?: unknown }).send = orig
  })
  expect(() => notifyReady({})).not.toThrow()
})

test("notifyReady 在 systemd（NOTIFY_SOCKET 有值）时也走 sdNotify 分支，never-throw", () => {
  expect(() => notifyReady({ NOTIFY_SOCKET: "/nonexistent/notify.sock" })).not.toThrow()
})

test("notifyStopping 无 NOTIFY_SOCKET → no-op（不抛）", () => {
  expect(() => notifyStopping({})).not.toThrow()
})

test("notifyStopping 有 NOTIFY_SOCKET 时也 never-throw", () => {
  expect(() => notifyStopping({ NOTIFY_SOCKET: "/nonexistent/notify.sock" })).not.toThrow()
})

test("sdNotify abstract socket（'@' 前缀）路径也 never-throw", () => {
  // '@' 前缀在 systemd 惯例里代表 Linux abstract namespace socket（前导 NUL），
  // 此处不存在对应的真实 abstract socket，验证分发逻辑仍 never-throw。
  expect(() => sdNotify("READY=1", { NOTIFY_SOCKET: "@copilot-api-poc-does-not-exist" })).not.toThrow()
})
