export function isVuetifyPath(path: string): boolean {
  return path.startsWith("/v/")
}

export function getVariantSwitchPath(path: string): string | null {
  if (path === "/") {
    return "/v/dashboard"
  }

  if (path === "/v/config") {
    return null
  }

  if (isVuetifyPath(path)) {
    return path.replace("/v/", "/")
  }

  return `/v${path}`
}
