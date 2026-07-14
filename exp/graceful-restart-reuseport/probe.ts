// exp/graceful-restart-reuseport/probe.ts
//
// reusePort overlap 内核连接分发正确性 PoC（docs/plan/2026-07-14-graceful-restart.md Task 0）。
//
// 承重方法论（R1 评审 BLOCKER-1，实测 8/8 复现）：用默认 `fetch()` 会因 keep-alive 连接池
// 复用「指向旧进程的旧连接」，把「客户端复用旧连接」误判成「内核仍往旧进程分发新连接」→
// 假阳性 FAIL。必须每次新建 TCP 连接（`Connection: close`），并用 keep-alive vs fresh
// 双探针交叉验证（Step 1.5，见 probe-keepalive-control.ts）。
import { connect } from "node:net"

const PORT = 41990 // 非 4141（CLAUDE.md protect-user-main-server）

const oldSrv = Bun.serve({ port: PORT, reusePort: true, fetch: () => new Response("OLD") })
const newSrv = Bun.serve({ port: PORT, reusePort: true, fetch: () => new Response("NEW") })

// fresh-connection 探针：每次新建裸 TCP 连接发一个最小 HTTP/1.1 请求，读响应体。
// 绝不用 fetch()（连接池会复用旧连接，制造假阳性——见上方警告）。
function hitFresh(): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ port: PORT, host: "127.0.0.1" }, () => {
      sock.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    })
    let buf = ""
    sock.on("data", (d) => (buf += d.toString()))
    sock.on("end", () => resolve(buf.includes("OLD") ? "OLD" : buf.includes("NEW") ? "NEW" : "?"))
    sock.on("error", reject)
  })
}

// 重叠期：两者都绑，内核 LB（fresh 连接应两边都出现）。
const overlap = await Promise.all(Array.from({ length: 20 }, hitFresh))
console.log(
  "overlap 分布:",
  overlap.reduce(
    (a, s) => ((a[s] = (a[s] ?? 0) + 1), a),
    {} as Record<string, number>,
  ),
)

// 旧进程 Phase 1：停 accept（不强杀已建连接），旧进程仍存活。
await oldSrv.stop(false)
await Bun.sleep(100)

// 关键断言：此后 fresh 新连接必须 100% 落 NEW。
const after = await Promise.all(Array.from({ length: 50 }, hitFresh))
const distinct = new Set(after)
console.log("关旧 listener 后 fresh 分布:", [...distinct], "count:", after.length)
if (distinct.size === 1 && distinct.has("NEW")) {
  console.log("PASS: 关旧 listener 后 fresh 新连接 100% 落新进程")
} else {
  console.log("FAIL: fresh 分发不确定，含非 NEW =", after.filter((s) => s !== "NEW").length)
}
await newSrv.stop(true)
