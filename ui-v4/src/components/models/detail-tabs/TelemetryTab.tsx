import type {
  //
  JoinedModelTelemetry,
  ModelTelemetryStats,
} from "@/lib/model-telemetry"

import {
  //
  renderValue,
  Row,
  Section,
} from "@/components/models/detail-tabs/DetailParts"
import { formatDuration } from "@/lib/format"

/** Render one telemetry window (7d or since-start), or a "no traffic" note when absent. */
function Window({ title, stats }: { title: string; stats: ModelTelemetryStats | null }) {
  if (!stats) {
    return (
      <Section title={title}>
        <div className="py-0.5 text-[12px] text-[var(--content-disabled)]">no traffic</div>
      </Section>
    )
  }
  const u = stats.usage
  return (
    <Section title={title}>
      <Row
        label="requests"
        value={stats.requestCount}
      />
      <Row
        label="success"
        value={stats.successCount}
      />
      <Row label="failure">
        <span className={stats.failureCount > 0 ? "text-[var(--signal-fail)]" : undefined}>{stats.failureCount}</span>
      </Row>
      <Row
        label="avg duration"
        value={formatDuration(stats.averageDurationMs)}
      />
      <Row
        label="input tokens"
        value={u.inputTokens}
      />
      <Row
        label="output tokens"
        value={u.outputTokens}
      />
      <Row
        label="total tokens"
        value={u.totalTokens}
      />
      <Row
        label="cache read tokens"
        value={u.cacheReadInputTokens}
      />
      <Row
        label="cache creation tokens"
        value={u.cacheCreationInputTokens}
      />
      <Row
        label="reasoning tokens"
        value={u.reasoningTokens}
      />
    </Section>
  )
}

/**
 * Telemetry tab: runtime request telemetry joined by normalized model id (spec §4).
 *
 * Both windows shown: `Last 7 days` (primary) + `Since start` (cumulative). All
 * 6 token components are surfaced. The failure count aggregates by upstream
 * canonical name, so pure-alias failing requests (no success leg to backfill the
 * canonical id) land in the page's "Unmatched telemetry" section rather than
 * here — annotated below so a low failure count isn't misread.
 */
export function TelemetryTab({ telemetry }: { telemetry: JoinedModelTelemetry | null }) {
  if (!telemetry || (!telemetry.last7d && !telemetry.sinceStart)) {
    return (
      <div>
        <div className="py-0.5 text-[12px] text-[var(--content-dim)]">{renderValue(undefined)} no runtime telemetry joined to this model.</div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--content-muted)]">
          Failure counts aggregate by upstream canonical name; pure-alias failing requests appear in the page's Unmatched telemetry section.
        </p>
      </div>
    )
  }
  return (
    <div>
      <Window
        title="Last 7 days"
        stats={telemetry.last7d}
      />
      <Window
        title="Since start"
        stats={telemetry.sinceStart}
      />
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--content-muted)]">
        Failure counts aggregate by upstream canonical name; pure-alias failing requests appear in the page's Unmatched telemetry section.
      </p>
    </div>
  )
}
