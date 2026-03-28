<script setup lang="ts">
import { inject, computed } from "vue"
import { useRoute } from "vue-router"

import type { HistoryStore } from "@/composables/useHistoryStore"

import StatusDot from "@/components/ui/StatusDot.vue"
import { getVariantSwitchPath, isVuetifyPath } from "@/utils/route-variants"

const store = inject<HistoryStore>("historyStore")

if (!store) {
  throw new Error("historyStore injection missing")
}
const route = useRoute()

/** Current UI variant based on route path */
const isVuetify = computed(() => isVuetifyPath(route.path))

const vuetifyLinks = [
  { to: "/v/history", label: "History" },
  { to: "/v/logs", label: "Logs" },
  { to: "/v/dashboard", label: "Dashboard" },
  { to: "/v/models", label: "Models" },
  { to: "/v/usage", label: "Usage" },
]

const legacyLinks = [
  { to: "/history", label: "History" },
  { to: "/logs", label: "Logs" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/models", label: "Models" },
  { to: "/usage", label: "Usage" },
]

const navLinks = computed(() => (isVuetify.value ? vuetifyLinks : legacyLinks))

/** Switch to the equivalent page in the other UI variant */
const switchPath = computed(() => getVariantSwitchPath(route.path))

const switchLabel = computed(() => (isVuetify.value ? "Legacy" : "Vuetify"))

function isActive(path: string): boolean {
  return route.path === path
}
</script>

<template>
  <nav class="navbar">
    <div class="navbar-left">
      <span class="navbar-brand">copilot-api</span>
    </div>
    <div class="navbar-center">
      <router-link
        v-for="link in navLinks"
        :key="link.to"
        :to="link.to"
        class="nav-link"
        :class="{ active: isActive(link.to) }"
      >
        {{ link.label }}
      </router-link>
    </div>
    <div class="navbar-right">
      <router-link
        :to="switchPath"
        class="switch-link"
        >{{ switchLabel }}</router-link
      >
      <StatusDot
        :status="store.wsConnected.value ? 'success' : 'error'"
        :size="6"
      />
      <span class="ws-label">{{ store.wsConnected.value ? "Live" : "Offline" }}</span>
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
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.3px;
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

.ws-label {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
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
