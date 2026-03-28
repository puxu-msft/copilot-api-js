export function isVuetifyPath(path: string): boolean {
  return path.startsWith("/v/")
}

export function getVariantSwitchPath(path: string): string {
  if (path === "/") {
    return "/v/dashboard"
  }

  if (isVuetifyPath(path)) {
    return path.replace("/v/", "/")
  }

  return `/v${path}`
}
