/**
 * Resolve the tokenizer Worker entry for whichever form the app is running in.
 *
 * Mirrors `~/lib/history/worker/asset-url` deliberately: from source the sibling is `tokenizer-worker.ts`, and after `tsdown` it is `dist/tokenizer-worker.mjs`, so the extension has to follow the caller's own module rather than be hardcoded. Getting this wrong does not fail the build — it fails at runtime, in production only, on the first token count.
 */
export function resolveTokenizerWorkerUrl(override?: URL | string, baseUrl = import.meta.url): URL {
  if (override instanceof URL) return override
  if (typeof override === "string") return new URL(override, baseUrl)
  const extension = new URL(baseUrl).pathname.endsWith(".ts") ? ".ts" : ".mjs"
  return new URL(`./tokenizer-worker${extension}`, baseUrl)
}
