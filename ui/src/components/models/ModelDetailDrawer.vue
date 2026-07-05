<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"
import type { JoinedModelTelemetry } from "@/composables/model-telemetry-join"

import { computed, ref } from "vue"

import BillingPolicyTab from "./detail/tabs/BillingPolicyTab.vue"
import CapabilitiesTab from "./detail/tabs/CapabilitiesTab.vue"
import LimitsVisionTab from "./detail/tabs/LimitsVisionTab.vue"
import OverviewTab from "./detail/tabs/OverviewTab.vue"
import RawJsonTab from "./detail/tabs/RawJsonTab.vue"
import TelemetryTab from "./detail/tabs/TelemetryTab.vue"

const props = defineProps<{ modelValue: boolean; model: Model | null; caps: DerivedCapabilities | null; telemetry: JoinedModelTelemetry | null }>()
const emit = defineEmits<{ "update:modelValue": [boolean] }>()

const open = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
})
const tab = ref("overview")
</script>

<template>
  <v-navigation-drawer
    v-model="open"
    location="right"
    temporary
    width="440"
    class="model-detail-drawer"
    role="dialog"
    :aria-label="model ? `Model details: ${model.id}` : 'Model details'"
  >
    <template v-if="model && caps">
      <div class="drawer-head">
        <div class="drawer-title font-mono">{{ model.id }}</div>
        <v-btn
          icon
          variant="text"
          aria-label="Close"
          @click="open = false"
        >
          <v-icon icon="mdi-close" />
        </v-btn>
      </div>

      <v-tabs
        v-model="tab"
        density="compact"
      >
        <v-tab value="overview">Overview</v-tab>
        <v-tab value="capabilities">Capabilities</v-tab>
        <v-tab value="limits">Limits</v-tab>
        <v-tab value="billing">Billing</v-tab>
        <v-tab value="telemetry">Telemetry</v-tab>
        <v-tab value="raw">Raw JSON</v-tab>
      </v-tabs>

      <v-window
        v-model="tab"
        class="drawer-body"
      >
        <v-window-item value="overview">
          <OverviewTab
            :model="model"
            :caps="caps"
          />
        </v-window-item>
        <v-window-item value="capabilities">
          <CapabilitiesTab
            :model="model"
            :caps="caps"
          />
        </v-window-item>
        <v-window-item value="limits">
          <LimitsVisionTab
            :model="model"
            :caps="caps"
          />
        </v-window-item>
        <v-window-item value="billing">
          <BillingPolicyTab
            :model="model"
            :caps="caps"
          />
        </v-window-item>
        <v-window-item value="telemetry">
          <TelemetryTab
            :model="model"
            :caps="caps"
            :telemetry="telemetry"
          />
        </v-window-item>
        <v-window-item value="raw">
          <RawJsonTab :model="model" />
        </v-window-item>
      </v-window>
    </template>
  </v-navigation-drawer>
</template>

<style scoped>
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 8px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.drawer-title {
  font-size: 0.95rem;
  font-weight: 700;
  word-break: break-all;
}

.drawer-body {
  padding: 4px 16px 16px;
}
</style>
