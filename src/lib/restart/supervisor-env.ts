/**
 * 进程 supervisor 判别 —— 决定优雅重启走哪条路径（lifecycle.md「优雅重启」）。
 *
 * 裸手动（null）：新进程自管理 pidfile + 活性 guard + 自发 SIGUSR2。
 * systemd / pm2：由脚本/supervisor 驱动信号；跳过 pidfile 机制，否则 blue-green
 * 新槽会被自己的 guard 拒绝启动。
 */
export type Supervisor = "systemd" | "pm2" | null

export function detectSupervisor(env: NodeJS.ProcessEnv = process.env): Supervisor {
  // systemd 优先：Type=notify 设 NOTIFY_SOCKET，所有 systemd 服务设 INVOCATION_ID。
  if (env.NOTIFY_SOCKET || env.INVOCATION_ID) return "systemd"
  // pm2：PM2_HOME 恒设，pm_id 是 worker 序号（"0" 亦真，故判 !== undefined）。
  if (env.PM2_HOME || env.pm_id !== undefined) return "pm2"
  return null
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectSupervisor(env) !== null
}
