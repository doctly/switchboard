<template>
  <div class="slug-group" :class="{ collapsed: !expanded, 'has-promoted': promoted.length > 0 }" :id="groupId">
    <div class="slug-group-header" @click.self="toggle">
      <div class="slug-group-row">
        <span class="slug-group-expand" @click.stop="toggle">
          <span class="arrow">&#9654;</span>
        </span>
        <div class="slug-group-info" @click="toggle">
          <div class="slug-group-name">{{ displayName }}</div>
          <div class="slug-group-meta">
            <span class="slug-group-dot" :class="{ running: hasRunning }"></span>
            <span class="slug-group-count">{{ sessions.length }} sessions</span>
            {{ ' ' + timeStr }}
          </div>
        </div>
        <button class="slug-group-archive-btn" data-tooltip="Archive all sessions in group" @click.stop="archiveAll" v-html="archiveSvg"></button>
      </div>
    </div>

    <div class="slug-group-sessions">
      <SessionItem
        v-for="s in promoted"
        :key="s.sessionId"
        :session="s"
        v-bind="sessionProps(s)"
        @open="$emit('open', s)"
        @stop="$emit('stop', s.sessionId)"
        @star="$emit('star', s.sessionId)"
        @archive="$emit('archive', s.sessionId)"
        @fork="$emit('fork', s.sessionId)"
        @jsonl="$emit('jsonl', s.sessionId)"
        @launch-config="$emit('launch-config', s.sessionId)"
        @rename="(id, name) => $emit('rename', id, name)"
      />

      <template v-if="promoted.length > 0 && rest.length > 0">
        <div class="slug-group-more" :class="{ expanded: showRest }" @click="showRest = !showRest">
          <template v-if="!showRest">+ {{ rest.length }} more</template>
        </div>
        <template v-if="showRest">
          <SessionItem
            v-for="s in rest"
            :key="s.sessionId"
            :session="s"
            v-bind="sessionProps(s)"
            @open="$emit('open', s)"
            @stop="$emit('stop', s.sessionId)"
            @star="$emit('star', s.sessionId)"
            @archive="$emit('archive', s.sessionId)"
            @fork="$emit('fork', s.sessionId)"
            @jsonl="$emit('jsonl', s.sessionId)"
            @launch-config="$emit('launch-config', s.sessionId)"
            @rename="(id, name) => $emit('rename', id, name)"
          />
        </template>
      </template>

      <template v-else>
        <SessionItem
          v-for="s in rest"
          :key="s.sessionId"
          :session="s"
          v-bind="sessionProps(s)"
          @open="$emit('open', s)"
          @stop="$emit('stop', s.sessionId)"
          @star="$emit('star', s.sessionId)"
          @archive="$emit('archive', s.sessionId)"
          @fork="$emit('fork', s.sessionId)"
          @jsonl="$emit('jsonl', s.sessionId)"
          @launch-config="$emit('launch-config', s.sessionId)"
          @rename="(id, name) => $emit('rename', id, name)"
        />
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import SessionItem from './SessionItem.vue';

const props = defineProps({
  slug: { type: String, required: true },
  sessions: { type: Array, required: true },
  activePtyIds: { type: Set, required: true },
  activeSessionId: { type: String, default: null },
  sessionBusyState: { type: Map, required: true },
  attentionSessions: { type: Set, required: true },
  responseReadySessions: { type: Set, required: true },
});

const emit = defineEmits(['open', 'stop', 'star', 'archive', 'fork', 'jsonl', 'launch-config', 'rename', 'archive-all']);

const groupId = computed(() => 'slug-' + props.slug.replace(/[^a-zA-Z0-9_-]/g, '_'));

// Restore expand state from sessionStorage
const storedKey = computed(() => groupId.value);
const expanded = ref((() => {
  try {
    const set = new Set(JSON.parse(sessionStorage.getItem('expandedSlugs') || '[]'));
    return set.has(storedKey.value);
  } catch { return false; }
})());
const showRest = ref(false);

function toggle() {
  expanded.value = !expanded.value;
  try {
    const set = new Set(JSON.parse(sessionStorage.getItem('expandedSlugs') || '[]'));
    if (expanded.value) set.add(storedKey.value); else set.delete(storedKey.value);
    sessionStorage.setItem('expandedSlugs', JSON.stringify([...set]));
  } catch {}
}

const mostRecent = computed(() =>
  props.sessions.reduce((a, b) => {
    const aTime = window.lastActivityTime?.get(a.sessionId) || new Date(a.modified);
    const bTime = window.lastActivityTime?.get(b.sessionId) || new Date(b.modified);
    return bTime > aTime ? b : a;
  })
);

const displayName = computed(() => {
  const s = mostRecent.value;
  const name = s.name || s.summary || props.slug;
  return window.cleanDisplayName ? window.cleanDisplayName(name) : name;
});

const timeStr = computed(() => {
  const t = window.lastActivityTime?.get(mostRecent.value.sessionId) || new Date(mostRecent.value.modified);
  return window.formatDate ? window.formatDate(t) : '';
});

const hasRunning = computed(() => props.sessions.some(s => props.activePtyIds.has(s.sessionId)));

const promoted = computed(() => props.sessions.filter(s => props.activePtyIds.has(s.sessionId)));
const rest = computed(() => props.sessions.filter(s => !props.activePtyIds.has(s.sessionId)));

function sessionProps(s) {
  return {
    isActive: props.activeSessionId === s.sessionId,
    isRunning: props.activePtyIds.has(s.sessionId),
    isBusy: props.sessionBusyState.get(s.sessionId) || false,
    isAttention: props.attentionSessions.has(s.sessionId),
    isResponseReady: props.responseReadySessions.has(s.sessionId),
  };
}

async function archiveAll() {
  emit('archive-all', props.sessions);
}

const archiveSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
</script>
