import type { ComputedRef, Ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, nextTick, ref } from "vue"

type ThemeMock = {
  change: ReturnType<typeof vi.fn<(name: string) => void>>
  cycle: ReturnType<typeof vi.fn<(names?: string[]) => void>>
  global: {
    current: ComputedRef<{ dark: boolean }>
    name: Ref<string>
  }
}

let themeMock: ThemeMock

vi.mock("vuetify", () => ({
  useTheme: () => themeMock,
}))

describe("useAppTheme", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    themeMock = {
      change: vi.fn((name: string) => {
        themeMock.global.name.value = name
      }),
      cycle: vi.fn((names?: string[]) => {
        const options = names ?? ["light", "dark"]
        const currentIndex = options.indexOf(themeMock.global.name.value)
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % options.length
        themeMock.global.name.value = options[nextIndex] ?? options[0] ?? "light"
      }),
      global: {
        current: computed(() => ({ dark: themeMock.global.name.value === "dark" })),
        name: ref("system"),
      },
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("restores a valid theme from localStorage via theme.change()", async () => {
    localStorage.setItem("copilot-api-theme", "dark")
    const { useAppTheme } = await import("@/composables/useAppTheme")

    const appTheme = useAppTheme()

    expect(themeMock.change).toHaveBeenCalledWith("dark")
    expect(appTheme.name()).toBe("dark")
    expect(appTheme.isDark()).toBe(true)
  })

  it("ignores invalid stored values and persists theme changes", async () => {
    localStorage.setItem("copilot-api-theme", "blue")
    const { useAppTheme } = await import("@/composables/useAppTheme")

    const appTheme = useAppTheme()
    appTheme.cycle()
    await nextTick()

    expect(themeMock.change).not.toHaveBeenCalled()
    expect(themeMock.cycle).toHaveBeenCalledWith(["light", "dark", "system"])
    expect(localStorage.getItem("copilot-api-theme")).toBe("light")
  })
})
