<script setup lang="ts">
import { inject, computed } from "vue"
import { useRoute } from "vue-router"

import type { AppThemeController } from "@/composables/useAppTheme"

import { getVariantSwitchPath, isVuetifyPath, legacyNavLinks, vuetifyNavLinks } from "@/utils/route-variants"
const route = useRoute()
const appTheme = inject<AppThemeController | null>("appTheme", null)

/** Current UI variant based on route path */
const isVuetify = computed(() => isVuetifyPath(route.path))
const navLinks = computed(() => (isVuetify.value ? vuetifyNavLinks : legacyNavLinks))

/** Switch to the equivalent page in the other UI variant */
const switchPath = computed(() => getVariantSwitchPath(route.path))

const switchLabel = computed(() => (isVuetify.value ? "Legacy" : "Vuetify"))
const activeVuetifyTab = computed(() => {
  if (route.path.startsWith("/v/history/")) return "/v/activity"
  return vuetifyNavLinks.some((link) => link.path === route.path) ? route.path : null
})
const homePath = computed(() => (isVuetify.value ? "/v/dashboard" : "/logs"))

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
    v-if="isVuetify"
    flat
    density="compact"
    color="surface"
  >
    <v-app-bar-title class="text-body-1 font-weight-bold flex-grow-0">
      <router-link
        :to="homePath"
        class="app-bar-brand"
      >
        copilot-api
      </router-link>
    </v-app-bar-title>

    <v-tabs
      :model-value="activeVuetifyTab"
      color="primary"
      density="compact"
      align-tabs="start"
    >
      <v-tab
        v-for="link in vuetifyNavLinks"
        :key="link.path"
        :value="link.path"
        :to="link.path"
      >
        {{ link.label }}
      </v-tab>
    </v-tabs>

    <v-spacer />

    <v-btn
      v-if="switchPath"
      :to="switchPath"
      size="small"
      variant="text"
      class="mr-1"
    >
      {{ switchLabel }}
    </v-btn>

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

  <nav
    v-else
    class="navbar"
  >
    <div class="navbar-left">
      <router-link
        :to="homePath"
        class="navbar-brand"
      >
        copilot-api
      </router-link>
    </div>
    <div class="navbar-center">
      <router-link
        v-for="link in navLinks"
        :key="link.path"
        :to="link.path"
        class="nav-link"
        exact-active-class="active"
      >
        {{ link.label }}
      </router-link>
    </div>
    <div class="navbar-right">
      <router-link
        v-if="switchPath"
        :to="switchPath"
        class="switch-link"
        >{{ switchLabel }}</router-link
      >
    </div>
  </nav>
</template>

<style scoped>
.navbar {
  height: var(--header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-lg);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.navbar-left {
  display: flex;
  align-items: center;
}

.navbar-brand {
  text-decoration: none;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.3px;
}

.app-bar-brand {
  color: inherit;
  text-decoration: none;
}

.navbar-center {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.nav-link {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  padding: var(--spacing-xs) var(--spacing-md);
  text-decoration: none;
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.nav-link:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.nav-link.active {
  color: var(--primary);
  font-weight: 600;
}

.navbar-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.switch-link {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  text-decoration: none;
  padding: 2px 8px;
  border: 1px solid var(--border);
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.switch-link:hover {
  color: var(--primary);
  border-color: var(--primary);
}

@media (max-width: 768px) {
  .navbar {
    flex-wrap: wrap;
    height: auto;
    padding: var(--spacing-sm) var(--spacing-md);
    gap: var(--spacing-sm);
  }

  .navbar-center {
    order: 3;
    width: 100%;
    justify-content: center;
  }
}
</style>
