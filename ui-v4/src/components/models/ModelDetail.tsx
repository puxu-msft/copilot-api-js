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
 * (right-docked → invert); default width is 60vw, resizable 320–90vw.
 */
export function ModelDetail({ model, telemetry, onClose }: ModelDetailProps) {
  const [tab, setTab] = useState<ModelDetailTab>(MODEL_DETAIL_TABS[0])
  const { width, min, max, dragging, dragEdgeX, handleProps } = useResizableWidth(MODELS_DETAIL_WIDTH_KEY, {
    min: 320,
    max: Math.round(window.innerWidth * 0.9),
    default: Math.round(window.innerWidth * 0.6),
    invert: true,
  })
  const caps = useMemo(() => deriveCapabilities(model), [model])

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
          className="fixed inset-0 z-40 bg-black/50"
        />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (isTyping()) e.preventDefault()
          }}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-y-0 right-0 z-50 flex outline-none"
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
              <Dialog.Title className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-primary)]">{model.id}</Dialog.Title>
              <Dialog.Close
                aria-label="Close model detail"
                className="px-1 text-[16px] leading-none text-[var(--color-muted)] hover:text-[var(--color-text)]"
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
