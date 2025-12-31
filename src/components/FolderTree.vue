<script setup lang="ts">
import type { PropType } from 'vue'

type FolderNode = {
  id: string
  title: string
  count: number
  children: FolderNode[]
}

defineOptions({
  name: 'FolderTree',
})

const props = defineProps({
  nodes: {
    type: Array as PropType<FolderNode[]>,
    required: true,
  },
  selectedIds: {
    type: Array as PropType<string[]>,
    required: true,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits<{
  (event: 'toggle', node: FolderNode, checked: boolean): void
}>()

function isChecked(id: string) {
  return props.selectedIds.includes(id)
}

function onToggle(node: FolderNode, event: Event) {
  const target = event.target as HTMLInputElement
  emit('toggle', node, target.checked)
}
</script>

<template>
  <ul class="tree">
    <li v-for="node in nodes" :key="node.id" class="tree__item">
      <label class="tree__label" :class="{ 'tree__label--disabled': disabled, 'tree__label--unchecked': !isChecked(node.id) }">
        <input
          type="checkbox"
          :checked="isChecked(node.id)"
          :disabled="disabled"
          class="tree__checkbox"
          @change="onToggle(node, $event)"
        >
        <span class="tree__check">
          <ph-check v-if="isChecked(node.id)" class="tree__check-icon" />
        </span>
        <ph-folder-simple v-if="!isChecked(node.id)" class="tree__folder" />
        <ph-folder-open v-else class="tree__folder tree__folder--open" />
        <span class="tree__title">{{ node.title || 'Untitled' }}</span>
        <span class="tree__count">{{ node.count }}</span>
      </label>
      <FolderTree
        v-if="node.children.length"
        :nodes="node.children"
        :selected-ids="selectedIds"
        :disabled="disabled || !isChecked(node.id)"
        @toggle="(child, checked) => emit('toggle', child, checked)"
      />
    </li>
  </ul>
</template>

<style scoped>
.tree {
  list-style: none;
  margin: 0;
  padding: 0 0 0 12px;
}

.tree:first-child {
  padding-left: 0;
}

.tree__item {
  margin: 0;
}

.tree__label {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 5px;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.15s;
}

.tree__label:hover {
  background: rgba(0, 0, 0, 0.04);
}

@media (prefers-color-scheme: dark) {
  .tree__label:hover {
    background: rgba(255, 255, 255, 0.04);
  }
}

.tree__label--disabled {
  opacity: 0.4;
  pointer-events: none;
}

.tree__label--unchecked .tree__folder,
.tree__label--unchecked .tree__title,
.tree__label--unchecked .tree__count {
  color: #9a918a;
}

@media (prefers-color-scheme: dark) {
  .tree__label--unchecked .tree__folder,
  .tree__label--unchecked .tree__title,
  .tree__label--unchecked .tree__count {
    color: #6a6560;
  }
}

.tree__checkbox {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.tree__check {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  border: 1.5px solid rgba(0, 0, 0, 0.2);
  display: grid;
  place-items: center;
  transition: background 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

@media (prefers-color-scheme: dark) {
  .tree__check {
    border-color: rgba(255, 255, 255, 0.2);
  }
}

.tree__checkbox:checked + .tree__check {
  background: #e85d3b;
  border-color: #e85d3b;
}

@media (prefers-color-scheme: dark) {
  .tree__checkbox:checked + .tree__check {
    background: #ff7a5c;
    border-color: #ff7a5c;
  }
}

.tree__check-icon {
  font-size: 9px;
  color: white;
}

.tree__folder {
  font-size: 12px;
  color: #9a918a;
  flex-shrink: 0;
}

@media (prefers-color-scheme: dark) {
  .tree__folder {
    color: #a09890;
  }
}

.tree__folder--open {
  color: #e85d3b;
}

@media (prefers-color-scheme: dark) {
  .tree__folder--open {
    color: #ff7a5c;
  }
}

.tree__title {
  flex: 1;
  font-size: 11px;
  color: #1a1816;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (prefers-color-scheme: dark) {
  .tree__title {
    color: #f5f3f0;
  }
}

.tree__count {
  font-size: 9px;
  color: #9a918a;
  padding: 1px 4px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 6px;
}

@media (prefers-color-scheme: dark) {
  .tree__count {
    background: rgba(255, 255, 255, 0.08);
    color: #a09890;
  }
}
</style>
