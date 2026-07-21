<template>
  <div class="project-group" :class="{ collapsed }">
    <div class="project-header" @click="toggle">
      <span class="arrow">&#9660;</span>
      <ProjectAvatar v-if="projectPath" class="project-header-avatar" :project-path="projectPath" />
      <span class="project-name">{{ label }}</span>
      <span class="memory-file-count">{{ files.length }}</span>
    </div>
    <div class="project-sessions">
      <ListItem
        v-for="file in files"
        :key="file.filePath"
        :title="file.filename"
        :subtitle="file.displayPath"
        :meta="fmtDate(file.modified)"
        :active="activeFile === file.filePath"
        :classes="['memory-item']"
        :item-id="'mf-' + file.filePath.replace(/[^a-zA-Z0-9]/g, '_')"
        @click="$emit('open', file)"
      >
        <template #leading>
          <span
            :class="isSchedule(file) ? 'memory-schedule-icon' : 'memory-brain-icon'"
            v-html="isSchedule(file) ? scheduleSvg : brainSvg"
          ></span>
        </template>
        <template #trailing>
          <button
            v-if="isSchedule(file)"
            class="schedule-play-btn"
            :class="{ running: runningFile === file.filePath, done: doneFile === file.filePath }"
            title="Run now"
            @click.stop="runSchedule(file)"
            v-html="playIcon(file)"
          ></button>
        </template>
      </ListItem>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import ListItem from './ListItem.vue';
import ProjectAvatar from './ProjectAvatar.vue';

const props = defineProps({
  groupKey: { type: String, required: true },
  label: { type: String, required: true },
  files: { type: Array, required: true },
  activeFile: { type: String, default: null },
  projectPath: { type: String, default: null },
});

const emit = defineEmits(['open']);

const collapsed = ref(false);

function toggle() { collapsed.value = !collapsed.value; }
function fmtDate(d) { return window.formatDate ? window.formatDate(new Date(d)) : d; }
function isSchedule(f) { return f.filename.startsWith('schedule-'); }

const runningFile = ref(null);
const doneFile = ref(null);

async function runSchedule(file) {
  runningFile.value = file.filePath;
  const result = await window.api.runScheduleNow(file.filePath);
  runningFile.value = null;
  doneFile.value = file.filePath;
  setTimeout(() => { doneFile.value = null; }, 2000);
  if (result && !result.ok) console.error('Schedule run failed:', result.error);
}

function playIcon(file) {
  if (runningFile.value === file.filePath) return spinnerSvg;
  if (doneFile.value === file.filePath) return checkSvg;
  return playSvg;
}

const brainSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>';
const scheduleSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const playSvg = '<svg width="12" height="12" viewBox="0 0 384 512" fill="currentColor"><path d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80L0 432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"/></svg>';
const spinnerSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
const checkSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
</script>
