import { create } from "zustand"

export type ThemeMode = "light" | "dark" | "system"

interface UiState {
  theme: ThemeMode
  wsConnected: boolean
  setTheme: (t: ThemeMode) => void
  setWsConnected: (c: boolean) => void
}

const STORAGE_KEY = "copilot-api-v4-theme"

export const useUiStore = create<UiState>((set) => ({
  theme: (localStorage.getItem(STORAGE_KEY) as ThemeMode | null) ?? "dark",
  wsConnected: false,
  setTheme: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme)
    set({ theme })
  },
  setWsConnected: (wsConnected) => set({ wsConnected }),
}))
