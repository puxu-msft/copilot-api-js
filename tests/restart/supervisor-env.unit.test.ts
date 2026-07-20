import { expect, test } from "bun:test"

import { detectSupervisor, isSupervised } from "../../src/lib/restart/supervisor-env"

test("systemd 判别：NOTIFY_SOCKET 或 INVOCATION_ID", () => {
  expect(detectSupervisor({ NOTIFY_SOCKET: "/run/x.sock" })).toBe("systemd")
  expect(detectSupervisor({ INVOCATION_ID: "abc" })).toBe("systemd")
})
test("pm2 判别：PM2_HOME 或 pm_id", () => {
  expect(detectSupervisor({ PM2_HOME: "/x/.pm2" })).toBe("pm2")
  expect(detectSupervisor({ pm_id: "0" })).toBe("pm2")
})
test("裸手动：无 supervisor 环境 → null", () => {
  expect(detectSupervisor({})).toBeNull()
  expect(isSupervised({})).toBe(false)
  expect(isSupervised({ NOTIFY_SOCKET: "/run/x.sock" })).toBe(true)
})
test("systemd 优先于 pm2（同时存在时）", () => {
  expect(detectSupervisor({ NOTIFY_SOCKET: "/run/x.sock", PM2_HOME: "/x" })).toBe("systemd")
})
