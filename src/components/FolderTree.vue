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
  <ul class="space-y-1 pl-4">
    <li v-for="node in nodes" :key="node.id">
      <label class="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          :checked="isChecked(node.id)"
          :disabled="disabled"
          @change="onToggle(node, $event)"
        >
        <span>{{ node.title || 'Untitled' }}</span>
        <span class="ml-auto text-xs text-gray-600">{{ node.count }}</span>
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
