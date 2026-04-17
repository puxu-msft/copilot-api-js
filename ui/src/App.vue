<script setup lang="ts">
import { provide, onMounted, onUnmounted } from "vue"

import NavBar from "@/components/layout/NavBar.vue"
import BaseToast from "@/components/ui/BaseToast.vue"
import { useAppTheme } from "@/composables/useAppTheme"
import { useHistoryStore } from "@/composables/useHistoryStore"

const store = useHistoryStore()
const appTheme = useAppTheme()
provide("appTheme", appTheme)

onMounted(() => store.init())
onUnmounted(() => store.destroy())
</script>

<template>
  <v-app>
    <NavBar />
    <v-main>
      <router-view />
    </v-main>
  </v-app>

  <BaseToast />
</template>
