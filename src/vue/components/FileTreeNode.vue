<template>
  <div class="pv-tree-node">
    <div
      class="pv-tree-row"
      :style="{ paddingLeft: `${depth * 14 + 4}px` }"
      @click="toggle"
      :title="node.path"
    >
      <span class="pv-tree-chevron" v-if="node.isDir">
        <svg v-if="expanded" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        <svg v-else width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </span>
      <span class="pv-tree-chevron pv-tree-file-icon" v-else>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </span>
      <span class="pv-tree-name" :class="{ dir: node.isDir }">{{ node.name }}</span>
    </div>
    <div v-if="node.isDir && expanded">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :search="search"
        @open="$emit('open', $event)"
      />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  search: { type: String, default: '' },
});
const emit = defineEmits(['open']);

const expanded = ref(props.node._expanded ?? false);

function toggle() {
  if (props.node.isDir) {
    expanded.value = !expanded.value;
  } else {
    emit('open', props.node.path);
  }
}
</script>
