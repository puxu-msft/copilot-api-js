import type { Model } from "~backend/lib/models/client"

import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { ModelDetail } from "@/components/models/ModelDetail"

const VISION_MODEL = {
  id: "claude-opus-4.8",
  name: "Opus",
  vendor: "Anthropic",
  version: "4.8",
  object: "model",
  model_picker_enabled: true,
  is_chat_default: true,
  is_chat_fallback: false,
  preview: false,
  model_picker_category: "versatile",
  supported_endpoints: ["/v1/messages"],
  request_headers: { "x-custom-header": "sentinel-value" },
  capabilities: {
    family: "claude",
    tokenizer: "o200k",
    type: "chat",
    object: "model_capabilities",
    supports: { vision: true, tool_calls: true, max_thinking_budget: 8000, reasoning_effort: ["low", "high"], custom_future_flag: true },
    limits: {
      max_context_window_tokens: 200_000,
      max_output_tokens: 64_000,
      max_prompt_tokens: 190_000,
      vision: { max_prompt_images: 5, max_prompt_image_size: 3_145_728, supported_media_types: ["image/png", "image/jpeg"] },
    },
  },
  billing: { multiplier: 3, is_premium: true, restricted_to: ["pro", "max"] },
  policy: { state: "enabled", terms: "https://example.test/terms" },
} as unknown as Model

/** Legacy model with no vision limits + no supported_endpoints (endpoints inferred). */
const NO_VISION_MODEL = {
  id: "gpt-5.5",
  name: "GPT",
  vendor: "OpenAI",
  version: "5.5",
  object: "model",
  model_picker_enabled: true,
  is_chat_default: false,
  is_chat_fallback: false,
  preview: false,
  capabilities: { type: "chat", supports: {}, limits: { max_context_window_tokens: 400_000 } },
  billing: { multiplier: 1 },
} as unknown as Model

const TELEMETRY: JoinedModelTelemetry = {
  last7d: {
    model: "claude-opus-4.8",
    requestCount: 42,
    successCount: 40,
    failureCount: 2,
    totalDurationMs: 84_000,
    averageDurationMs: 2000,
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 300, cacheCreationInputTokens: 100, reasoningTokens: 77 },
  },
  sinceStart: {
    model: "claude-opus-4.8",
    requestCount: 100,
    successCount: 95,
    failureCount: 5,
    totalDurationMs: 200_000,
    averageDurationMs: 2000,
    usage: { inputTokens: 5000, outputTokens: 2500, totalTokens: 7500, cacheReadInputTokens: 900, cacheCreationInputTokens: 200, reasoningTokens: 333 },
  },
}

/** Text content of the active tab panel (tab bodies split text across many spans). */
function panelText(): string {
  return screen.getByRole("tabpanel").textContent
}

function selectTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }))
}

describe("ModelDetail", () => {
  it("shows Overview by default with identity + inferred-endpoint tagging", () => {
    render(
      <ModelDetail
        model={NO_VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    const text = panelText()
    expect(text).toContain("gpt-5.5")
    expect(text).toContain("OpenAI")
    // No supported_endpoints → inferred from capabilities.type.
    expect(text).toContain("inferred")
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true")
  })

  it("Capabilities tab shows the derived matrix AND the full raw supports map (not just the subset)", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    selectTab("Capabilities")
    const text = panelText()
    // Full raw supports map is rendered — an arbitrary future flag survives.
    expect(text).toContain("custom_future_flag")
    // Numeric/array supports surfaced.
    expect(text).toContain("max_thinking_budget")
    expect(text).toContain("reasoning_effort")
  })

  it("Limits + Vision tab renders the Vision block only when limits.vision exists", () => {
    const { rerender } = render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    selectTab("Limits + Vision")
    expect(panelText()).toContain("supported_media_types")
    expect(panelText()).toContain("image/png")

    // A model without limits.vision must NOT render the Vision section.
    rerender(
      <ModelDetail
        model={NO_VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    selectTab("Limits + Vision")
    expect(panelText()).not.toContain("supported_media_types")
    expect(panelText()).toContain("max_context_window_tokens")
  })

  it("Billing + Policy tab shows multiplier, plan chips, and policy state", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    selectTab("Billing + Policy")
    const text = panelText()
    expect(text).toContain("pro")
    expect(text).toContain("max")
    expect(text).toContain("enabled")
  })

  it("Telemetry tab shows both windows with the full 6-token breakdown", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={TELEMETRY}
        onClose={() => {}}
      />,
    )
    selectTab("Telemetry")
    const text = panelText()
    expect(text).toContain("Last 7 days")
    expect(text).toContain("Since start")
    expect(text).toContain("reasoning tokens")
    expect(text).toContain("77") // last7d reasoning tokens
    expect(text).toContain("Unmatched telemetry") // honest failure-count note
  })

  it("Telemetry tab shows a no-traffic note when nothing joined", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    selectTab("Telemetry")
    expect(panelText()).toContain("no runtime telemetry")
  })

  it("Raw JSON tab includes request_headers (no longer stripped)", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    selectTab("Raw JSON")
    const text = panelText()
    expect(text).toContain("request_headers")
    expect(text).toContain("sentinel-value")
  })

  it("closes on Escape", () => {
    const onClose = vi.fn()
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={onClose}
      />,
    )
    fireEvent.keyDown(globalThis.window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does NOT close on Escape while a text control is focused (isTyping guard)", () => {
    const onClose = vi.fn()
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={onClose}
      />,
    )
    const input = document.createElement("input")
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(globalThis.window, { key: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
    input.remove()
    // With focus back outside a text control, Escape closes again.
    fireEvent.keyDown(globalThis.window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("moves focus into the panel on open", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    expect(document.activeElement).toBe(screen.getByRole("region", { name: /Model detail/i }))
  })

  it("uses the WAI-ARIA tabs pattern: roving tabindex + arrow-key navigation", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    const overview = screen.getByRole("tab", { name: "Overview" })
    const capabilities = screen.getByRole("tab", { name: "Capabilities" })
    const rawJson = screen.getByRole("tab", { name: "Raw JSON" })
    const tablist = screen.getByRole("tablist")
    // Only the active tab is Tab-focusable (roving tabindex).
    expect(overview.getAttribute("tabindex")).toBe("0")
    expect(capabilities.getAttribute("tabindex")).toBe("-1")
    // ArrowDown on the tablist activates + focuses the next tab.
    fireEvent.keyDown(tablist, { key: "ArrowDown" })
    expect(capabilities.getAttribute("aria-selected")).toBe("true")
    expect(capabilities.getAttribute("tabindex")).toBe("0")
    expect(document.activeElement).toBe(capabilities)
    // The panel is associated back to the active tab.
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(capabilities.getAttribute("id"))
    // ArrowUp from the first tab wraps to the last; Home/End jump to ends.
    fireEvent.keyDown(tablist, { key: "ArrowUp" }) // Capabilities → Overview
    fireEvent.keyDown(tablist, { key: "ArrowUp" }) // Overview → wrap to Raw JSON
    expect(rawJson.getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(tablist, { key: "Home" })
    expect(overview.getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(tablist, { key: "End" })
    expect(rawJson.getAttribute("aria-selected")).toBe("true")
  })

  it("does NOT hijack Left/Right on the vertical tablist (APG orientation)", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    const overview = screen.getByRole("tab", { name: "Overview" })
    expect(overview.getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" })
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" })
    // Horizontal arrows are not owned by a vertical tablist — active tab unchanged.
    expect(overview.getAttribute("aria-selected")).toBe("true")
  })
})
