/**
 * 进程级寄存器：优雅重启接管时，新进程记下「仍活着、正在 drain 的 live 前任」的
 * (pid, bootTime)，供 `history/sqlite/connection.ts` 的 reclaimOrphanedActiveRows
 * 排除——避免误把前任正在 drain 的在途行刷成 interrupted（lifecycle.md「overlap 共享状态安全 ①」）。
 *
 * leaf 模块、零项目内依赖：connection.ts 读它，避免 import start/takeover 造成循环依赖。
 */
let excluded: { pid: number; bootTime: number } | null = null

export function setExcludedPredecessor(p: { pid: number; bootTime: number } | null): void {
  excluded = p
}

export function getExcludedPredecessor(): { pid: number; bootTime: number } | null {
  return excluded
}
