import {
  //
  finalUpstreamResponse,
  resolveResponseError,
} from "~backend/lib/history/entry-view"
import { useState } from "react"

import type {
  //
  HistoryEntry,
  SseEventRecord,
} from "@/types"

import { RawJsonView } from "@/components/common/RawJsonView"
import { MessageBlock } from "@/components/detail/MessageBlock"
import { LegShell } from "@/components/detail/segments/LegShell"
import { accumulateForwardedContent } from "@/lib/content/accumulate-forwarded"
import {
  //
  statusSignal,
  type Signal,
} from "@/lib/format"

const SIGNAL_COLOR: Record<Signal, string> = {
  ok: "var(--color-ok)",
  fail: "var(--color-fail)",
  warn: "var(--color-warn)",
  live: "var(--color-ok)",
  muted: "var(--color-muted)",
}

/**
 * A forwarded SSE frame is a proxy→client TERMINAL ERROR frame when its parsed type is `"error"`
 * (Anthropic / Chat-Completions / Responses synthesized error frames) OR — for Gemini, whose frames
 * carry no discriminating `type` (the sink labels them `"generateContent"`) — when its raw JSON has a
 * structured `error.code`. A bare substring test on `raw` would false-positive on ordinary content
 * frames that merely mention `"error"`, so we parse structurally.
 */
function isTerminalErrorFrame(f: SseEventRecord): boolean {
  if (f.type === "error") return true
  try {
    const parsed = JSON.parse(f.raw) as { error?: { code?: unknown } }
    return typeof parsed.error?.code === "number"
  } catch {
    return false
  }
}

/** Best-effort human message out of a terminal error frame's raw JSON (falls back to the raw string). */
function errorFrameMessage(f: SseEventRecord): string {
  try {
    const parsed = JSON.parse(f.raw) as { error?: { message?: unknown; type?: unknown } }
    const msg = parsed.error?.message
    const type = parsed.error?.type
    if (typeof msg === "string") return typeof type === "string" ? `${type}: ${msg}` : msg
  } catch {
    // fall through to raw
  }
  return f.raw
}

/** Monospace pre block for raw text/JSON. */
function RawPre({ children }: { children: string }) {
  return <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">{children}</pre>
}

/** The rewritten content actually forwarded to the client on a streaming response. */
function ForwardedStream({ frames, endpoint }: { frames: Array<SseEventRecord>; endpoint: HistoryEntry["endpoint"] }) {
  const errorFrames = frames.filter((f) => isTerminalErrorFrame(f))
  const message = accumulateForwardedContent(frames, endpoint)
  return (
    <div>
      {message ?
        <MessageBlock message={message} />
      : null}
      {errorFrames.length > 0 ?
        errorFrames.map((f, i) => (
          <pre
            key={i}
            className="mono mt-1 whitespace-pre-wrap break-all text-[13px]"
            style={{ color: "var(--color-fail)" }}
          >
            {errorFrameMessage(f)}
          </pre>
        ))
      : null}
      {message || errorFrames.length > 0 ? null : (
        <div className="mono text-[13px] text-[var(--color-muted)]">{frames.length} frames forwarded · 完整原始帧见 SSE 标签页</div>
      )}
    </div>
  )
}

/** Does this forwarded non-streaming content look like a renderable message (has a role)? */
function isMessageShaped(content: unknown): content is Parameters<typeof MessageBlock>[0]["message"] {
  return typeof content === "object" && content !== null && typeof (content as { role?: unknown }).role === "string"
}

/** Upstream (upstream → proxy) response body content shape (`upstreamResponse.body`). */
type UpstreamContent = NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamResponse"]>["body"] | undefined

/** Upstream (upstream → proxy) leg body — rendered (MessageBlock) or code (message object as JSON). */
function UpstreamBody({ content, rawBody, error, code }: { content: UpstreamContent; rawBody?: string; error?: string; code: boolean }) {
  const fallback = rawBody ?? error ?? "(no content)"
  if (code) {
    // Structured upstream body → dual view; the string fallback (rawBody / error) stays plain <pre>.
    if (content === null || content === undefined) return <RawPre>{fallback}</RawPre>
    return <RawJsonView value={content} />
  }
  if (content) return <MessageBlock message={content} />
  return <RawPre>{fallback}</RawPre>
}

/** Forwarded (proxy → client) leg body — rendered (reconstructed content) or code (message object as JSON). */
function ForwardedBody({ entry, code }: { entry: HistoryEntry; code: boolean }) {
  // New leg `clientResponse` (legacy `inboundResponse` removed in P4c).
  const frames = entry.clientResponse?.sseEvents ?? []
  const content = entry.clientResponse?.body
  if (content !== undefined) {
    if (code) return <RawJsonView value={content} />
    if (isMessageShaped(content)) return <MessageBlock message={content} />
    return <RawJsonView value={content} />
  }
  // Streaming: reconstruct the client message from the forwarded frames.
  const message = accumulateForwardedContent(frames, entry.endpoint)
  if (code) {
    // The reconstructed message object (structured) → dual view; fall back to the raw frame
    // payloads (non-JSON SSE text) as plain <pre> when nothing reconstructs (e.g. a stream of
    // only pings + a terminal error frame).
    return message ? <RawJsonView value={message} /> : <RawPre>{frames.map((f) => f.raw).join("\n")}</RawPre>
  }
  return (
    <ForwardedStream
      frames={frames}
      endpoint={entry.endpoint}
    />
  )
}

/** Rendered/Code view toggle (mirrors StagesSegment). */
function ViewToggle({ code, onChange }: { code: boolean; onChange: (code: boolean) => void }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] ${code ? "" : "text-[var(--color-primary)]"}`}
      >
        Rendered
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] ${code ? "text-[var(--color-primary)]" : ""}`}
      >
        Code
      </button>
    </div>
  )
}

/**
 * Response view organized by proxy leg, with a Rendered/Code toggle:
 *   1. Outcome — the request verdict (surfaced from failureReason) for non-success terminals.
 *   2. Upstream (upstream → proxy) — the upstream-original answer (HONEST leg outcome: after the
 *      data-model fix a proxy-introduced failure no longer marks this leg failed).
 *   3. Forwarded (proxy → client) — what the client actually received: the reconstructed content
 *      (streaming) / rewritten body (non-streaming), incl. any synthesized error frame.
 * Rendered = semantic (MessageBlock); Code = the message object as pretty JSON. The SSE tab carries
 * the raw upstream-vs-forwarded frame diff.
 */
export function ResponseSegment({ entry }: { entry: HistoryEntry }) {
  const [code, setCode] = useState(false)
  // New per-attempt `upstreamResponse` (final attempt) — legacy top-level `outboundResponse` removed in P4c.
  const upstream = finalUpstreamResponse(entry)
  const upstreamModel = upstream?.model
  const upstreamStatus = upstream?.status
  const upstreamSuccess = upstream?.success
  const upstreamContent = upstream?.body
  const upstreamRawBody = upstream?.rawBody
  // Response-side error home: final attempt's `error`.
  const upstreamError = resolveResponseError(entry)
  const hasUpstream = Boolean(upstream)
  const forwardedFrames = entry.clientResponse?.sseEvents ?? []
  const hasForwarded = entry.clientResponse?.body !== undefined || forwardedFrames.length > 0

  const signal = statusSignal(entry.state ?? "")
  const verdict = entry._index?.derived?.failureReason ?? upstreamError
  // Show the outcome banner for non-success terminal states carrying a verdict — surfaces the
  // proxy failure reason that would otherwise be buried in / absent from the leg sections.
  const showOutcome = signal === "fail" && verdict !== undefined

  if (!hasUpstream && !hasForwarded && !showOutcome) return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无响应数据</div>

  return (
    <div>
      {hasUpstream || hasForwarded ?
        <ViewToggle
          code={code}
          onChange={setCode}
        />
      : null}
      {showOutcome ?
        <LegShell label="Outcome (request verdict)">
          <div className="mono flex items-center gap-2 text-[13px]">
            <span
              className="uppercase tracking-wider"
              style={{ color: SIGNAL_COLOR[signal] }}
            >
              {entry.state}
            </span>
          </div>
          <pre
            className="mono mt-1 whitespace-pre-wrap break-all text-[13px]"
            style={{ color: "var(--color-fail)" }}
          >
            {verdict}
          </pre>
        </LegShell>
      : null}
      {hasUpstream ?
        <LegShell label="Upstream (upstream → proxy)">
          <div className="mono mb-1 text-[13px] text-[#888]">
            status {upstreamStatus ?? "—"} · {upstreamModel} · {upstreamSuccess ? "ok" : "fail"}
          </div>
          <UpstreamBody
            content={upstreamContent}
            rawBody={upstreamRawBody}
            error={upstreamError}
            code={code}
          />
        </LegShell>
      : null}
      {hasForwarded ?
        <LegShell label="Forwarded (proxy → client)">
          <ForwardedBody
            entry={entry}
            code={code}
          />
        </LegShell>
      : null}
    </div>
  )
}
