export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4141"

export async function ensureServerRunning() {
  try {
    const res = await fetch(`${BASE_URL}/health`)
    if (!res.ok) throw new Error(`Health check returned ${res.status}`)
  } catch (error) {
    throw new Error(
      `Server is not running at ${BASE_URL}. Start the server before running E2E tests. `
        + `Error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function uiUrl(hashPath = ""): string {
  return `${BASE_URL}/ui${hashPath}`
}
