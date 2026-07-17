import consola from "consola"
import { createRequire } from "node:module"

/**
 * 就绪 / 生命周期通知（lifecycle.md「notifyReady 一点三后端」）。
 * 无对应环境时各腿 no-op；全部 never-throw（通知失败绝不中断启动/关闭）。
 */

// 运行时条件加载 bun:ffi：`createRequire` 让 bundler 不在构建期静态解析这个模块
// （同 src/lib/sqlite/driver.ts 对 bun:sqlite/node:sqlite 的既有惯例）。
const nodeRequire = createRequire(import.meta.url)

/**
 * 向 systemd 的 `$NOTIFY_SOCKET`（AF_UNIX SOCK_DGRAM）投递一条原始 datagram。
 *
 * 传输方式由 Task 0.5 PoC 选定（exp/graceful-restart-sdnotify/FINDINGS.md，B3）——
 * `node:dgram` 的 `createSocket("unix_dgram")` 在 Bun/Node 下均抛 `Bad socket type`，
 * 故不可用 node:dgram。这里直接用 `bun:ffi` 调 libc 的 `socket(2)`/`sendto(2)`/`close(2)`，
 * 零外部运行时依赖，PoC 3/3 连跑稳定验证过（普通路径 socket 一侧）。
 *
 * never-throw：任何一步失败（dlopen 失败、socket 创建失败、sendto 失败）都吞掉，仅 debug 日志。
 *
 * `isAbstract` 区分两种 `sockaddr_un.sun_path` 语义（PoC 未覆盖 abstract 侧，
 * 本实现补充实测修正）：
 *   - 普通路径 socket：`sun_path` 是 NUL 结尾字符串，addrlen 含 1 个 trailing NUL。
 *   - abstract namespace socket（Linux 扩展，前导 `\0`）：地址由 addrlen **精确圈定**，
 *     不以 NUL 结尾；若照普通路径那样多算 1 个 trailing NUL，NUL 会被算进抽象名字本身，
 *     导致与对端 `bind("\0name")`（无 trailing NUL）的名字不匹配、收不到消息
 *     （已用 Python 对拍验证：多 NUL 版本 timeout，精确长度版本才收到）。
 */
function sendDatagram(socketPath: string, payload: Buffer, isAbstract: boolean): void {
  try {
    // 惰性加载：bun:ffi 只在真正需要发送时才加载，避免非 systemd 环境（绝大多数场景）
    // 付出 dlopen 开销，也避免在非 Bun 运行时静态 import 报错。
    const { dlopen, FFIType, ptr } = nodeRequire("bun:ffi") as typeof import("bun:ffi")
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
    if (fd < 0) {
      consola.debug(`[restart] sd_notify: socket() 创建失败（非致命）`)
      return
    }
    try {
      // struct sockaddr_un { sa_family_t sun_family; char sun_path[108]; }（Linux x86_64/arm64 稳定 ABI）
      const addrBuf = new Uint8Array(2 + 108)
      new DataView(addrBuf.buffer).setUint16(0, AF_UNIX, true) // little-endian（本平台原生字节序）
      const pathBytes = new TextEncoder().encode(socketPath)
      addrBuf.set(pathBytes, 2)
      // abstract：addrlen 精确圈定 name，不含 trailing NUL；普通路径：含 1 个 trailing NUL 终止符。
      const addrLen = isAbstract ? 2 + pathBytes.length : 2 + pathBytes.length + 1
      const r = symbols.sendto(fd, ptr(payload), payload.length, 0, ptr(addrBuf), addrLen)
      if (r < 0) {
        consola.debug(`[restart] sd_notify: sendto() 失败（非致命）`)
      }
    } finally {
      symbols.close(fd)
    }
  } catch (err) {
    // dlopen 失败（非 Linux / 无 libc.so.6）、bun:ffi 不可用（非 Bun 运行时）等 —— 全部吞掉。
    consola.debug("[restart] sd_notify 发送异常（非致命）", err)
  }
}

/**
 * 向 systemd 的 $NOTIFY_SOCKET 投递一条状态消息（AF_UNIX SOCK_DGRAM）。
 * 无 `NOTIFY_SOCKET` 环境变量（非 systemd Type=notify）→ no-op。
 */
export function sdNotify(state: string, env: NodeJS.ProcessEnv = process.env): void {
  const socketPath = env.NOTIFY_SOCKET
  if (!socketPath) return // 非 systemd Type=notify → no-op
  try {
    // '@' 前缀 = Linux abstract namespace socket 惯例，对应真实路径的前导 NUL 字节。
    const isAbstract = socketPath.startsWith("@")
    const target = isAbstract ? `\0${socketPath.slice(1)}` : socketPath
    sendDatagram(target, Buffer.from(state), isAbstract)
  } catch (err) {
    consola.debug("[restart] sd_notify 异常（非致命）", err)
  }
}

/** 就绪：sd_notify READY=1 + pm2 process.send('ready')。 */
export function notifyReady(env: NodeJS.ProcessEnv = process.env): void {
  sdNotify("READY=1", env)
  try {
    process.send?.("ready") // pm2 wait_ready 契约；非 pm2 时 process.send 不存在 → 跳过
  } catch (err) {
    consola.debug("[restart] pm2 ready 通知失败（非致命）", err)
  }
}

/** 进入 drain：sd_notify STOPPING=1（让 systemd 知道正在收尾）。 */
export function notifyStopping(env: NodeJS.ProcessEnv = process.env): void {
  sdNotify("STOPPING=1", env)
}
