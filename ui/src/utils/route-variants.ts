export interface NavLink {
  label: string
  path: string
}

export const vuetifyNavLinks: Array<NavLink> = [
  { path: "/v/dashboard", label: "Dashboard" },
  { path: "/v/config", label: "Config" },
  { path: "/v/models", label: "Models" },
  { path: "/v/activity", label: "Activity" },
]

export const legacyNavLinks: Array<NavLink> = [
  { path: "/logs", label: "Logs" },
]

const variantSwitchByPath: Record<string, string | null> = {
  "/": "/v/dashboard",
  "/dashboard": "/v/dashboard",
  "/history": "/v/activity",
  "/logs": "/v/activity",
  "/models": "/v/models",
  "/usage": "/v/dashboard",
  "/v/dashboard": null,
  "/v/logs": "/logs",
  "/v/activity": "/logs",
  "/v/models": null,
  "/v/config": null,
  "/v/usage": null,
}

export function isVuetifyPath(path: string): boolean {
  return path.startsWith("/v/")
}

export function getVariantSwitchPath(path: string): string | null {
  return variantSwitchByPath[path] ?? null
}
