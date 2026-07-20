<script setup lang="ts">
import {
  //
  inject,
  computed,
} from "vue"
import {
  //
  useRoute,
  useRouter,
} from "vue-router"

import type { AppThemeController } from "@/composables/useAppTheme"

const route = useRoute()
const router = useRouter()
const appTheme = inject<AppThemeController | null>("appTheme", null)

const navLinks = [
  { path: "/dashboard", label: "Dashboard" },
  { path: "/config", label: "Config" },
  { path: "/activity", label: "Activity" },
  { path: "/search", label: "Search" },
]

const activeTab = computed(() => {
  if (route.path.startsWith("/activity/")) return "/activity"
  return navLinks.some((link) => link.path === route.path) ? route.path : null
})

/** Navigate via explicit click instead of v-tab :to to avoid controlled v-tabs conflict */
function navigateTo(path: string): void {
  if (route.path !== path) void router.push(path)
}

const themeIcon = computed(() => {
  const name = appTheme?.name()
  if (name === "light") return "mdi-brightness-5"
  if (name === "dark") return "mdi-brightness-2"
  return "mdi-brightness-auto"
})

const themeLabel = computed(() => {
  const name = appTheme?.name()
  if (name === "light") return "Light"
  if (name === "dark") return "Dark"
  return "System"
})

function cycleTheme(): void {
  appTheme?.cycle()
}
</script>

<template>
  <v-app-bar
    flat
    density="compact"
    color="surface"
  >
    <v-app-bar-title class="text-body-1 font-weight-bold flex-grow-0">
      <router-link
        to="/dashboard"
        class="app-bar-brand font-mono"
      >
        copilot-api
      </router-link>
    </v-app-bar-title>

    <v-tabs
      :model-value="activeTab"
      color="primary"
      density="compact"
      align-tabs="start"
    >
      <v-tab
        v-for="link in navLinks"
        :key="link.path"
        :value="link.path"
        @click="navigateTo(link.path)"
      >
        {{ link.label }}
      </v-tab>
    </v-tabs>

    <v-spacer />

    <v-btn
      icon
      :aria-label="`Theme: ${themeLabel}`"
      @click="cycleTheme"
    >
      <v-icon :icon="themeIcon" />
      <v-tooltip activator="parent">
        {{ themeLabel }}
      </v-tooltip>
    </v-btn>
  </v-app-bar>
</template>

<style scoped>
.app-bar-brand {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
}
</style>
