export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const { timeout = 2000, interval = 10, label = "condition" } = opts
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error(`waitUntil timed out after ${timeout}ms waiting for: ${label}`)
}
