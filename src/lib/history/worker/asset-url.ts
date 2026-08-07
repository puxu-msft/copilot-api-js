export function resolveHistoryWorkerUrl(override?: URL | string, baseUrl = import.meta.url): URL {
  if (override instanceof URL) return override
  if (typeof override === "string") return new URL(override, baseUrl)
  return new URL("./history-worker.mjs", baseUrl)
}
