export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined => value === null || value === undefined

/** Convert bytes to KB with rounding */
export function bytesToKB(bytes: number): number {
  return Math.round(bytes / 1024)
}

/** Generate unique ID (timestamp + random) */
export function generateId(randomLength = 7): string {
  return (
    Date.now().toString(36)
    + Math.random()
      .toString(36)
      .slice(2, 2 + randomLength)
  )
}
