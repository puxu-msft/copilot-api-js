import type { Model } from "~backend/lib/models/client"

import { RawJsonView } from "@/components/common/RawJsonView"

/**
 * Raw JSON tab: the COMPLETE model object as received by the frontend, including
 * `request_headers` (`/api/models` no longer strips it — ADR internal-tool-security-posture,
 * richest-data-flow). Rendered through the shared `RawJsonView` dual view: a
 * syntax-highlighted source pane (default) plus a collapsible tree pane.
 */
export function RawJsonTab({ model }: { model: Model }) {
  return <RawJsonView value={model} />
}
