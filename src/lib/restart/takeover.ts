import consola from "consola"

import type { PidfileContent } from "./pidfile"

import { readLivePredecessor } from "./pidfile"

/**
 * 裸手动路径的启动决策（lifecycle.md「路径一」+「pidfile 活性检查」）。
 * supervisor 路径不调用本模块（start.ts 按 isSupervised 分流）。
 */
export type StartupDecision =
  | { kind: "proceed" } // 无 live 前任，正常启动
  | { kind: "takeover"; predecessor: PidfileContent } // live 前任 + --restart：接管
  | { kind: "refuse"; predecessor: PidfileContent } // live 前任 + 无 --restart：拒绝

/**
 * 裸手动启动的顶层结果类型（供 `resolveManualStartup` 使用）。
 * `"skip"` = supervisor 环境（systemd/pm2）跳过整个 pidfile 机制——由
 * `resolveManualStartup` 按 `supervised` 分流后直接返回，不经 `decideStartup`。
 */
export type ManualStartupResult = StartupDecision | { kind: "skip" }

export function decideStartup(args: { pidfilePath: string; hasRestartFlag: boolean; selfPid?: number }): StartupDecision {
  const predecessor = readLivePredecessor(args.pidfilePath, args.selfPid)
  if (!predecessor) return { kind: "proceed" }
  return args.hasRestartFlag ? { kind: "takeover", predecessor } : { kind: "refuse", predecessor }
}

/**
 * runServer 的裸手动启动决策入口（Task 12）——把「supervisor 分流 + decideStartup」
 * 两步收拢为一个可单测的纯函数，使 runServer 只需按返回的 `kind` 做 IO 编排
 * （exit(1)/记 predecessor/继续），不必自己内联这段逻辑。
 *
 * 不再登记任何排除寄存器——overlap 期间「reclaim 排除前任 / VACUUM 跳过」现按
 * `isProcessAlive(owner_pid)` 的进程存活性裁决（lifecycle.md「overlap 共享状态安全
 * ①⑤」），环境无关、三路径统一，不依赖 takeover 分支是否被触发。
 */
export function resolveManualStartup(args: { pidfilePath: string; restart: boolean; supervised: boolean; selfPid?: number }): ManualStartupResult {
  if (args.supervised) return { kind: "skip" }
  return decideStartup({ pidfilePath: args.pidfilePath, hasRestartFlag: args.restart, selfPid: args.selfPid })
}

/** 向 live 前任发 SIGUSR2 交接信号。never-throw：前任恰好在此刻退出（ESRCH）不算错。 */
export function signalPredecessorHandoff(pid: number): void {
  try {
    process.kill(pid, "SIGUSR2")
    consola.info(`[restart] 已向前任进程 pid=${pid} 发送 SIGUSR2 交接信号`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      consola.info(`[restart] 前任 pid=${pid} 已自行退出，无需交接信号`)
    } else {
      consola.warn(`[restart] 向前任 pid=${pid} 发 SIGUSR2 失败（非致命）`, err)
    }
  }
}
