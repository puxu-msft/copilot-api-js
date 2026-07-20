import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import { Dialog } from "radix-ui"
import { useMemo } from "react"

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { BillingPolicyTab } from "@/components/models/detail-tabs/BillingPolicyTab"
import { CapabilitiesTab } from "@/components/models/detail-tabs/CapabilitiesTab"
import { LimitsVisionTab } from "@/components/models/detail-tabs/LimitsVisionTab"
import { OverviewTab } from "@/components/models/detail-tabs/OverviewTab"
import { RawJsonTab } from "@/components/models/detail-tabs/RawJsonTab"
import { TelemetryTab } from "@/components/models/detail-tabs/TelemetryTab"
import { HorizontalTabs } from "@/components/ui/HorizontalTabs"
import { useResizableWidth } from "@/hooks/useResizableWidth"
import {
  //
  type ModelStatus,
  statusMeta,
} from "@/lib/model-status"
import { vendorColor } from "@/lib/vendor-color"

/**
 * localStorage key for the shadcn model-detail drawer width。**与 legacy `ModelDetail` 用不同键**
 * (各自实现的抽屉 chrome,宽度偏好独立;共享 vs 独立是 UX 取舍 → 交用户)。
 */
const MODELS_DETAIL_WIDTH_KEY = "ui-v4-models-detail-width-shadcn"

/** 每 tab 内容体的共享 class(填满 + 独立滚动,同 legacy CONTENT_CLASS)。 */
const CONTENT_CLASS = "min-h-0 flex-1 overflow-auto p-3 outline-none"

/** True when focus is in a text-entry control — 避免误触 Escape 关抽屉。 */
function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable
}

interface ModelDetailShadcnProps {
  model: Model
  telemetry: JoinedModelTelemetry | null
  /** 解析后的 UI 状态(来自 ModelsShadcn 的共享 statusFor);驱动 header 状态点,镜像表格行。 */
  status?: ModelStatus
  onClose: () => void
}

/**
 * fork B · Models 详情**抽屉**(shadcn 侧,决策 8 + 决策 10)——右靠、可 resize 的 **modal 抽屉**(Radix `Dialog`)。
 *
 * **抽屉 chrome 各自实现**(round2-A2:抽屉交互模型不与整页 DetailPanel 归并,只共享 `HorizontalTabs` 布局
 * primitive)。Radix 提供 focus-trap / scroll-lock / focus-restore / `aria-modal` / portal / 遮罩。竖排
 * `ModelDetailSubRail` 6 tab → 顶部**水平** `HorizontalTabs`(`default` 变体,决策 10);6 个 tab 内容体
 * (`detail-tabs/*`,B,已中性化)**逐字复用**。选中 URL 化(`?model=<id>`,由 ModelsShadcn 拥有)——本组件是
 * 解析后 model 的纯视图。header 复用 `vendorColor`(A′→A)+ `statusMeta`(A)。中性语义 token,无 amber。
 * 本文件零设计版本标识符。
 */
export function ModelDetailShadcn({ model, telemetry, status, onClose }: ModelDetailShadcnProps) {
  const { width, min, max, dragging, dragEdgeX, handleProps } = useResizableWidth(MODELS_DETAIL_WIDTH_KEY, {
    min: 320,
    max: Math.round(window.innerWidth * 0.9),
    default: Math.round(window.innerWidth * 0.6),
    invert: true,
  })
  const caps = useMemo(() => deriveCapabilities(model), [model])
  const sm = status ? statusMeta(status) : null

  // 6 tab 声明式映射(顺序 = legacy MODEL_DETAIL_TABS);内容体逐字复用 B detail-tabs,零改动。
  const tabs = [
    { value: "Overview", label: "Overview", content: <OverviewTab model={model} /> },
    {
      value: "Capabilities",
      label: "Capabilities",
      content: (
        <CapabilitiesTab
          model={model}
          caps={caps}
        />
      ),
    },
    { value: "Limits + Vision", label: "Limits + Vision", content: <LimitsVisionTab model={model} /> },
    { value: "Billing + Policy", label: "Billing + Policy", content: <BillingPolicyTab model={model} /> },
    { value: "Telemetry", label: "Telemetry", content: <TelemetryTab telemetry={telemetry} /> },
    { value: "Raw JSON", label: "Raw JSON", content: <RawJsonTab model={model} /> },
  ]

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
            className="w-[5px] shrink-0 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-primary/40"
          />
          <aside className="mono flex min-w-0 flex-1 flex-col border-l border-border bg-card outline-none">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span
                aria-hidden="true"
                title={model.vendor || "unknown vendor"}
                className="h-2.5 w-2.5 shrink-0"
                style={{ background: vendorColor(model.vendor) }}
              />
              <Dialog.Title className="min-w-0 flex-1 truncate text-[13px] text-primary">{model.id}</Dialog.Title>
              {sm ?
                <span
                  role="img"
                  aria-label={sm.title}
                  title={sm.title}
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] uppercase tracking-wide text-foreground"
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
                className="flex h-6 w-6 shrink-0 items-center justify-center text-[16px] leading-none text-muted-foreground hover:text-foreground"
              >
                ×
              </Dialog.Close>
            </div>
            <HorizontalTabs
              tabs={tabs}
              defaultValue="Overview"
              listAriaLabel="Model detail sections"
              className="min-h-0 flex-1"
              listClassName="shrink-0 overflow-x-auto border-b border-border px-2 py-1"
              contentClassName={CONTENT_CLASS}
            />
          </aside>
          {dragging && dragEdgeX !== undefined ?
            <div
              aria-hidden="true"
              className="pointer-events-none fixed inset-y-0 left-0 z-[60] w-[2px] bg-primary"
              style={{ transform: `translateX(${dragEdgeX}px)` }}
            />
          : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
