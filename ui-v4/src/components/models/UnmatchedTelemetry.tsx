import type { UnmatchedTelemetryRow } from "@/lib/model-telemetry"

/**
 * "Unmatched telemetry": runtime telemetry rows whose normalized model key
 * matches NO catalog id (spec §4.2). These are mostly pure-alias FAILING
 * requests — a request that failed before an upstream response leg keys on the
 * client's verbatim alias (`opus`, a date suffix, an override name) which never
 * gets backfilled to a canonical id, plus traffic to models since delisted.
 *
 * richest-data-flow: they are surfaced here rather than silently dropped, so an
 * operator sees "there is traffic but the catalog has no such id". Rendered only
 * when non-empty.
 */
export function UnmatchedTelemetry({ rows }: { rows: Array<UnmatchedTelemetryRow> }) {
  if (rows.length === 0) return null

  return (
    <section
      aria-label="Unmatched telemetry"
      className="mono border-t border-[var(--color-border)] px-2 py-2 text-[12px]"
    >
      <div className="mb-1 text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Unmatched telemetry · {rows.length}</div>
      <p className="mb-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
        Runtime telemetry with no catalog model — mostly pure-alias failing requests (keyed on the client alias, no canonical id) or delisted models. Shown so
        it is not silently dropped.
      </p>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
            <th
              scope="col"
              className="px-2 py-1 text-left"
            >
              Telemetry key
            </th>
            <th
              scope="col"
              className="px-2 py-1 text-right"
            >
              Req 7d
            </th>
            <th
              scope="col"
              className="px-2 py-1 text-right"
            >
              Fail 7d
            </th>
            <th
              scope="col"
              className="px-2 py-1 text-right"
            >
              Req total
            </th>
            <th
              scope="col"
              className="px-2 py-1 text-right"
            >
              Fail total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.normalizedKey}
              className="border-t border-[#1e1e24]"
            >
              <td className="px-2 py-1 text-[#cdb]">
                {row.model}
                {row.model === row.normalizedKey ? null : <span className="ml-1 text-[10px] text-[var(--color-muted)]">→ {row.normalizedKey}</span>}
              </td>
              <td className="px-2 py-1 text-right text-[#cdb]">{row.last7d?.requestCount ?? 0}</td>
              <td className="px-2 py-1 text-right">
                <span className={row.last7d?.failureCount ? "text-[var(--color-fail)]" : "text-[#555]"}>{row.last7d?.failureCount ?? 0}</span>
              </td>
              <td className="px-2 py-1 text-right text-[#cdb]">{row.sinceStart?.requestCount ?? 0}</td>
              <td className="px-2 py-1 text-right">
                <span className={row.sinceStart?.failureCount ? "text-[var(--color-fail)]" : "text-[#555]"}>{row.sinceStart?.failureCount ?? 0}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
