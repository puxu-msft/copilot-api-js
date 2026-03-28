/** Vuetify plugin configuration */

import "vuetify/styles"
import "@mdi/font/css/materialdesignicons.css"
import { createVuetify } from "vuetify"

export const vuetify = createVuetify({
  theme: {
    defaultTheme: "dark",
    themes: {
      dark: {
        dark: true,
        colors: {
          background: "#0d1117",
          surface: "#161b22",
          "surface-variant": "#21262d",
          primary: "#58a6ff",
          secondary: "#8b949e",
          success: "#3fb950",
          error: "#f85149",
          warning: "#d29922",
          info: "#58a6ff",
        },
      },
      light: {
        dark: false,
        colors: {
          background: "#ffffff",
          surface: "#f6f8fa",
          "surface-variant": "#eaeef2",
          primary: "#0969da",
          secondary: "#57606a",
          success: "#1a7f37",
          error: "#cf222e",
          warning: "#9a6700",
          info: "#0969da",
        },
      },
    },
  },
  defaults: {
    VCard: { variant: "outlined", density: "comfortable" },
    VChip: { size: "small", variant: "tonal" },
    VTextField: { variant: "outlined", density: "compact", hideDetails: true },
    VSelect: { variant: "outlined", density: "compact", hideDetails: true },
    VBtn: { variant: "text", size: "small" },
  },
})
