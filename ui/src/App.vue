<script setup lang="ts">
import {
  //
  provide,
  onMounted,
  onUnmounted,
} from "vue"

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
      <!-- keep-alive the Activity LIST so returning from a detail page preserves
           its scroll position + filter inputs without a re-render/re-fetch.
           The detail page (/activity/:id) is intentionally NOT cached. -->
      <router-view v-slot="{ Component }">
        <keep-alive include="VActivityPage">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </v-main>
  </v-app>

  <BaseToast />
</template>
