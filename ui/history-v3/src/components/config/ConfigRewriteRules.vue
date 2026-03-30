<script setup lang="ts">
import { ref } from "vue"

import type { PromptOverrideRule, ReminderRewriteRule } from "@/types/config"

type RewriteRuleValue = boolean | Array<PromptOverrideRule | ReminderRewriteRule> | null | undefined

const props = defineProps<{
  modelValue: RewriteRuleValue
  label: string
  description?: string
  disabled?: boolean
  showModelField?: boolean
  allowBooleanModes?: boolean
}>()

const emit = defineEmits<{
  "update:modelValue": [value: RewriteRuleValue]
}>()

const collapsedRules = ref<Record<number, boolean>>({})

function currentMode(): "disabled" | "remove-all" | "rules" {
  if (Array.isArray(props.modelValue)) return "rules"
  if (props.modelValue === true) return "remove-all"
  return "disabled"
}

function setMode(mode: "disabled" | "remove-all" | "rules"): void {
  if (mode === "disabled") {
    emit("update:modelValue", false)
    return
  }
  if (mode === "remove-all") {
    emit("update:modelValue", true)
    return
  }
  emit("update:modelValue", Array.isArray(props.modelValue) ? props.modelValue : [])
}

function rules(): Array<PromptOverrideRule | ReminderRewriteRule> {
  return Array.isArray(props.modelValue) ? props.modelValue : []
}

function updateRule(index: number, patch: Partial<PromptOverrideRule | ReminderRewriteRule>): void {
  emit(
    "update:modelValue",
    rules().map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)),
  )
}

function addRule(): void {
  emit("update:modelValue", [...rules(), { from: "", to: "", method: "regex" }])
}

function removeRule(index: number): void {
  const next = rules().filter((_, ruleIndex) => ruleIndex !== index)
  emit("update:modelValue", props.allowBooleanModes && next.length === 0 ? false : next)
}

function toggleRule(index: number): void {
  collapsedRules.value = {
    ...collapsedRules.value,
    [index]: !collapsedRules.value[index],
  }
}

function isRuleCollapsed(index: number): boolean {
  return collapsedRules.value[index] ?? false
}

function ruleSummary(rule: PromptOverrideRule | ReminderRewriteRule): string {
  const method = rule.method ?? "regex"
  const modelSummary = "model" in rule && rule.model ? ` · ${rule.model}` : ""
  return `${method}${modelSummary}`
}
</script>

<template>
  <div class="d-flex flex-column ga-3">
    <div>
      <div class="text-body-1">{{ label }}</div>
      <div
        v-if="description"
        class="text-body-2 text-medium-emphasis mt-1"
      >
        {{ description }}
      </div>
    </div>

    <div v-if="allowBooleanModes">
      <v-btn-toggle
        :model-value="currentMode()"
        color="primary"
        divided
        mandatory
        @update:model-value="setMode($event)"
      >
        <v-btn value="disabled">Disabled</v-btn>
        <v-btn value="remove-all">Remove all</v-btn>
        <v-btn value="rules">Rules</v-btn>
      </v-btn-toggle>
    </div>

    <div
      v-if="!Array.isArray(modelValue)"
      class="text-body-2 text-medium-emphasis"
    >
      {{ modelValue === true ? "All matching reminders will be removed." : "Rules are disabled." }}
    </div>

    <div
      v-for="(rule, index) in rules()"
      :key="index"
      class="rule-card"
    >
      <div class="d-flex align-center mb-3">
        <div class="text-body-2 font-weight-medium">Rule {{ index + 1 }}</div>
        <div
          class="text-caption text-medium-emphasis ml-2"
          data-testid="rule-summary"
        >
          {{ ruleSummary(rule) }}
        </div>
        <v-spacer />
        <v-btn
          :disabled="disabled"
          :icon="isRuleCollapsed(index) ? 'mdi-chevron-down' : 'mdi-chevron-up'"
          data-testid="toggle-rule"
          size="small"
          variant="text"
          @click="toggleRule(index)"
        />
        <v-btn
          :disabled="disabled"
          icon="mdi-delete-outline"
          size="small"
          variant="text"
          @click="removeRule(index)"
        />
      </div>

      <div
        v-if="!isRuleCollapsed(index)"
        class="d-flex flex-column ga-3"
      >
        <v-text-field
          :model-value="rule.from"
          :disabled="disabled"
          label="From"
          @update:model-value="updateRule(index, { from: String($event ?? '') })"
        />
        <v-textarea
          :model-value="rule.to"
          :disabled="disabled"
          auto-grow
          label="To"
          rows="2"
          variant="outlined"
          @update:model-value="updateRule(index, { to: String($event ?? '') })"
        />
        <div class="d-flex flex-wrap ga-3">
          <v-select
            :model-value="rule.method ?? 'regex'"
            :disabled="disabled"
            :items="[
              { title: 'Regex', value: 'regex' },
              { title: 'Line', value: 'line' },
            ]"
            class="method-select"
            label="Method"
            @update:model-value="updateRule(index, { method: $event as 'line' | 'regex' })"
          />
          <v-text-field
            v-if="showModelField"
            :model-value="'model' in rule ? (rule.model ?? '') : ''"
            :disabled="disabled"
            class="model-select"
            label="Model regex"
            @update:model-value="updateRule(index, { model: String($event ?? '') || undefined })"
          />
        </div>
      </div>

      <div
        v-else
        class="text-body-2 text-medium-emphasis"
        data-testid="collapsed-rule-summary"
      >
        {{ rule.from || "Empty pattern" }} → {{ rule.to || "Empty replacement" }}
      </div>
    </div>

    <div
      v-if="Array.isArray(modelValue)"
      class="d-flex"
    >
      <v-btn
        :disabled="disabled"
        prepend-icon="mdi-plus"
        variant="outlined"
        @click="addRule"
      >
        Add rule
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.rule-card {
  padding: 16px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 14px;
  background: rgb(var(--v-theme-surface));
}

.method-select {
  max-width: 180px;
}

.model-select {
  min-width: 220px;
}
</style>
