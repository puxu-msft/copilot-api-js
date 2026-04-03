import { beforeEach, describe, expect, mock, test } from "bun:test"
import { reactive } from "vue"

import type { ConfigYamlResponse, EditableConfig } from "../src/types/config"

const toastShow = mock(() => {})
const mockFetchConfigYaml = mock<() => Promise<ConfigYamlResponse>>(() => Promise.resolve({}))
const mockSaveConfigYaml = mock<(config: EditableConfig) => Promise<ConfigYamlResponse>>(() => Promise.resolve({}))

class MockApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public bodyText: string,
  ) {
    super(message)
  }
}

void mock.module("../src/api/http", () => ({
  api: {
    fetchConfigYaml: mockFetchConfigYaml,
    saveConfigYaml: mockSaveConfigYaml,
  },
  ApiError: MockApiError,
}))

void mock.module("../src/composables/useToast", () => ({
  useToast: () => ({
    show: toastShow,
  }),
}))

const { formatConfigErrorMessage, serializeEditableConfig, useConfigEditor } =
  await import("../src/composables/useConfigEditor")

describe("useConfigEditor", () => {
  beforeEach(() => {
    mockFetchConfigYaml.mockReset()
    mockSaveConfigYaml.mockReset()
    toastShow.mockReset()
  })

  test("load populates config and original with normalized data", async () => {
    mockFetchConfigYaml.mockResolvedValue({
      fetch_timeout: 300,
      model_refresh_interval: 600,
      anthropic: {
        rewrite_system_reminders: [],
      },
    })

    const editor = useConfigEditor()
    await editor.load()

    expect(editor.loading.value).toBe(false)
    expect(editor.error.value).toBeNull()
    expect(editor.config.value).toEqual({
      fetch_timeout: 300,
      model_refresh_interval: 600,
      anthropic: {
        rewrite_system_reminders: false,
      },
    })
    expect(editor.original.value).toEqual(editor.config.value)
  })

  test("load failure surfaces the error and leaves config empty", async () => {
    mockFetchConfigYaml.mockRejectedValue(new Error("config load failed"))

    const editor = useConfigEditor()
    await editor.load()

    expect(editor.loading.value).toBe(false)
    expect(editor.config.value).toBeNull()
    expect(editor.original.value).toBeNull()
    expect(editor.error.value).toBe("config load failed")
    expect(toastShow).toHaveBeenCalledWith("config load failed", "error")
  })

  test("isDirty and discard reflect local edits", async () => {
    mockFetchConfigYaml.mockResolvedValue({
      fetch_timeout: 300,
    })

    const editor = useConfigEditor()
    await editor.load()

    expect(editor.isDirty.value).toBe(false)

    editor.config.value = {
      ...editor.config.value,
      fetch_timeout: 600,
    }

    expect(editor.isDirty.value).toBe(true)

    editor.discard()

    expect(editor.config.value).toEqual({
      fetch_timeout: 300,
    })
    expect(editor.isDirty.value).toBe(false)
  })

  test("isDirty returns to false when a field is restored to its original value", async () => {
    mockFetchConfigYaml.mockResolvedValue({
      fetch_timeout: 300,
      anthropic: {
        strip_server_tools: true,
      },
    })

    const editor = useConfigEditor()
    await editor.load()

    editor.config.value = {
      ...editor.config.value,
      fetch_timeout: 600,
    }
    expect(editor.isDirty.value).toBe(true)

    editor.config.value = {
      ...editor.config.value,
      fetch_timeout: 300,
    }
    expect(editor.isDirty.value).toBe(false)
  })

  test("hasRestartFields only tracks proxy and rate_limiter changes", async () => {
    mockFetchConfigYaml.mockResolvedValue({
      fetch_timeout: 300,
      model_refresh_interval: 600,
    })

    const editor = useConfigEditor()
    await editor.load()

    expect(editor.hasRestartFields.value).toBe(false)

    editor.config.value = {
      ...editor.config.value,
      fetch_timeout: 600,
    }
    expect(editor.hasRestartFields.value).toBe(false)

    editor.config.value = {
      ...editor.config.value,
      model_refresh_interval: 0,
    }
    expect(editor.hasRestartFields.value).toBe(false)

    editor.config.value = {
      ...editor.config.value,
      proxy: "http://127.0.0.1:7890",
    }
    expect(editor.hasRestartFields.value).toBe(true)
  })

  test("save updates original and shows restart-aware success toast", async () => {
    mockFetchConfigYaml.mockResolvedValue({})
    mockSaveConfigYaml.mockImplementation((config) => Promise.resolve(config as ConfigYamlResponse))

    const editor = useConfigEditor()
    await editor.load()

    editor.config.value = {
      proxy: "http://127.0.0.1:7890",
    }

    const saved = await editor.save()

    expect(saved).toBe(true)
    expect(mockSaveConfigYaml).toHaveBeenCalledWith({
      proxy: "http://127.0.0.1:7890",
    })
    expect(editor.original.value).toEqual({
      proxy: "http://127.0.0.1:7890",
    })
    expect(editor.isDirty.value).toBe(false)
    expect(toastShow).toHaveBeenCalledWith("Config saved. Some changes require a restart.", "success")
  })

  test("save clones nested reactive edits without throwing", async () => {
    mockFetchConfigYaml.mockResolvedValue({
      anthropic: {
        strip_server_tools: true,
      },
    })
    mockSaveConfigYaml.mockImplementation((config) => Promise.resolve(config as ConfigYamlResponse))

    const editor = useConfigEditor()
    await editor.load()

    editor.config.value = reactive({
      ...editor.config.value,
      anthropic: {
        ...editor.config.value?.anthropic,
        strip_server_tools: false,
      },
    })

    const saved = await editor.save()

    expect(saved).toBe(true)
    expect(editor.config.value).toEqual({
      anthropic: {
        strip_server_tools: false,
      },
    })
    expect(editor.original.value).toEqual({
      anthropic: {
        strip_server_tools: false,
      },
    })
  })

  test("save keeps edit state on validation failure and surfaces field messages", async () => {
    mockFetchConfigYaml.mockResolvedValue({})
    mockSaveConfigYaml.mockRejectedValue(
      new MockApiError(
        400,
        "400",
        JSON.stringify({
          error: "Config validation failed",
          details: [
            {
              field: "fetch_timeout",
              message: "Must be a non-negative integer or null",
            },
          ],
        }),
      ),
    )

    const editor = useConfigEditor()
    await editor.load()
    editor.config.value = { fetch_timeout: -1 }

    const saved = await editor.save()

    expect(saved).toBe(false)
    expect(editor.error.value).toBe("fetch_timeout: Must be a non-negative integer or null")
    expect(editor.config.value).toEqual({ fetch_timeout: -1 })
    expect(toastShow).toHaveBeenCalledWith("fetch_timeout: Must be a non-negative integer or null", "error")
  })

  test("save keeps edit state on network failure and surfaces the error message", async () => {
    mockFetchConfigYaml.mockResolvedValue({})
    mockSaveConfigYaml.mockRejectedValue(new Error("network down"))

    const editor = useConfigEditor()
    await editor.load()
    editor.config.value = { fetch_timeout: 30 }

    const saved = await editor.save()

    expect(saved).toBe(false)
    expect(editor.error.value).toBe("network down")
    expect(editor.config.value).toEqual({ fetch_timeout: 30 })
    expect(editor.original.value).toEqual({})
    expect(toastShow).toHaveBeenCalledWith("network down", "error")
  })
})

describe("config editor helpers", () => {
  test("serializeEditableConfig normalizes empty reminder rule arrays to false", () => {
    expect(
      serializeEditableConfig({
        anthropic: {
          rewrite_system_reminders: [],
        },
      }),
    ).toEqual({
      anthropic: {
        rewrite_system_reminders: false,
      },
    })
  })

  test("formatConfigErrorMessage falls back to ApiError message for non-json bodies", () => {
    expect(formatConfigErrorMessage(new MockApiError(500, "500: exploded", "not json"))).toBe("500: exploded")
  })
})
