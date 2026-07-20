// exp/graceful-restart-reuseport/probe-keepalive-control.ts
//
// Step 1.5 对照探针：交叉验证——用 `fetch()`（浏览器式 keep-alive 连接池）复现假阳性，
// 证明 probe.ts 的 fresh-connection PASS 不是运气、而是真排除了连接池变量。
//
// 预期：本探针在「关旧 listener 后」阶段会含 OLD（连接池复用了指向旧进程的旧连接），
// 即便内核层面新连接已 100% 分发给新进程——这正是 R1 评审 BLOCKER-1 描述的假阳性来源。
const PORT = 41990 // 非 4141

const oldSrv = Bun.serve({ port: PORT, reusePort: true, fetch: () => new Response("OLD") })
const newSrv = Bun.serve({ port: PORT, reusePort: true, fetch: () => new Response("NEW") })

// keep-alive 探针：用默认 fetch()，让 undici/Bun 的连接池按其默认策略工作（不加
// Connection: close，不禁用 keepalive）。
async function hitKeepAlive(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/`)
  const text = await res.text()
  return text
}

const overlap = await Promise.all(Array.from({ length: 20 }, hitKeepAlive))
console.log(
  "[keep-alive 对照] overlap 分布:",
  overlap.reduce(
    (a, s) => ((a[s] = (a[s] ?? 0) + 1), a),
    {} as Record<string, number>,
  ),
)

await oldSrv.stop(false)
await Bun.sleep(100)

// 用同一批客户端顺序发请求（模拟真实客户端复用连接池的行为）。
const after: Array<string> = []
for (let i = 0; i < 50; i++) {
  after.push(await hitKeepAlive())
}
const distinct = new Set(after)
console.log("[keep-alive 对照] 关旧 listener 后分布:", [...distinct], "count:", after.length)
if (distinct.size === 1 && distinct.has("NEW")) {
  console.log("[keep-alive 对照] 未复现假阳性（本次全 NEW，可能是连接池未建立复用连接）")
} else {
  console.log(
    "[keep-alive 对照] 复现假阳性（PASS 的含义）：含非 NEW =",
    after.filter((s) => s !== "NEW").length,
    "—— 证明 keep-alive 连接池会掩盖内核层面的正确分发",
  )
}
await newSrv.stop(true)
