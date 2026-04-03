export function formatWsTargetStatus(target: string, connected: boolean): string {
  return `${target}: ${connected ? "live" : "offline"}`
}
