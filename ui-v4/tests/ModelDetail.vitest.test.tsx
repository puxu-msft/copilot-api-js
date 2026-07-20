import type { Model } from "~backend/lib/models/client"

import {
  //
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

/**
 * Text content of the active OUTER tab panel. The Capabilities + Raw JSON tabs now
 * embed a shared `RawJsonView`, which mounts its own nested `role="tabpanel"`; the
 * outer Radix panel is always first in document order, and its `textContent`
 * transitively includes the nested view's text.
 */
function panelText(): string {
  return screen.getAllByRole("tabpanel")[0].textContent
}

/** Radix Tabs activate on a real pointer/focus sequence — use userEvent, not fireEvent.click. */
async function selectTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("tab", { name }))
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

  it("Capabilities tab shows the derived matrix AND the full raw supports map (not just the subset)", async () => {
    const user = userEvent.setup()
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    await selectTab(user, "Capabilities")
    const text = panelText()
    // Full raw supports map is rendered — an arbitrary future flag survives.
    expect(text).toContain("custom_future_flag")
    // Numeric/array supports surfaced.
    expect(text).toContain("max_thinking_budget")
    expect(text).toContain("reasoning_effort")

    // The raw supports map is the shared dual view: default source, switchable to tree.
    const treeTab = screen.getByRole("tab", { name: "树" })
    expect(screen.getByRole("tab", { name: "原文" }).getAttribute("aria-selected")).toBe("true")
    await user.click(treeTab)
    expect(treeTab.getAttribute("aria-selected")).toBe("true")
    expect(panelText()).toContain("custom_future_flag")
  })

  it("Limits + Vision tab renders the Vision block only when limits.vision exists", async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    await selectTab(user, "Limits + Vision")
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
    await selectTab(user, "Limits + Vision")
    expect(panelText()).not.toContain("supported_media_types")
    expect(panelText()).toContain("max_context_window_tokens")
  })

  it("Billing + Policy tab shows multiplier, plan chips, and policy state", async () => {
    const user = userEvent.setup()
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    await selectTab(user, "Billing + Policy")
    const text = panelText()
    expect(text).toContain("pro")
    expect(text).toContain("max")
    expect(text).toContain("enabled")
  })

  it("Telemetry tab shows both windows with the full 6-token breakdown", async () => {
    const user = userEvent.setup()
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={TELEMETRY}
        onClose={() => {}}
      />,
    )
    await selectTab(user, "Telemetry")
    const text = panelText()
    expect(text).toContain("Last 7 days")
    expect(text).toContain("Since start")
    expect(text).toContain("reasoning tokens")
    expect(text).toContain("77") // last7d reasoning tokens
    expect(text).toContain("Unmatched telemetry") // honest failure-count note
  })

  it("Telemetry tab shows a no-traffic note when nothing joined", async () => {
    const user = userEvent.setup()
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    await selectTab(user, "Telemetry")
    expect(panelText()).toContain("no runtime telemetry")
  })

  it("Raw JSON tab is a dual view (source default + tree) and includes request_headers", async () => {
    const user = userEvent.setup()
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    await selectTab(user, "Raw JSON")
    // Defaults to the source view; the full model JSON (incl. request_headers) is shown.
    const sourceTab = screen.getByRole("tab", { name: "原文" })
    const treeTab = screen.getByRole("tab", { name: "树" })
    expect(sourceTab.getAttribute("aria-selected")).toBe("true")
    expect(treeTab.getAttribute("aria-selected")).toBe("false")
    expect(panelText()).toContain("request_headers")
    expect(panelText()).toContain("sentinel-value")

    // Switching to the tree view keeps the data visible (nothing is dropped).
    await user.click(treeTab)
    expect(treeTab.getAttribute("aria-selected")).toBe("true")
    expect(sourceTab.getAttribute("aria-selected")).toBe("false")
    expect(panelText()).toContain("request_headers")
    expect(panelText()).toContain("sentinel-value")
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
    fireEvent.keyDown(document, { key: "Escape" })
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
    // 抽屉内放一个 input 并聚焦（模态下焦点被 trap 在抽屉内，外部 input 不可聚焦）。
    const region = screen.getByRole("dialog")
    const input = document.createElement("input")
    region.append(input)
    input.focus()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
    input.remove()
    // 焦点移出文本控件后 Escape 关闭。
    screen.getByRole("dialog").focus()
    fireEvent.keyDown(document, { key: "Escape" })
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
    const dialog = screen.getByRole("dialog")
    expect(dialog.contains(document.activeElement) || document.activeElement === dialog).toBe(true)
  })

  it("shows the status label in the header when a status is passed (mirrors the table)", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        status="config-disabled"
        onClose={() => {}}
      />,
    )
    // The header echoes the table's status vocabulary (config-disabled → "disabled").
    expect(screen.getByText("disabled")).toBeDefined()
  })

  it("omits the header status dot when no status is passed", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    // No status prop → no "disabled"/"picker-off" label in the header (dot omitted).
    expect(screen.queryByText("disabled")).toBeNull()
    expect(screen.queryByText("picker-off")).toBeNull()
  })

  it("switches tab + wires panel aria + roving tabindex (Radix Tabs)", async () => {
    const user = userEvent.setup()
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    const overview = screen.getByRole("tab", { name: "Overview" })
    const capabilities = screen.getByRole("tab", { name: "Capabilities" })
    expect(overview.getAttribute("aria-selected")).toBe("true")

    await user.click(capabilities)
    expect(capabilities.getAttribute("aria-selected")).toBe("true")
    expect(overview.getAttribute("aria-selected")).toBe("false")
    // Radix wires the panel back to the active tab (aria-labelledby → trigger id).
    expect(screen.getAllByRole("tabpanel")[0].getAttribute("aria-labelledby")).toBe(capabilities.getAttribute("id"))
    // Roving tabindex: only the active/focused tab is Tab-focusable.
    expect(capabilities.getAttribute("tabindex")).toBe("0")
    expect(overview.getAttribute("tabindex")).toBe("-1")
  })

  it("keyboard nav (Radix vertical): Up/Down move, Left/Right do not", async () => {
    const user = userEvent.setup()
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

    await user.click(overview) // focus the tablist on the active tab
    await user.keyboard("{ArrowDown}")
    expect(capabilities.getAttribute("aria-selected")).toBe("true")
    // Wrap: from the first tab ArrowUp loops to the last (Radix loop).
    await user.keyboard("{ArrowUp}{ArrowUp}")
    expect(rawJson.getAttribute("aria-selected")).toBe("true")
    // Home/End jump to the ends (Radix vertical roving).
    await user.keyboard("{Home}")
    expect(overview.getAttribute("aria-selected")).toBe("true")
    await user.keyboard("{End}")
    expect(rawJson.getAttribute("aria-selected")).toBe("true")
    // Vertical tablist does NOT own Left/Right — active tab unchanged.
    await user.keyboard("{ArrowRight}{ArrowLeft}")
    expect(rawJson.getAttribute("aria-selected")).toBe("true")
  })

  it("splitter ArrowLeft grows the right-docked panel (invert keyboard resize)", () => {
    render(
      <ModelDetail
        model={VISION_MODEL}
        telemetry={null}
        onClose={() => {}}
      />,
    )
    const sep = screen.getByRole("separator", { name: /Resize model detail/i })
    expect(sep.getAttribute("tabindex")).toBe("0")
    const before = Number(sep.getAttribute("aria-valuenow"))
    // invert=true (handle on the panel's LEFT edge) → ArrowLeft GROWS the width.
    act(() => {
      fireEvent.keyDown(sep, { key: "ArrowLeft" })
    })
    expect(Number(sep.getAttribute("aria-valuenow"))).toBe(before + 16)
    // ArrowRight shrinks back.
    act(() => {
      fireEvent.keyDown(sep, { key: "ArrowRight" })
    })
    expect(Number(sep.getAttribute("aria-valuenow"))).toBe(before)
  })
})
