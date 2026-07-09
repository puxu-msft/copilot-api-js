import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  Dialog,
  Tabs,
} from "radix-ui"
import {
  //
  useMemo,
  useState,
} from "react"

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { BillingPolicyTab } from "@/components/models/detail-tabs/BillingPolicyTab"
import { CapabilitiesTab } from "@/components/models/detail-tabs/CapabilitiesTab"
import { LimitsVisionTab } from "@/components/models/detail-tabs/LimitsVisionTab"
import { OverviewTab } from "@/components/models/detail-tabs/OverviewTab"
import { RawJsonTab } from "@/components/models/detail-tabs/RawJsonTab"
import { TelemetryTab } from "@/components/models/detail-tabs/TelemetryTab"
import {
  //
  MODEL_DETAIL_TABS,
  ModelDetailSubRail,
  type ModelDetailTab,
} from "@/components/models/ModelDetailSubRail"
import { useResizableWidth } from "@/hooks/useResizableWidth"
import {
  //
  type ModelStatus,
  statusMeta,
} from "@/lib/model-status"
import { vendorColor } from "@/lib/vendor-color"

/** localStorage key for the model-detail drawer width (distinct from the TOC sidebar's). */
const MODELS_DETAIL_WIDTH_KEY = "ui-v4-models-detail-width"

/** Shared class for each tab's content pane. */
const CONTENT_CLASS = "min-h-0 flex-1 overflow-auto p-3 outline-none"

/** True when focus is in a text-entry control — so a stray Escape there doesn't close the drawer. */
function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable
}

interface ModelDetailProps {
  model: Model
  telemetry: JoinedModelTelemetry | null
  /** Resolved UI status (from ModelsPage's shared `statusFor`); drives the header
   *  dot so the drawer mirrors the table. Optional — header dot is simply omitted
   *  when absent (keeps the component testable in isolation). */
  status?: ModelStatus
  onClose: () => void
}

/**
 * Right-docked, user-resizable **modal drawer** for one model (Radix `Dialog`).
 *
 * Selection is URL-borne (`?model=<id>`, owned by ModelsPage) — this is a pure
 * view over the resolved model. Radix provides focus-trap, scroll-lock,
 * focus-restore-on-close, `aria-modal`, portal, and the dimming overlay
 * (click-to-close). Escape closes unless typing (`onEscapeKeyDown` + isTyping
 * guard, so an in-drawer text control keeps its Escape). Six vertical tabs
 * surface every field. The drag handle sits on the drawer's LEFT edge
 * (right-docked → invert); default width is 60vw, resizable 320–90vw. Opens with
 * a right-edge slide-in + overlay fade (Radix `data-state=open`; close unmounts,
 * so entry-only). The header carries a vendor-colored square + the status dot,
 * echoing the table row.
 */
export function ModelDetail({ model, telemetry, status, onClose }: ModelDetailProps) {
  const [tab, setTab] = useState<ModelDetailTab>(MODEL_DETAIL_TABS[0])
  const { width, min, max, dragging, dragEdgeX, handleProps } = useResizableWidth(MODELS_DETAIL_WIDTH_KEY, {
    min: 320,
    max: Math.round(window.innerWidth * 0.9),
    default: Math.round(window.innerWidth * 0.6),
    invert: true,
  })
  const caps = useMemo(() => deriveCapabilities(model), [model])
  const sm = status ? statusMeta(status) : null

  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/50 data-[state=open]:animate-[drawer-overlay-in_180ms_ease-out]"
        />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (isTyping()) e.preventDefault()
          }}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-y-0 right-0 z-50 flex outline-none data-[state=open]:animate-[drawer-slide-in_200ms_cubic-bezier(0.32,0.72,0,1)]"
          style={{ width }}
        >
          <div
            {...handleProps}
            role="separator"
            aria-label="Resize model detail"
            aria-orientation="vertical"
            aria-valuenow={Math.round(width)}
            aria-valuemin={min}
            aria-valuemax={max}
            title="Drag to resize"
            className="w-[5px] shrink-0 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-[var(--color-primary)]/40"
          />
          <aside className="mono flex min-w-0 flex-1 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] outline-none">
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
              <span
                aria-hidden="true"
                title={model.vendor || "unknown vendor"}
                className="h-2.5 w-2.5 shrink-0"
                style={{ background: vendorColor(model.vendor) }}
              />
              <Dialog.Title className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-primary)]">{model.id}</Dialog.Title>
              {sm ?
                <span
                  role="img"
                  aria-label={sm.title}
                  title={sm.title}
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] uppercase tracking-wide text-[var(--color-text)]"
                >
                  <span
                    aria-hidden="true"
                    style={{ color: sm.colorVar }}
                  >
                    {sm.glyph}
                  </span>
                  {sm.label}
                </span>
              : null}
              <Dialog.Close
                aria-label="Close model detail"
                className="flex h-6 w-6 shrink-0 items-center justify-center text-[16px] leading-none text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                ×
              </Dialog.Close>
            </div>
            <Tabs.Root
              value={tab}
              onValueChange={(v) => setTab(v as ModelDetailTab)}
              orientation="vertical"
              className="flex min-h-0 flex-1"
            >
              <ModelDetailSubRail />
              <Tabs.Content
                value="Overview"
                className={CONTENT_CLASS}
              >
                <OverviewTab model={model} />
              </Tabs.Content>
              <Tabs.Content
                value="Capabilities"
                className={CONTENT_CLASS}
              >
                <CapabilitiesTab
                  model={model}
                  caps={caps}
                />
              </Tabs.Content>
              <Tabs.Content
                value="Limits + Vision"
                className={CONTENT_CLASS}
              >
                <LimitsVisionTab model={model} />
              </Tabs.Content>
              <Tabs.Content
                value="Billing + Policy"
                className={CONTENT_CLASS}
              >
                <BillingPolicyTab model={model} />
              </Tabs.Content>
              <Tabs.Content
                value="Telemetry"
                className={CONTENT_CLASS}
              >
                <TelemetryTab telemetry={telemetry} />
              </Tabs.Content>
              <Tabs.Content
                value="Raw JSON"
                className={CONTENT_CLASS}
              >
                <RawJsonTab model={model} />
              </Tabs.Content>
            </Tabs.Root>
          </aside>
          {dragging && dragEdgeX !== undefined ?
            <div
              aria-hidden="true"
              className="pointer-events-none fixed inset-y-0 left-0 z-[60] w-[2px] bg-[var(--color-primary)]"
              style={{ transform: `translateX(${dragEdgeX}px)` }}
            />
          : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
