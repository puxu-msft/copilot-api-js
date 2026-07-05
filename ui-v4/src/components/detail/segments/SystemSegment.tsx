import { useState } from "react"

import type { HistoryEntry } from "@/types"

import { SystemMessage } from "@/components/detail/blocks/SystemMessage"
import { CodeBlock } from "@/components/detail/CodeBlock"

type SystemView = "rendered" | "raw"

const TOGGLE_BASE = "mono border border-[var(--color-border)] px-2 py-0.5 text-[12px]"

function viewClass(active: boolean): string {
  return `${TOGGLE_BASE} ${active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`
}

/**
 * Dedicated segment for the request's system prompt(s), split out of the Convo
 * segment so each renders in its richest form: Convo owns the message turns, this
 * owns the system payload. The Rendered view reuses `SystemMessage` (string/block
 * array, cache_control labels, inbound→effective original/rewritten/diff); Raw
 * exposes the untouched system JSON (block structure + cache_control). The full
 * inbound request body lives under Stages → Inbound → Raw.
 */
export function SystemSegment({ entry }: { entry: HistoryEntry }) {
  const [view, setView] = useState<SystemView>("rendered")
  const system = entry.inboundRequest.system
  const rewrittenSystem = entry.effectiveRequest?.system

  // Field-absent (undefined) means no system prompt → placeholder. A present-but-empty
  // system ("" or []) is a real client-sent payload and is rendered as-is, not hidden:
  // an explicit empty system is distinct from a missing one (richest-data-flow).
  if (system === undefined) {
    return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无 system prompt</div>
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setView("rendered")}
          className={viewClass(view === "rendered")}
        >
          Rendered
        </button>
        <button
          type="button"
          onClick={() => setView("raw")}
          className={viewClass(view === "raw")}
        >
          Raw body
        </button>
      </div>
      {view === "raw" ?
        <CodeBlock
          code={JSON.stringify(system, null, 2)}
          lang="json"
        />
      : <SystemMessage
          system={system}
          rewrittenSystem={rewrittenSystem}
        />
      }
    </div>
  )
}
