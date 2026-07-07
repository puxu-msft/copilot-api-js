import {
  //
  computed,
  watch,
  type ComputedRef,
  type Ref,
} from "vue"

import type { HistoryEntry } from "@/types"

import {
  //
  hasEffectiveLeg,
  resolveEffectiveMessages,
  resolveEffectiveSystem,
  resolveForwardedContent,
  resolveForwardedSse,
  resolveUpstreamResponse,
  resolveUpstreamSse,
  resolveWirePayload,
} from "./entry-legs"

const isPresent = (v: unknown): boolean => v !== undefined && v !== null

/** Whether the effective (sanitized/rewritten) request differs from the inbound one. */
function effectiveDiffers(e: HistoryEntry): boolean {
  if (!hasEffectiveLeg(e)) return false
  if (JSON.stringify(e.inboundRequest.messages ?? []) !== JSON.stringify(resolveEffectiveMessages(e) ?? [])) return true
  return JSON.stringify(e.inboundRequest.system ?? null) !== JSON.stringify(resolveEffectiveSystem(e) ?? null)
}

export interface DetailStage {
  key: string
  label: string
  icon: string
  /** Whether this stage has any data for the current entry. */
  present: boolean
  /**
   * Top-level TocTree node ids that belong to this stage (used to scope the
   * outline to the active stage). Empty = no message-level outline.
   */
  tocIds: Array<string>
}

/**
 * Pipeline stages as the first-level filter for the detail page (in order):
 * Request (inbound+effective) → Wire (proxy→upstream) → Upstream response →
 * Forwarded (proxy→client), plus cross-cutting Attempts + Meta. Single source
 * for which stages exist + their TocTree node mapping.
 */
export function useDetailStages(
  entry: Ref<HistoryEntry | null> | ComputedRef<HistoryEntry | null>,
  activeStage: Ref<string>,
  opts?: { manageActiveStage?: boolean },
) {
  const stages = computed<Array<DetailStage>>(() => {
    const e = entry.value
    if (!e) return []
    const all: Array<DetailStage> = [
      // tocIds order = outline order; HTTP headers listed first (headers-before-messages).
      // Request is split into Inbound (client→proxy) + Effective (post-sanitize/rewrite),
      // the latter only when it actually differs (else it's identical to inbound).
      { key: "inbound", label: "Inbound", icon: "mdi-arrow-up-bold", present: true, tocIds: ["httpHeaders", "request"] },
      { key: "effective", label: "Effective", icon: "mdi-pencil-outline", present: effectiveDiffers(e), tocIds: ["request"] },
      { key: "wire", label: "Wire", icon: "mdi-transit-connection-variant", present: isPresent(resolveWirePayload(e)), tocIds: ["httpHeaders"] },
      {
        key: "upstream",
        label: "Upstream",
        icon: "mdi-arrow-down-bold",
        present: Boolean(resolveUpstreamResponse(e)?.content || resolveUpstreamResponse(e)?.error || resolveUpstreamSse(e)?.length),
        tocIds: ["httpHeaders", "response", "section-sse-events"],
      },
      {
        key: "forwarded",
        label: "Forwarded",
        icon: "mdi-send-outline",
        present: Boolean(isPresent(resolveForwardedContent(e)) || resolveForwardedSse(e)?.length),
        // No message-level toc node for forwarded content (raw JSON / frames).
        tocIds: [],
      },
      { key: "attempts", label: "Attempts", icon: "mdi-history", present: Boolean(e.attempts && e.attempts.length > 1), tocIds: ["attempts"] },
      { key: "meta", label: "Meta", icon: "mdi-information-outline", present: true, tocIds: ["meta"] },
    ]
    return all.filter((s) => s.present)
  })

  // Keep activeStage valid as entries change (fall back to the first present
  // stage). Only ONE owner should register this (the component that owns the
  // StageTabs writer) — read-only consumers pass manageActiveStage:false to
  // avoid a redundant duplicate watcher writing the same shared store field.
  if (opts?.manageActiveStage) {
    watch(
      stages,
      (list) => {
        if (list.length > 0 && !list.some((s) => s.key === activeStage.value)) {
          activeStage.value = list[0].key
        }
      },
      { immediate: true },
    )
  }

  const activeTocIds = computed(() => stages.value.find((s) => s.key === activeStage.value)?.tocIds ?? [])

  return { stages, activeTocIds }
}
