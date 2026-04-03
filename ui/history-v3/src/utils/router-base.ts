export function resolveRouterBase(base: string | undefined): string {
  return typeof base === "string" && base.length > 0 ? base : "/"
}
