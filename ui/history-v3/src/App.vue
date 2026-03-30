<script setup lang="ts">
import { provide, onMounted, onUnmounted, computed } from "vue"
import { useRoute } from "vue-router"

import NavBar from "@/components/layout/NavBar.vue"
import BaseToast from "@/components/ui/BaseToast.vue"
import { useHistoryStore } from "@/composables/useHistoryStore"
import { isVuetifyPath } from "@/utils/route-variants"

const store = useHistoryStore()
provide("historyStore", store)

const route = useRoute()
/** Vuetify pages live under /v/ — use v-app wrapper for them */
const isVuetifyRoute = computed(() => isVuetifyPath(route.path))

onMounted(() => store.init())
onUnmounted(() => store.destroy())
</script>

<template>
  <!-- Vuetify routes: use v-app for proper theme/layout context -->
  <v-app v-if="isVuetifyRoute">
    <NavBar />
    <v-main>
      <router-view />
    </v-main>
  </v-app>

  <!-- Legacy routes: keep existing layout -->
  <div
    v-else
    class="app"
  >
    <NavBar />
    <router-view />
  </div>

  <BaseToast />
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
</style>
