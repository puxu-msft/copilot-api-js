import { useLocalStorage } from "@vueuse/core"
import { watch } from "vue"
import { useTheme } from "vuetify"

const STORAGE_KEY = "copilot-api-theme"
const VALID_THEMES = new Set(["light", "dark", "system"])

export interface AppThemeController {
  theme: ReturnType<typeof useTheme>
  cycle: () => void
  isDark: () => boolean
  name: () => string
}

export function useAppTheme(): AppThemeController {
  const theme = useTheme()
  const storedTheme = useLocalStorage(STORAGE_KEY, theme.global.name.value)

  // Apply stored theme on init (if valid)
  if (VALID_THEMES.has(storedTheme.value)) {
    theme.change(storedTheme.value)
  }

  // Sync Vuetify theme name → localStorage
  watch(
    () => theme.global.name.value,
    (name) => {
      storedTheme.value = name
    },
  )

  return {
    theme,
    cycle: () => theme.cycle(["light", "dark", "system"]),
    isDark: () => theme.global.current.value.dark,
    name: () => theme.global.name.value,
  }
}
