import net from "node:net"
import { execSync } from "node:child_process"
const PORT = 37775
const sock = net.connect(PORT, "127.0.0.1", () => {
  sock.setKeepAlive(true, 8000)
  const lp = sock.localPort
  console.log("connected lp=", lp)
  setTimeout(() => {
    const out = execSync(`ss -tno | grep "127.0.0.1:${lp} " || true`).toString()
    console.log("ss line:", out.trim() || "(none)")
    console.log("loopback keepalive visible?", /timer:\(keepalive/.test(out))
    sock.destroy(); process.exit(0)
  }, 1500)
})
sock.on("error", e => { console.log("err", e.message); process.exit(1) })
