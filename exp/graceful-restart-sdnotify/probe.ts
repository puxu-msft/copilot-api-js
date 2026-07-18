// exp/graceful-restart-sdnotify/probe.ts
//
// sd_notify 传输选型 PoC（docs/plan/2026-07-14-graceful-restart.md Task 0.5，R1 评审 BLOCKER-3）。
//
// 背景：systemd 的 `$NOTIFY_SOCKET` 是 AF_UNIX SOCK_DGRAM，但 `node:dgram` 只支持
// udp4/udp6，createSocket("unix_dgram") 直接抛 "Bad socket type"（Bun 与 Node 均不支持）。
// 本探针起一个真实的 Python SOCK_DGRAM AF_UNIX server（模拟 systemd），逐个实测三个候选
// 发送方是否能让 server 真正收到 "READY=1"。
//
// Usage: bun run exp/graceful-restart-sdnotify/probe.ts
import { spawnSync } from "node:child_process"
import { existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"

const HERE = import.meta.dir
const SERVER_SCRIPT = join(HERE, "dgram-server.py")

interface CandidateResult {
  name: string
  feasible: boolean
  detail: string
}

/** 起一次性 dgram server（收到一条消息即退出），跑 `send` 后收集其 stdout 判定是否收到 READY=1。 */
async function runAgainstServer(socketPath: string, send: () => Promise<void> | void): Promise<{ received: boolean; serverOutput: string }> {
  if (existsSync(socketPath)) unlinkSync(socketPath)
  const proc = Bun.spawn(["python3", SERVER_SCRIPT, socketPath, "--once"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  // 单一 reader 贯穿全程：先等「listening on」再发送，最后继续读到 EOF 拼出完整 stdout
  // （不能像之前那样先用一个 reader 等 listening、再用 new Response(proc.stdout) 读——
  // 同一 ReadableStream 只能被消费一次，会抛 "ReadableStream has already been used"）。
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let stdout = ""
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !stdout.includes("listening on")) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: false }>((r) => setTimeout(() => r({ value: undefined, done: false }), 50)),
    ])
    if (value) stdout += decoder.decode(value)
    if (done) break
  }
  await send()
  // 继续读完剩余 stdout（server 收到消息后打印 "received:" 并退出）。
  for (;;) {
    const { value, done } = await reader.read()
    if (value) stdout += decoder.decode(value)
    if (done) break
  }
  const code = await proc.exited
  const stderr = await new Response(proc.stderr).text()
  if (existsSync(socketPath)) unlinkSync(socketPath)
  return { received: code === 0 && stdout.includes("received:"), serverOutput: stdout + stderr }
}

const results: Array<CandidateResult> = []

// ---- 候选 0（对照）: node:dgram unix_dgram —— 已知 BLOCKER-3，验证仍然 FAIL ----
{
  let detail = ""
  let feasible = false
  try {
    const dgram = await import("node:dgram")
    dgram.createSocket("unix_dgram" as never)
    feasible = true
    detail = "意外成功（与 BLOCKER-3 预期不符，需重新核实 Bun 版本行为）"
  } catch (err) {
    detail = `FAIL（预期内）: ${(err as Error).message}`
  }
  results.push({ name: "node:dgram unix_dgram", feasible, detail })
}

// ---- 候选 1: bun:ffi 直接 socket(2)+sendto(2) syscall ----
{
  const socketPath = "/tmp/graceful-restart-sdnotify-poc-ffi.sock"
  let feasible = false
  let detail = ""
  try {
    const { received, serverOutput } = await runAgainstServer(socketPath, async () => {
      const { dlopen, FFIType, ptr } = await import("bun:ffi")
      const { symbols } = dlopen("libc.so.6", {
        socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        sendto: {
          args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i64,
        },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
      })
      const AF_UNIX = 1
      const SOCK_DGRAM = 2
      const fd = symbols.socket(AF_UNIX, SOCK_DGRAM, 0)
      if (fd < 0) throw new Error("socket() 失败")
      // struct sockaddr_un { sa_family_t sun_family; char sun_path[108]; }（Linux x86_64：sun_family 是 u16）
      const addrBuf = new Uint8Array(2 + 108)
      new DataView(addrBuf.buffer).setUint16(0, AF_UNIX, true) // little-endian
      const pathBytes = new TextEncoder().encode(socketPath)
      addrBuf.set(pathBytes, 2)
      const addrLen = 2 + pathBytes.length + 1 // + NUL 终止符
      const msg = new TextEncoder().encode("READY=1")
      const r = symbols.sendto(fd, ptr(msg), msg.length, 0, ptr(addrBuf), addrLen)
      symbols.close(fd)
      if (r < 0) throw new Error("sendto() 失败")
    })
    feasible = received
    detail = received
      ? `PASS：server 收到 READY=1（${serverOutput.trim().split("\n").pop()}）。零外部依赖，纯 syscall。`
      : `FAIL：server 未收到消息。output=${serverOutput}`
  } catch (err) {
    detail = `FAIL（异常）: ${(err as Error).message}`
  }
  results.push({ name: "bun:ffi socket+sendto", feasible, detail })
}

// ---- 候选 2: spawn systemd-notify 二进制 ----
{
  const socketPath = "/tmp/graceful-restart-sdnotify-poc-spawn.sock"
  let feasible = false
  let detail = ""
  const hasBinary = spawnSync("which", ["systemd-notify"]).status === 0
  if (!hasBinary) {
    detail = "FAIL：本机无 systemd-notify 二进制（which 未命中）"
  } else {
    try {
      const { received, serverOutput } = await runAgainstServer(socketPath, async () => {
        // --no-block：跳过 systemd 的 barrier 同步握手（真实 systemd 会回应 barrier，
        // 我们的 mock Python dgram server 不实现该协议，不加会阻塞/报错——这是 mock 的局限，
        // 不影响候选本身可行性；生产环境对接真 systemd 时该参数依然安全可用）。
        const proc = Bun.spawn(["systemd-notify", "--no-block", "--ready"], {
          env: { ...process.env, NOTIFY_SOCKET: socketPath },
        })
        const code = await proc.exited
        if (code !== 0) throw new Error(`systemd-notify 退出码 ${code}`)
      })
      feasible = received
      detail = received
        ? `PASS：server 收到 READY=1（${serverOutput.trim().split("\n").pop()}）。依赖运行时 systemd-utils 二进制（systemd 环境本就有）。`
        : `FAIL：server 未收到消息。output=${serverOutput}`
    } catch (err) {
      detail = `FAIL（异常）: ${(err as Error).message}`
    }
  }
  results.push({ name: "spawn systemd-notify", feasible, detail })
}

// ---- 候选 3: 原生绑定包 sd-notify（隔离临时目录验证，不装进项目依赖）----
// 见 FINDINGS.md「候选 3 实测记录」——已在 /tmp 隔离目录验证：
// `bun add sd-notify` 触发 postinstall `node-gyp rebuild`（Bun 默认拦截未信任脚本）；
// `bun pm trust` 放行后实际编译，因本机缺 <systemd/sd-daemon.h> 头文件而编译失败
// （即便装了对应 -dev 包，node-gyp 原生绑定在 Bun 下仍属公认高风险路径，符合计划预判）。
results.push({
  name: "原生绑定包 sd-notify（npm）",
  feasible: false,
  detail:
    "FAIL：postinstall 触发 node-gyp rebuild，编译期缺 systemd/sd-daemon.h 头文件失败；" +
    "即便补头文件，node-gyp 原生绑定在 Bun 运行时加载仍有系统性风险（ABI 不匹配等）。已在隔离 /tmp 目录验证，不污染项目依赖。",
})

console.log("\n=== sd_notify 传输选型 PoC 结果 ===\n")
for (const r of results) {
  console.log(`[${r.feasible ? "PASS" : "FAIL"}] ${r.name}`)
  console.log(`  ${r.detail}`)
}

const winner = results.find((r) => r.feasible && r.name.startsWith("bun:ffi"))
console.log(`\n选定方案: ${winner ? winner.name : "（无 PASS 候选——需人工介入）"}`)
