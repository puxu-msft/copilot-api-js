import type { Model } from "~backend/lib/models/client"

import { useMemo } from "react"

import { CodeBlock } from "@/components/detail/CodeBlock"

/**
 * Raw JSON tab: the COMPLETE model object as received by the frontend, including
 * `request_headers` (`/api/models` no longer strips it — ADR internal-tool-security-posture,
 * richest-data-flow). Syntax-highlighted via the shared shiki CodeBlock.
 */
export function RawJsonTab({ model }: { model: Model }) {
  const json = useMemo(() => JSON.stringify(model, null, 2), [model])
  return <CodeBlock code={json} />
}
