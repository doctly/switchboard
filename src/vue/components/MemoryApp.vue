<template>
  <div>
    <div v-if="allFiles.length === 0" class="plans-empty">
      No memory files found.
    </div>

    <template v-else>
      <MemoryGroup
        v-if="data.global.files.length > 0"
        group-key="__global__"
        label="Global"
        :files="filteredGlobal"
        :active-file="activeFile"
        @open="openMemory"
      />
      <MemoryGroup
        v-for="proj in filteredProjects"
        :key="proj.folder"
        :group-key="proj.folder"
        :label="proj.shortName"
        :files="proj.files"
        :active-file="activeFile"
        @open="openMemory"
      />
    </template>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import MemoryGroup from './MemoryGroup.vue';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

const data = ref({ global: { files: [] }, projects: [] });
const filterIds = ref(null);
const activeFile = ref(null);

const allFiles = computed(() =>
  [...data.value.global.files, ...data.value.projects.flatMap(p => p.files)]
);

const filteredGlobal = computed(() => {
  if (!filterIds.value) return data.value.global.files;
  return data.value.global.files.filter(f => filterIds.value.has(f.filePath));
});

const filteredProjects = computed(() => {
  return data.value.projects
    .map(proj => ({
      ...proj,
      files: filterIds.value ? proj.files.filter(f => filterIds.value.has(f.filePath)) : proj.files,
    }))
    .filter(proj => proj.files.length > 0);
});

function openMemory(file) {
  activeFile.value = file.filePath;
  props.callbacks.openMemory?.(file);
}

defineExpose({
  setMemories(memData, ids = null) {
    data.value = memData;
    filterIds.value = ids;
  },
  setFilter(ids) { filterIds.value = ids; },
  setActive(filePath) { activeFile.value = filePath; },
  clearActive() { activeFile.value = null; },
});
</script>
