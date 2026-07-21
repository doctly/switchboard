<template>
  <div v-if="store.headerSession" class="vue-session-header">
    <div class="vsh-top">
      <div class="vsh-identity">
        <ProjectAvatar class="vsh-avatar" :project-path="session.projectPath" />
        <div class="vsh-info">
          <div class="vsh-title-row">
            <span class="vsh-project-path" :title="session.projectPath">{{ projectShortPath }}</span>
            <span class="vsh-sep">›</span>
            <span class="vsh-session-name" :title="sessionName">{{ sessionName }}</span>
          </div>
          <div class="vsh-status-row">
            <span class="vsh-status-dot" :class="statusClass"></span>
            <span class="vsh-status-label">{{ statusLabel }}</span>
            <template v-if="messageCount">
              <span class="vsh-dot-sep">·</span>
              <span class="vsh-msg-count">{{ messageCount }} msgs</span>
            </template>
            <template v-if="timeStr">
              <span class="vsh-dot-sep">·</span>
              <span class="vsh-time">{{ timeStr }}</span>
            </template>
            <template v-if="sessionId">
              <span class="vsh-dot-sep">·</span>
              <span class="vsh-session-id">{{ shortId }}</span>
            </template>
          </div>
          <div v-if="aiTitle || store.headerPtyTitle" class="vsh-subtitle-row">
            <span v-if="aiTitle" class="vsh-ai-title">{{ aiTitle }}</span>
            <span v-if="store.headerPtyTitle" class="vsh-pty-title">{{ store.headerPtyTitle }}</span>
          </div>
        </div>
      </div>
      <div class="vsh-controls">
        <span v-if="store.headerAccount" class="terminal-account-badge">{{ store.headerAccount }}</span>
        <span v-if="store.headerShellProfile" class="vsh-shell-badge">{{ store.headerShellProfile }}</span>
        <button class="session-stop-btn vsh-stop" data-tooltip="Stop session" @click="stop" v-html="stopSvg"></button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { store } from '../store.js';
import ProjectAvatar from './ProjectAvatar.vue';

const session = computed(() => store.headerSession);
const sessionId = computed(() => session.value?.sessionId);

const projectShortPath = computed(() => {
  const p = session.value?.projectPath || '';
  return p.split('/').filter(Boolean).slice(-2).join('/');
});

const sessionName = computed(() => {
  const s = session.value;
  if (!s) return '';
  const name = s.name || s.summary || 'Session';
  return window.cleanDisplayName ? window.cleanDisplayName(name) : name;
});

const aiTitle = computed(() => {
  const s = session.value;
  if (!s?.aiTitle) return null;
  const cleaned = window.cleanDisplayName ? window.cleanDisplayName(s.aiTitle) : s.aiTitle;
  return cleaned !== sessionName.value ? cleaned : null;
});

const isRunning = computed(() => store.activePtyIds?.has(sessionId.value));
const isBusy = computed(() => store.sessionBusyState?.get(sessionId.value) || false);
const isAttention = computed(() => store.attentionSessions?.has(sessionId.value));

const statusClass = computed(() => ({
  running: isRunning.value,
  busy: isBusy.value,
  attention: isAttention.value,
}));

const statusLabel = computed(() => {
  if (isAttention.value) return 'Needs attention';
  if (isBusy.value) return 'Working…';
  if (isRunning.value) return 'Running';
  return 'Stopped';
});

const messageCount = computed(() => session.value?.messageCount || null);

const timeStr = computed(() => {
  const s = session.value;
  if (!s) return '';
  const t = window.lastActivityTime?.get(s.sessionId) || new Date(s.modified);
  return window.formatDate ? window.formatDate(t) : '';
});

const shortId = computed(() => {
  const id = sessionId.value || '';
  return id.slice(0, 8);
});

function stop() {
  if (sessionId.value && window.confirmAndStopSession) {
    window.confirmAndStopSession(sessionId.value);
  }
}

const stopSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';
</script>
