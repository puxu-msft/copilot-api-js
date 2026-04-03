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
      colors: ["primary", "secondary", "success", "error", "warning"],
      lighten: 2,
      darken: 2,
    },
    themes: {
      dark: {
        dark: true,
        colors: {
          background: "#0d1117",
          "on-background": "#f0f6fc",
          surface: "#161b22",
          "on-surface": "#f0f6fc",
          "surface-variant": "#21262d",
          "on-surface-variant": "#c9d1d9",
          primary: "#58a6ff",
          "on-primary": "#0d1117",
          secondary: "#8b949e",
          "on-secondary": "#0d1117",
          success: "#3fb950",
          "on-success": "#0d1117",
          error: "#f85149",
          "on-error": "#ffffff",
          warning: "#d29922",
          "on-warning": "#0d1117",
          info: "#58a6ff",
          "on-info": "#0d1117",
        },
      },
      light: {
        dark: false,
        colors: {
          background: "#ffffff",
          "on-background": "#1f2328",
          surface: "#f6f8fa",
          "on-surface": "#1f2328",
          "surface-variant": "#eaeef2",
          "on-surface-variant": "#57606a",
          primary: "#0969da",
          "on-primary": "#ffffff",
          secondary: "#57606a",
          "on-secondary": "#ffffff",
          success: "#1a7f37",
          "on-success": "#ffffff",
          error: "#cf222e",
          "on-error": "#ffffff",
          warning: "#9a6700",
          "on-warning": "#ffffff",
          info: "#0969da",
          "on-info": "#ffffff",
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
