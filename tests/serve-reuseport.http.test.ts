/**
 * reusePort：零停机换代的内核前提——新旧进程必须能同时绑同一端口（lifecycle.md
 * 「优雅重启」）。本测试用非 4141 端口验证两个 startServer() 实例可同绑一端口
 * （reusePort 生效的可观测证据）；用后按实例精确关闭，绝不碰 4141。
 */
import { expect, test } from "bun:test"

import { startServer } from "~/lib/serve"

test("reusePort: 两个 server 可同时绑同一端口", async () => {
  const PORT = 41991
  const opts = { fetch: () => new Response("ok"), port: PORT, hostnames: ["127.0.0.1"] }
  const a = await startServer(opts)
  const b = await startServer(opts) // 无 reusePort 时这里会 throw "port in use"
  expect(a).toBeDefined()
  expect(b).toBeDefined()
  await a.close(true)
  await b.close(true)
})
