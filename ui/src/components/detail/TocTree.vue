<script setup lang="ts">
defineProps<{
  nodes: Array<{
    id: string
    label: string
    icon: string
    children?: Array<{
      id: string
      label: string
      icon: string
      children?: Array<{
        id: string
        label: string
        icon: string
      }>
    }>
  }>
  activeId: string
  expandedNodes: Set<string>
}>()

const emit = defineEmits<{
  navigate: [id: string]
  toggle: [id: string]
}>()
</script>

<template>
  <ul class="toc-tree">
    <li
      v-for="node in nodes"
      :key="node.id"
      class="toc-node"
    >
      <!-- Level 0 -->
      <div
        class="toc-item toc-level-0"
        :class="{ active: activeId === node.id }"
        @click="emit('navigate', node.id)"
      >
        <span
          class="toc-cell toc-cell-expand"
          @click.stop="node.children?.length && emit('toggle', node.id)"
        >
          <v-icon
            v-if="node.children?.length"
            :icon="expandedNodes.has(node.id) ? 'mdi-chevron-down' : 'mdi-chevron-right'"
            size="x-small"
          />
        </span>
        <span class="toc-cell toc-cell-icon">
          <v-icon
            :icon="node.icon"
            size="x-small"
          />
        </span>
        <span class="toc-label">{{ node.label }}</span>
      </div>

      <!-- Level 1 children -->
      <ul
        v-if="node.children?.length && expandedNodes.has(node.id)"
        class="toc-subtree"
      >
        <li
          v-for="child in node.children"
          :key="child.id"
          class="toc-node"
        >
          <div
            class="toc-item toc-level-1"
            :class="{ active: activeId === child.id }"
            @click="emit('navigate', child.id)"
          >
            <span
              class="toc-cell toc-cell-expand"
              @click.stop="child.children?.length && emit('toggle', child.id)"
            >
              <v-icon
                v-if="child.children?.length"
                :icon="expandedNodes.has(child.id) ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                size="x-small"
              />
            </span>
            <span class="toc-cell toc-cell-icon">
              <v-icon
                :icon="child.icon"
                size="x-small"
              />
            </span>
            <span class="toc-label">{{ child.label }}</span>
          </div>

          <!-- Level 2 children (content blocks) -->
          <ul
            v-if="child.children?.length && expandedNodes.has(child.id)"
            class="toc-subtree"
          >
            <li
              v-for="leaf in child.children"
              :key="leaf.id"
              class="toc-node"
            >
              <div
                class="toc-item toc-level-2"
                :class="{ active: activeId === leaf.id }"
                @click="emit('navigate', leaf.id)"
              >
                <!-- No expand cell at leaf level, but keep the same column slot -->
                <span class="toc-cell toc-cell-expand" />
                <span class="toc-cell toc-cell-icon">
                  <v-icon
                    :icon="leaf.icon"
                    size="x-small"
                  />
                </span>
                <span class="toc-label">{{ leaf.label }}</span>
              </div>
            </li>
          </ul>
        </li>
      </ul>
    </li>
  </ul>
</template>

<style scoped>
.toc-tree,
.toc-subtree {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc-item {
  display: flex;
  align-items: center;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 0.72rem;
  line-height: 1.3;
  color: rgb(var(--v-theme-on-surface-variant));
  transition: background 0.1s ease;
}

.toc-item:hover {
  background: rgb(var(--v-theme-surface-variant) / 60%);
}

.toc-item.active {
  color: rgb(var(--v-theme-primary));
  background: rgb(var(--v-theme-primary) / 8%);
}

/* Fixed-width cells for alignment */
.toc-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.toc-cell-expand {
  width: 18px;
  cursor: pointer;
  opacity: 0.6;
}

.toc-cell-icon {
  width: 18px;
  opacity: 0.5;
}

/* Level indentation via padding-left on the row */
.toc-level-0 {
  padding-left: 8px;
  font-weight: 600;
}

.toc-level-1 {
  padding-left: 22px;
}

.toc-level-2 {
  padding-left: 36px;
  font-size: 0.68rem;
  opacity: 0.85;
}

.toc-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  margin-left: 4px;
}
</style>
