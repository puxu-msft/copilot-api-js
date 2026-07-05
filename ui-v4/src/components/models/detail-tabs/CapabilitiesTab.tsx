import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import {
  //
  Bool,
  renderValue,
  Row,
  Section,
} from "@/components/models/detail-tabs/DetailParts"
import { JsonTreeView } from "@/components/tools/JsonTreeView"

const DERIVED_ROWS: ReadonlyArray<{ key: keyof DerivedCapabilities; label: string }> = [
  { key: "vision", label: "vision" },
  { key: "toolCalls", label: "tool_calls" },
  { key: "parallelToolCalls", label: "parallel_tool_calls" },
  { key: "structuredOutputs", label: "structured_outputs" },
  { key: "streaming", label: "streaming" },
  { key: "thinking", label: "thinking" },
  { key: "adaptiveThinking", label: "adaptive_thinking" },
]

/**
 * Capabilities tab: the derived boolean matrix (same source as backend `/models`)
 * PLUS the COMPLETE raw `capabilities.supports` map — not just the derived subset.
 *
 * richest-data-flow: `supports` is an open map (booleans + numbers like
 * min/max_thinking_budget + string arrays like reasoning_effort + any future
 * flag). We show the derived view for the common booleans and the full raw map
 * below it so nothing upstream sends is hidden.
 */
export function CapabilitiesTab({ model, caps }: { model: Model; caps: DerivedCapabilities }) {
  const supports = model.capabilities?.supports ?? {}

  return (
    <div>
      <Section title="Derived capabilities">
        {DERIVED_ROWS.map((r) => (
          <Row
            key={r.key}
            label={r.label}
          >
            <Bool on={Boolean(caps[r.key])} />
          </Row>
        ))}
        <Row
          label="max_thinking_budget"
          value={caps.maxThinkingBudget || undefined}
        />
        <Row label="reasoning_effort">{caps.reasoningEffort.length > 0 ? caps.reasoningEffort.join(" / ") : renderValue(undefined)}</Row>
      </Section>

      <Section title="Raw supports map">
        {Object.keys(supports).length > 0 ?
          <JsonTreeView value={supports} />
        : renderValue(undefined)}
      </Section>
    </div>
  )
}
