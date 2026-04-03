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

  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && VALID_THEMES.has(stored)) {
    theme.change(stored)
  }

  watch(
    () => theme.global.name.value,
    (name) => {
      localStorage.setItem(STORAGE_KEY, name)
    },
  )

  return {
    theme,
    cycle: () => theme.cycle(["light", "dark", "system"]),
    isDark: () => theme.global.current.value.dark,
    name: () => theme.global.name.value,
  }
}
