import consola from "consola"
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"

/** pidfile 内容 —— 复用 process-identity 的 pid+bootTime，加 port。 */
export interface PidfileContent {
  pid: number
  bootTime: number
  port: number
}

/** 原子写（写临时文件 + rename）。never-throw：失败仅 warn，不中断启动。 */
export function writePidfile(path: string, content: PidfileContent): void {
  try {
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(content), "utf8")
    renameSync(tmp, path)
  } catch (err) {
    consola.warn(`[restart] 写 pidfile 失败（非致命，接管协议将不可用）: ${path}`, err)
  }
}

/** 读并解析。缺失 / 损坏 / 字段缺失 → null（never-throw）。 */
export function readPidfile(path: string): PidfileContent | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PidfileContent>
    if (typeof raw.pid !== "number" || typeof raw.bootTime !== "number" || typeof raw.port !== "number") {
      return null
    }
    return { pid: raw.pid, bootTime: raw.bootTime, port: raw.port }
  } catch {
    return null // ENOENT / 损坏 JSON / 权限 —— 一律当「无有效 pidfile」
  }
}

/** 进程是否存活。`kill(pid, 0)` 不实际发信号，只探存在性。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = 不存在；EPERM = 存在但无权限（仍算存活）。
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 读到「活的、不是自己」的前任 pidfile 内容，否则 null。 */
export function readLivePredecessor(path: string, selfPid: number = process.pid): PidfileContent | null {
  const content = readPidfile(path)
  if (!content) return null
  if (content.pid === selfPid) return null // 自己写的、别当前任
  if (!isProcessAlive(content.pid)) return null // 陈旧 pidfile（崩溃/被 SIGKILL 残留）
  return content
}

/** 删除。never-throw，忽略 ENOENT。 */
export function removePidfile(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.warn(`[restart] 删 pidfile 失败（非致命）: ${path}`, err)
    }
  }
}

/**
 * compare-and-delete（B2 承重）：仅当磁盘 pidfile 的 pid == 自己时才删。
 * 接管后新进程已用自己的 pid 覆写同一路径；旧进程退出时若无条件删会误删后继者的
 * 活 pidfile → guard 永久失效、下次普通启动静默叠加第三实例。故只删「还属于自己」的那份。
 */
export function removePidfileIfOwnedBySelf(path: string, self: { pid: number; bootTime: number }): void {
  const content = readPidfile(path)
  if (!content) return // 已被删/损坏 → 没什么可删
  if (content.pid !== self.pid) {
    // 已被后继者接管改写 → 不是我的，别碰。
    return
  }
  removePidfile(path)
}
