<template>
  <div
    class="session-item"
    :class="itemClasses"
    :id="'si-' + session.sessionId"
    :data-session-id="session.sessionId"
    @click="$emit('open', session)"
  >
    <div class="session-row">
      <span class="session-status-dot" :class="{ running: isRunning }"></span>

      <div class="session-info">
        <div class="session-summary" @dblclick.stop="startRename">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-if="session.type === 'terminal'" class="terminal-badge" v-html="terminalBadgeSvg"></span>
          <template v-if="renaming">
            <input
              ref="renameInput"
              class="session-rename-input"
              type="text"
              :value="renameValue"
              @blur="saveRename"
              @keydown.enter="saveRename"
              @keydown.esc="cancelRename"
            />
          </template>
          <template v-else>{{ displayName }}</template>
        </div>
        <div v-if="session.aiTitle && !renaming" class="session-subtitle">{{ cleanName(session.aiTitle) }}</div>
        <div class="session-meta">{{ timeStr }}{{ msgSuffix }}</div>
      </div>

      <div class="session-actions">
        <button class="session-stop-btn" data-tooltip="Stop session" @click.stop="$emit('stop', session.sessionId)" v-html="stopSvg"></button>
        <template v-if="session.type !== 'terminal'">
          <button class="session-fork-btn" data-tooltip="Fork session" @click.stop="$emit('fork', session.sessionId)" v-html="forkSvg"></button>
          <button class="session-jsonl-btn" data-tooltip="View messages" @click.stop="$emit('jsonl', session.sessionId)" v-html="jsonlSvg"></button>
          <button class="session-archive-btn" :data-tooltip="session.archived ? 'Unarchive' : 'Archive'" @click.stop="$emit('archive', session.sessionId)" v-html="archiveSvg"></button>
          <button class="session-launch-config-btn" data-tooltip="Resume with config" @click.stop="$emit('launch-config', session.sessionId)" v-html="launchConfigSvg"></button>
        </template>
        <span class="session-pin" :class="{ pinned: session.starred }" @click.stop="$emit('star', session.sessionId)" v-html="pinSvg"></span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, nextTick } from 'vue';

const props = defineProps({
  session: { type: Object, required: true },
  isActive: Boolean,
  isRunning: Boolean,
  isBusy: Boolean,
  isAttention: Boolean,
  isResponseReady: Boolean,
});

const emit = defineEmits(['open', 'stop', 'star', 'archive', 'fork', 'jsonl', 'launch-config', 'rename']);

const renaming = ref(false);
const renameValue = ref('');
const renameInput = ref(null);

const displayName = computed(() => {
  const name = props.session.name || props.session.summary;
  return window.cleanDisplayName ? window.cleanDisplayName(name) : name;
});

const cleanName = (n) => window.cleanDisplayName ? window.cleanDisplayName(n) : n;

const timeStr = computed(() => {
  const t = window.lastActivityTime?.get(props.session.sessionId) || new Date(props.session.modified);
  return window.formatDate ? window.formatDate(t) : '';
});

const msgSuffix = computed(() =>
  props.session.messageCount ? ` · ${props.session.messageCount} msgs` : ''
);

const itemClasses = computed(() => ({
  active: props.isActive,
  'has-running-pty': props.isRunning,
  'cli-busy': props.isBusy,
  'needs-attention': props.isAttention,
  'response-ready': props.isResponseReady,
  'is-pinned': !!props.session.starred,
  'archived-item': !!props.session.archived,
  'is-terminal': props.session.type === 'terminal',
}));

function startRename() {
  renameValue.value = props.session.name || props.session.summary || '';
  renaming.value = true;
  nextTick(() => renameInput.value?.focus());
}

async function saveRename() {
  if (!renaming.value) return;
  renaming.value = false;
  const name = renameInput.value?.value?.trim() ?? null;
  emit('rename', props.session.sessionId, name || null);
}

function cancelRename() {
  renaming.value = false;
}

// SVG icons (inlined to avoid dependency on ICONS global inside template compiler)
const stopSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';
const forkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';
const jsonlSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>';
const archiveSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
const launchConfigSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>';
const terminalBadgeSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
const pinSvg = computed(() => props.session.starred
  ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37.722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002z"/></svg>'
  : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37.722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002z"/></svg>'
);
</script>
