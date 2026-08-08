export function resolveHistoryWorkerUrl(override?: URL | string, baseUrl = import.meta.url): URL {
  if (override instanceof URL) return override
  if (typeof override === "string") return new URL(override, baseUrl)
  const extension = new URL(baseUrl).pathname.endsWith(".ts") ? ".ts" : ".mjs"
  return new URL(`./history-worker${extension}`, baseUrl)
}
