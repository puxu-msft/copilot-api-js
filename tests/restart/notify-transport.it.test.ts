import {
  //
  expect,
  test,
} from "bun:test"
import {
  //
  existsSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"

import { sdNotify } from "../../src/lib/restart/notify"

// 真送达集成测试（独立 oracle = 真实 Python AF_UNIX SOCK_DGRAM server，
// 复用 Task 0.5 PoC 的 exp/graceful-restart-sdnotify/dgram-server.py）。
// notify.unit.test.ts 只验证分发逻辑（有无 NOTIFY_SOCKET / never-throw）；
// 这里验证 sendDatagram 的 bun:ffi 实现真能让对端收到字节，覆盖两种
// sockaddr_un 地址语义（普通路径 socket vs abstract namespace socket），
// 这两者 addrlen 计算方式不同（abstract 不含 trailing NUL），任何一处算错都会
// 静默送达失败（无异常、无日志——PoC 阶段已实测复现过这个陷阱）。
const SDNOTIFY_DIR = join(import.meta.dir, "..", "..", "exp", "graceful-restart-sdnotify")
const SERVER_SCRIPT = join(SDNOTIFY_DIR, "dgram-server.py")

/**
 * 起一次性 dgram server（收到一条消息即退出），发送后判定是否收到。
 *
 * ⚠️ 轮询陷阱（本文件曾踩过，实测复现）：等待 "listening" 就绪不能用
 * `Promise.race([reader.read(), timeout])` 反复发起——每次超时都会丢弃前一个
 * 尚未 resolve 的 `read()`，而 ReadableStreamDefaultReader 同一时刻只允许一个
 * 在途 read；一旦真正的数据在某次「超时那一刻」才到达，其对应的 read() 结果
 * 会被后续新发起的 read() 静默抢走/丢失，造成偶发 timeout（约 40% 复现率）。
 * 正确做法：维持单一常驻的 read() promise，用 `Promise.race` 只做「加个超时上限」，
 * 赢的一方若是 timeout 就继续等同一个 pending promise，而不是重新发起。
 */
async function receivedViaRealServer(socketPath: string, bind: "path" | "abstract", send: () => void): Promise<boolean> {
  const spawnArgs = bind === "path" ? ["python3", SERVER_SCRIPT, socketPath, "--once"] : ["python3", "-c", abstractServerScript, socketPath]
  if (bind === "path" && existsSync(socketPath)) unlinkSync(socketPath)
  const proc = Bun.spawn(spawnArgs, { stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let stdout = ""
  let pendingRead: ReturnType<typeof reader.read> | undefined
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !stdout.includes("listening")) {
    pendingRead ??= reader.read() // 复用同一个 in-flight read，绝不重新发起
    const timedOut = Symbol("timeout")
    const result = await Promise.race([pendingRead, new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), 20))])
    if (result === timedOut) continue // 仍在等同一个 pendingRead，下一轮继续 race 它
    pendingRead = undefined // 这次真的 resolve 了，下一轮该发起新的 read
    const { value, done } = result
    if (value) stdout += decoder.decode(value)
    if (done) break
  }
  send()
  // 剩余读取：此时不再有超时压力（server 收到消息后很快打印+退出），串行读到 EOF 即可。
  for (;;) {
    const { value, done } = pendingRead ? await pendingRead : await reader.read()
    pendingRead = undefined
    if (value) stdout += decoder.decode(value)
    if (done) break
  }
  const code = await proc.exited
  if (bind === "path" && existsSync(socketPath)) unlinkSync(socketPath)
  return code === 0 && stdout.includes("received:")
}

// abstract 版 mock server（dgram-server.py 只支持普通路径 bind，abstract 需前导 \0，
// 这里内联一个等价的最小脚本，与 dgram-server.py 逻辑一致但绑定 abstract 名字）。
const abstractServerScript = `
import socket, sys
name = sys.argv[1]
srv = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
srv.bind("\\0" + name)
srv.settimeout(2.0)
print("listening (abstract)", flush=True)
try:
    data, _ = srv.recvfrom(4096)
    print(f"received: {data!r}", flush=True)
except socket.timeout:
    print("timeout", flush=True)
    sys.exit(1)
`

test("sdNotify 真送达：普通路径 AF_UNIX SOCK_DGRAM socket 收到 READY=1", async () => {
  const socketPath = `/tmp/notify-it-plain-${process.pid}.sock`
  const ok = await receivedViaRealServer(socketPath, "path", () => {
    sdNotify("READY=1", { NOTIFY_SOCKET: socketPath })
  })
  expect(ok).toBe(true)
})

test("sdNotify 真送达：'@' abstract namespace socket 收到 READY=1（addrlen 不含 trailing NUL）", async () => {
  const abstractName = `notify-it-abstract-${process.pid}`
  const ok = await receivedViaRealServer(abstractName, "abstract", () => {
    sdNotify("READY=1", { NOTIFY_SOCKET: `@${abstractName}` })
  })
  expect(ok).toBe(true)
})
