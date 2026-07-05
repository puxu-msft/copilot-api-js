import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  useEffect,
  useMemo,
  useRef,
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

/** localStorage key for the model-detail panel width (distinct from the TOC sidebar's). */
const MODELS_DETAIL_WIDTH_KEY = "ui-v4-models-detail-width"

/** True when focus is in a text-entry control — so a stray Escape there doesn't close the panel. */
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
 * Right-docked, user-resizable detail panel for one model (P3).
 *
 * Selection is URL-borne (`?model=<id>`, owned by ModelsPage) — this panel is a
 * pure view over the resolved model. Six vertical tabs (spec §3/§6) surface every
 * field. Escape closes (unless typing); on open focus moves into the panel and is
 * restored to the previously-focused element on close. The drag handle sits on the
 * panel's LEFT edge (right-docked → invert), reusing the shared deferred-apply
 * resizer (preview line during drag, single reflow on release).
 */
export function ModelDetail({ model, telemetry, onClose }: ModelDetailProps) {
  const [tab, setTab] = useState<ModelDetailTab>(MODEL_DETAIL_TABS[0])
  const { width, dragging, dragEdgeX, handleProps } = useResizableWidth(MODELS_DETAIL_WIDTH_KEY, { min: 320, max: 760, default: 460, invert: true })
  const caps = useMemo(() => deriveCapabilities(model), [model])

  const panelRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Move focus into the panel on open; restore to the trigger on close. Escape
  // closes (read the latest onClose via ref so the listener stays stable).
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isTyping()) onCloseRef.current()
    }
    globalThis.addEventListener("keydown", onKey)
    return () => {
      globalThis.removeEventListener("keydown", onKey)
      prevFocus?.focus()
    }
  }, [])

  const body = (() => {
    switch (tab) {
      case "Overview": {
        return <OverviewTab model={model} />
      }
      case "Capabilities": {
        return (
          <CapabilitiesTab
            model={model}
            caps={caps}
          />
        )
      }
      case "Limits + Vision": {
        return <LimitsVisionTab model={model} />
      }
      case "Billing + Policy": {
        return <BillingPolicyTab model={model} />
      }
      case "Telemetry": {
        return <TelemetryTab telemetry={telemetry} />
      }
      case "Raw JSON": {
        return <RawJsonTab model={model} />
      }
      default: {
        return null
      }
    }
  })()

  return (
    <div
      className="flex shrink-0"
      style={{ width }}
    >
      <div
        {...handleProps}
        role="separator"
        aria-label="Resize model detail"
        aria-orientation="vertical"
        title="Drag to resize"
        className="w-[5px] shrink-0 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-[var(--color-primary)]/40"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="region"
        aria-label={`Model detail: ${model.id}`}
        className="mono flex min-w-0 flex-1 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] outline-none"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-primary)]">{model.id}</div>
          <button
            type="button"
            aria-label="Close model detail"
            onClick={onClose}
            className="px-1 text-[16px] leading-none text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ModelDetailSubRail
            active={tab}
            onSelect={setTab}
          />
          <div
            role="tabpanel"
            aria-label={tab}
            className="min-h-0 flex-1 overflow-auto p-3"
          >
            {body}
          </div>
        </div>
      </aside>
      {dragging && dragEdgeX !== undefined ?
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-y-0 left-0 z-50 w-[2px] bg-[var(--color-primary)]"
          style={{ transform: `translateX(${dragEdgeX}px)` }}
        />
      : null}
    </div>
  )
}
