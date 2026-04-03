import { flushPromises } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref, toRaw, type ComputedRef, type Ref } from "vue"

import type { EditableConfig } from "@/types/config"

import VConfigPage from "@/pages/vuetify/VConfigPage.vue"

import { mountWithVuetifyStubs } from "./helpers/mount"

type MockAsyncFn<T extends (...args: Array<never>) => Promise<unknown>> = ReturnType<typeof vi.fn<T>>
type MockSyncFn<T extends (...args: Array<never>) => void> = ReturnType<typeof vi.fn<T>>

interface MockEditor {
  config: Ref<EditableConfig | null>
  original: Ref<EditableConfig | null>
  loading: Ref<boolean>
  saving: Ref<boolean>
  error: Ref<string | null>
  isDirty: ComputedRef<boolean>
  hasRestartFields: ComputedRef<boolean>
  load: MockAsyncFn<() => Promise<void>>
  save: MockAsyncFn<() => Promise<boolean>>
  discard: MockSyncFn<() => void>
}

const mockState = vi.hoisted(() => ({
  editor: null as MockEditor | null,
}))

vi.mock("@/composables/useConfigEditor", () => ({
  useConfigEditor: () => {
    if (!mockState.editor) {
      throw new Error("mock editor not initialized")
    }
    return mockState.editor
  },
}))

function cloneConfig(value: EditableConfig | null): EditableConfig | null {
  return value ? structuredClone(stripReactiveWrappers(value)) : null
}

function stripReactiveWrappers<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripReactiveWrappers(entry)) as T
  }

  if (value && typeof value === "object") {
    const rawValue = toRaw(value)
    return Object.fromEntries(Object.entries(rawValue).map(([key, entry]) => [key, stripReactiveWrappers(entry)])) as T
  }

  return value
}

function createEditorMock(initialConfig: EditableConfig): MockEditor {
  const config = ref<EditableConfig | null>(null)
  const original = ref<EditableConfig | null>(null)
  const loading = ref(true)
  const saving = ref(false)
  const error = ref<string | null>(null)

  const isDirty = computed(() => JSON.stringify(config.value ?? null) !== JSON.stringify(original.value ?? null))
  const hasRestartFields = computed(() => {
    const current = config.value
    const base = original.value
    return JSON.stringify(current?.proxy ?? null) !== JSON.stringify(base?.proxy ?? null)
  })

  const load = vi.fn(async () => {
    loading.value = true
    await Promise.resolve()
    config.value = cloneConfig(initialConfig)
    original.value = cloneConfig(initialConfig)
    error.value = null
    loading.value = false
  })

  const save = vi.fn(async () => {
    if (!config.value) return false
    saving.value = true
    await Promise.resolve()
    original.value = cloneConfig(config.value)
    error.value = null
    saving.value = false
    return true
  })

  const discard = vi.fn(() => {
    config.value = cloneConfig(original.value)
    error.value = null
  })

  return {
    config,
    original,
    loading,
    saving,
    error,
    isDirty,
    hasRestartFields,
    load,
    save,
    discard,
  }
}

describe("VConfigPage", () => {
  beforeEach(() => {
    mockState.editor = createEditorMock({
      proxy: "http://127.0.0.1:7890",
      fetch_timeout: 300,
      model_refresh_interval: 600,
      anthropic: {
        strip_server_tools: true,
        rewrite_system_reminders: false,
      },
      "openai-responses": {
        normalize_call_ids: true,
      },
      model_overrides: {
        "claude-3.5-sonnet": "claude-sonnet-4.6",
      },
    })
  })

  it("loads and renders the config form with all major sections", async () => {
    const wrapper = mountWithVuetifyStubs(VConfigPage)

    expect(wrapper.find('[data-testid="v-progress-circular"]').exists()).toBe(true)

    await flushPromises()

    expect(mockState.editor?.load).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain("General")
    expect(wrapper.text()).toContain("Anthropic Pipeline")
    expect(wrapper.text()).toContain("System Prompt")
    expect(wrapper.text()).toContain("OpenAI Responses")
    expect(wrapper.text()).toContain("Timeouts")
    expect(wrapper.text()).toContain("Model Refresh Interval")
    expect(wrapper.text()).toContain("Shutdown")
    expect(wrapper.text()).toContain("History")
    expect(wrapper.text()).toContain("Model Overrides")
    expect(wrapper.text()).toContain("Rate Limiter")

    const saveButtons = wrapper.findAll("button").filter((node) => node.text() === "Save")
    expect(saveButtons).toHaveLength(2)
    expect(saveButtons.every((node) => node.attributes("disabled") !== undefined)).toBe(true)
  })

  it("enables Save after editing a field and disables it again after successful save", async () => {
    const wrapper = mountWithVuetifyStubs(VConfigPage)
    await flushPromises()

    const proxyInput = wrapper.get('input[placeholder="http://127.0.0.1:7890"]')
    await proxyInput.setValue("http://localhost:8080")

    let saveButtons = wrapper.findAll("button").filter((node) => node.text() === "Save")
    expect(saveButtons.every((node) => node.attributes("disabled") === undefined)).toBe(true)

    await saveButtons[0].trigger("click")
    await flushPromises()

    expect(mockState.editor?.save).toHaveBeenCalledTimes(1)
    expect(mockState.editor?.config.value?.proxy).toBe("http://localhost:8080")
    expect(mockState.editor?.original.value?.proxy).toBe("http://localhost:8080")

    saveButtons = wrapper.findAll("button").filter((node) => node.text() === "Save")
    expect(saveButtons.every((node) => node.attributes("disabled") !== undefined)).toBe(true)
  })

  it("restores the previous saved state when Discard is clicked", async () => {
    const wrapper = mountWithVuetifyStubs(VConfigPage)
    await flushPromises()

    const proxyInput = wrapper.get('input[placeholder="http://127.0.0.1:7890"]')
    await proxyInput.setValue("http://localhost:8080")

    const discardButton = wrapper.findAll("button").find((node) => node.text() === "Discard")
    expect(discardButton).toBeDefined()

    if (!discardButton) {
      throw new Error("Discard button missing")
    }

    await discardButton.trigger("click")
    await flushPromises()

    expect(mockState.editor?.discard).toHaveBeenCalledTimes(1)
    expect(mockState.editor?.config.value?.proxy).toBe("http://127.0.0.1:7890")
    expect((wrapper.get('input[placeholder="http://127.0.0.1:7890"]').element as HTMLInputElement).value).toBe(
      "http://127.0.0.1:7890",
    )
  })

  it("shows an error alert when save fails validation", async () => {
    mockState.editor?.save.mockImplementationOnce(() => {
      if (!mockState.editor) {
        return Promise.resolve(false)
      }
      mockState.editor.error.value = "fetch_timeout: Must be a non-negative integer or null"
      return Promise.resolve(false)
    })

    const wrapper = mountWithVuetifyStubs(VConfigPage)
    await flushPromises()

    const proxyInput = wrapper.get('input[placeholder="http://127.0.0.1:7890"]')
    await proxyInput.setValue("http://localhost:8080")

    const saveButton = wrapper.findAll("button").find((node) => node.text() === "Save")
    if (!saveButton) {
      throw new Error("Save button missing")
    }

    await saveButton.trigger("click")
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain("fetch_timeout: Must be a non-negative integer or null")
  })
})
