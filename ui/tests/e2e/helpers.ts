// This UI workspace's own preview/dev server (built from ui/vite.config.ts),
// NOT the main backend (see docs/plan/2026-07-22-ui-externalize.md — the main
// server no longer serves or proxies /ui at all; ops host this workspace's
// dist/ independently). Default 4173 matches vite preview's default port.
export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4173"

export async function ensureServerRunning() {
  try {
    const res = await fetch(`${BASE_URL}/ui/`)
    if (!res.ok) throw new Error(`UI server check returned ${res.status}`)
  } catch (error) {
    throw new Error(
      `UI preview/dev server is not running at ${BASE_URL}. Run "bun run build && bun run preview" (or "bun run dev") in ui/ before running E2E tests. `
        + `Error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function uiUrl(hashPath = ""): string {
  return `${BASE_URL}/ui${hashPath}`
}
