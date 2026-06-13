/** Vuetify plugin configuration */

import "vuetify/styles"
import "@mdi/font/css/materialdesignicons.css"
import { createVuetify } from "vuetify"
import { md3 } from "vuetify/blueprints"

export const vuetify = createVuetify({
  blueprint: md3,
  theme: {
    defaultTheme: "system",
    variations: {
      colors: ["primary", "secondary", "success", "error", "warning", "aborted", "interrupted"],
      lighten: 2,
      darken: 2,
    },
    themes: {
      dark: {
        dark: true,
        colors: {
          background: "#111115",
          "on-background": "#e8e4df",
          surface: "#18181c",
          "on-surface": "#e8e4df",
          "surface-variant": "#222228",
          "on-surface-variant": "#b8b2a8",
          primary: "#d4a04a",
          "on-primary": "#111115",
          secondary: "#908a82",
          "on-secondary": "#111115",
          success: "#5cb870",
          "on-success": "#111115",
          error: "#d95550",
          "on-error": "#e8e4df",
          warning: "#c98a2e",
          "on-warning": "#111115",
          info: "#d4a04a",
          "on-info": "#111115",
          // Lifecycle terminal states distinct from success/error (see status-meta.ts):
          // aborted = client disconnected (violet), interrupted = crash orphan (rose).
          aborted: "#a07ed8",
          "on-aborted": "#111115",
          interrupted: "#c86090",
          "on-interrupted": "#111115",
        },
      },
      light: {
        dark: false,
        colors: {
          background: "#faf8f5",
          "on-background": "#2c2518",
          surface: "#f0ede8",
          "on-surface": "#2c2518",
          "surface-variant": "#e6e2dc",
          "on-surface-variant": "#6b5f50",
          primary: "#a07020",
          "on-primary": "#faf8f5",
          secondary: "#7a7060",
          "on-secondary": "#faf8f5",
          success: "#357a42",
          "on-success": "#faf8f5",
          error: "#b83a36",
          "on-error": "#faf8f5",
          warning: "#8a6015",
          "on-warning": "#faf8f5",
          info: "#a07020",
          "on-info": "#faf8f5",
          aborted: "#7052b0",
          "on-aborted": "#faf8f5",
          interrupted: "#a04070",
          "on-interrupted": "#faf8f5",
        },
      },
    },
  },
  defaults: {
    global: {
      rounded: 0,
    },
    VAlert: { rounded: 0 },
    VAppBar: { rounded: 0 },
    VBtn: { rounded: 0 },
    VBtnToggle: { rounded: 0 },
    VCard: { variant: "outlined", rounded: 0 },
    VChip: { size: "small", variant: "tonal", rounded: 0 },
    VDialog: { rounded: 0 },
    VList: { rounded: 0 },
    VListItem: { rounded: 0 },
    VMenu: { rounded: 0 },
    VNavigationDrawer: { rounded: 0 },
    VProgressLinear: { rounded: false },
    VSelect: { variant: "outlined", density: "compact", hideDetails: true, rounded: 0 },
    VSheet: { rounded: 0 },
    VTab: { rounded: 0 },
    VTable: { rounded: 0 },
    VTabs: { rounded: 0 },
    VTextField: { variant: "outlined", density: "compact", hideDetails: true, rounded: 0 },
    VTextarea: { variant: "outlined", density: "compact", hideDetails: true, rounded: 0 },
    VToolbar: { rounded: 0 },
    VTooltip: { rounded: 0 },
  },
})
