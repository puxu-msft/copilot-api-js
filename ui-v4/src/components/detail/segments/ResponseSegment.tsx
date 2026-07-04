import { useState } from "react"

import type {
  //
  HistoryEntry,
  SseEventRecord,
} from "@/types"

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

/** Upstream (upstream → proxy) leg body — rendered (MessageBlock) or raw (literal body / JSON). */
function UpstreamBody({ resp, raw }: { resp: NonNullable<HistoryEntry["outboundResponse"]>; raw: boolean }) {
  if (raw) {
    const body = resp.rawBody ?? (resp.content === null ? undefined : JSON.stringify(resp.content, null, 2)) ?? resp.error ?? "(no content)"
    return <RawPre>{body}</RawPre>
  }
  if (resp.content) return <MessageBlock message={resp.content} />
  return <RawPre>{resp.rawBody ?? resp.error ?? "(no content)"}</RawPre>
}

/** Forwarded (proxy → client) leg body — rendered (reconstructed content) or raw (SSE frames / JSON). */
function ForwardedBody({ entry, raw }: { entry: HistoryEntry; raw: boolean }) {
  const frames = entry.inboundResponse?.sseEvents ?? []
  const content = entry.inboundResponse?.content
  if (content !== undefined) {
    if (raw) return <RawPre>{JSON.stringify(content, null, 2)}</RawPre>
    if (isMessageShaped(content)) return <MessageBlock message={content} />
    return <RawPre>{JSON.stringify(content, null, 2)}</RawPre>
  }
  if (raw) return <RawPre>{frames.map((f) => f.raw).join("\n")}</RawPre>
  return (
    <ForwardedStream
      frames={frames}
      endpoint={entry.endpoint}
    />
  )
}

/** Rendered/Raw view toggle (mirrors StagesSegment). */
function ViewToggle({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] ${raw ? "" : "text-[var(--color-primary)]"}`}
      >
        Rendered
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] ${raw ? "text-[var(--color-primary)]" : ""}`}
      >
        Raw
      </button>
    </div>
  )
}

/**
 * Response view organized by proxy leg, with a Rendered/Raw toggle:
 *   1. Outcome — the request verdict (surfaced from failureReason) for non-success terminals.
 *   2. Upstream (upstream → proxy) — the upstream-original answer (HONEST leg outcome: after the
 *      data-model fix a proxy-introduced failure no longer marks this leg failed).
 *   3. Forwarded (proxy → client) — what the client actually received: the reconstructed content
 *      (streaming) / rewritten body (non-streaming), incl. any synthesized error frame.
 * Rendered = semantic (MessageBlock); Raw = the literal body / SSE frames. The SSE tab carries the
 * upstream-vs-forwarded frame diff.
 */
export function ResponseSegment({ entry }: { entry: HistoryEntry }) {
  const [raw, setRaw] = useState(false)
  const hasUpstream = Boolean(entry.outboundResponse)
  const forwardedFrames = entry.inboundResponse?.sseEvents ?? []
  const hasForwarded = entry.inboundResponse?.content !== undefined || forwardedFrames.length > 0

  const signal = statusSignal(entry.state ?? "")
  const verdict = entry.failureReason ?? entry.outboundResponse?.error
  // Show the outcome banner for non-success terminal states carrying a verdict — surfaces the
  // proxy failure reason that would otherwise be buried in / absent from the leg sections.
  const showOutcome = signal === "fail" && verdict !== undefined

  if (!hasUpstream && !hasForwarded && !showOutcome) return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无响应数据</div>

  return (
    <div>
      {hasUpstream || hasForwarded ?
        <ViewToggle
          raw={raw}
          onChange={setRaw}
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
      {entry.outboundResponse ?
        <LegShell label="Upstream (upstream → proxy)">
          <div className="mono mb-1 text-[13px] text-[#888]">
            status {entry.outboundResponse.status ?? "—"} · {entry.outboundResponse.model} · {entry.outboundResponse.success ? "ok" : "fail"}
          </div>
          <UpstreamBody
            resp={entry.outboundResponse}
            raw={raw}
          />
        </LegShell>
      : null}
      {hasForwarded ?
        <LegShell label="Forwarded (proxy → client)">
          <ForwardedBody
            entry={entry}
            raw={raw}
          />
        </LegShell>
      : null}
    </div>
  )
}
