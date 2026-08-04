<template>
  <div :class="isWorktree ? 'worktree-group' : 'project-group'" :id="folderId">

    <!-- Worktree header -->
    <div v-if="isWorktree" class="worktree-header" :class="{ collapsed }" :id="'ph-' + folderId" @click.self="toggle">
      <span class="worktree-branch-icon" v-html="branchSvg" @click.stop="toggle"></span>
      <span class="worktree-name" @click.stop="toggle">{{ worktreeName }}</span>
      <button class="worktree-hide-btn" data-tooltip="Hide worktree" @click.stop="$emit('remove-project', project.projectPath)" v-html="closeSvg"></button>
      <button class="project-new-btn worktree-new-btn" data-tooltip="New session in worktree" @click.stop="$emit('new-session', project, $event.currentTarget)" v-html="plusSmSvg"></button>
    </div>

    <!-- Project header -->
    <div v-else class="project-header" :class="{ collapsed }" :id="'ph-' + folderId" @click.self="toggle">
      <span class="arrow" @click.stop="toggle">&#9660;</span>
      <ProjectAvatar class="project-header-avatar" :project-path="project.projectPath" @click.stop="toggle" />
      <span class="project-name" @click.stop="toggle">{{ shortName }}</span>
      <button class="project-settings-btn" data-tooltip="Project settings" @click.stop="$emit('settings', project.projectPath)" v-html="gearSvg"></button>
      <button class="project-archive-btn" data-tooltip="Archive all sessions" @click.stop="archiveAll" v-html="archiveSvg"></button>
      <button class="project-new-btn" data-tooltip="New session" @click.stop="$emit('new-session', project, $event.currentTarget)" v-html="plusSvg"></button>
    </div>

    <!-- Sessions list -->
    <div :class="isWorktree ? 'worktree-sessions' : 'project-sessions'" :id="'sessions-' + folderId">

      <template v-for="item in visibleItems" :key="item.type === 'slug' ? 'slug-' + item.slug : item.session.sessionId">
        <SlugGroup
          v-if="item.type === 'slug'"
          :slug="item.slug"
          :sessions="item.sessions"
          :active-pty-ids="activePtyIds"
          :active-session-id="activeSessionId"
          :session-busy-state="sessionBusyState"
          :attention-sessions="attentionSessions"
          :response-ready-sessions="responseReadySessions"
          @open="(s) => $emit('open', s)"
          @stop="(id) => $emit('stop', id)"
          @star="(id) => $emit('star', id)"
          @archive="(id) => $emit('archive', id)"
          @fork="(id) => $emit('fork', id)"
          @jsonl="(id) => $emit('jsonl', id)"
          @launch-config="(id) => $emit('launch-config', id)"
          @rename="(id, name) => $emit('rename', id, name)"
          @archive-all="(sessions) => $emit('archive-sessions', sessions)"
        />
        <SessionItem
          v-else
          :session="item.session"
          :is-active="activeSessionId === item.session.sessionId"
          :is-running="activePtyIds.has(item.session.sessionId)"
          :is-busy="sessionBusyState.get(item.session.sessionId) || false"
          :is-attention="attentionSessions.has(item.session.sessionId)"
          :is-response-ready="responseReadySessions.has(item.session.sessionId)"
          @open="$emit('open', item.session)"
          @stop="$emit('stop', item.session.sessionId)"
          @star="$emit('star', item.session.sessionId)"
          @archive="$emit('archive', item.session.sessionId)"
          @fork="$emit('fork', item.session.sessionId)"
          @jsonl="$emit('jsonl', item.session.sessionId)"
          @launch-config="$emit('launch-config', item.session.sessionId)"
          @rename="(id, name) => $emit('rename', id, name)"
        />
      </template>

      <div
        v-if="olderItems.length > 0"
        class="sessions-more-toggle"
        :class="{ expanded: showOlder }"
        @click="showOlder = !showOlder"
      >
        {{ showOlder ? '- hide older' : `+ ${olderItems.length} older` }}
      </div>

      <template v-if="showOlder">
        <template v-for="item in olderItems" :key="item.type === 'slug' ? 'slug-' + item.slug : item.session.sessionId">
          <SlugGroup
            v-if="item.type === 'slug'"
            :slug="item.slug"
            :sessions="item.sessions"
            :active-pty-ids="activePtyIds"
            :active-session-id="activeSessionId"
            :session-busy-state="sessionBusyState"
            :attention-sessions="attentionSessions"
            :response-ready-sessions="responseReadySessions"
            @open="(s) => $emit('open', s)"
            @stop="(id) => $emit('stop', id)"
            @star="(id) => $emit('star', id)"
            @archive="(id) => $emit('archive', id)"
            @fork="(id) => $emit('fork', id)"
            @jsonl="(id) => $emit('jsonl', id)"
            @launch-config="(id) => $emit('launch-config', id)"
            @rename="(id, name) => $emit('rename', id, name)"
            @archive-all="(sessions) => $emit('archive-sessions', sessions)"
          />
          <SessionItem
            v-else
            :session="item.session"
            :is-active="activeSessionId === item.session.sessionId"
            :is-running="activePtyIds.has(item.session.sessionId)"
            :is-busy="sessionBusyState.get(item.session.sessionId) || false"
            :is-attention="attentionSessions.has(item.session.sessionId)"
            :is-response-ready="responseReadySessions.has(item.session.sessionId)"
            @open="$emit('open', item.session)"
            @stop="$emit('stop', item.session.sessionId)"
            @star="$emit('star', item.session.sessionId)"
            @archive="$emit('archive', item.session.sessionId)"
            @fork="$emit('fork', item.session.sessionId)"
            @jsonl="$emit('jsonl', item.session.sessionId)"
            @launch-config="$emit('launch-config', item.session.sessionId)"
            @rename="(id, name) => $emit('rename', id, name)"
          />
        </template>
      </template>

      <!-- Nested worktree sub-groups -->
      <ProjectGroup
        v-for="wt in worktrees"
        :key="wt.projectPath"
        :project="wt"
        :is-worktree="true"
        :active-pty-ids="activePtyIds"
        :active-session-id="activeSessionId"
        :session-busy-state="sessionBusyState"
        :attention-sessions="attentionSessions"
        :response-ready-sessions="responseReadySessions"
        :search-match-ids="searchMatchIds"
        :show-archived="showArchived"
        :show-starred-only="showStarredOnly"
        :show-running-only="showRunningOnly"
        :show-today-only="showTodayOnly"
        :visible-session-count="visibleSessionCount"
        :session-max-age-days="sessionMaxAgeDays"
        @open="(s) => $emit('open', s)"
        @stop="(id) => $emit('stop', id)"
        @star="(id) => $emit('star', id)"
        @archive="(id) => $emit('archive', id)"
        @fork="(id) => $emit('fork', id)"
        @jsonl="(id) => $emit('jsonl', id)"
        @launch-config="(id) => $emit('launch-config', id)"
        @rename="(id, name) => $emit('rename', id, name)"
        @new-session="(p, btn) => $emit('new-session', p, btn)"
        @settings="(path) => $emit('settings', path)"
        @archive-sessions="(sessions) => $emit('archive-sessions', sessions)"
        @remove-project="(path) => $emit('remove-project', path)"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import SessionItem from './SessionItem.vue';
import SlugGroup from './SlugGroup.vue';
import ProjectAvatar from './ProjectAvatar.vue';

const props = defineProps({
  project: { type: Object, required: true },
  isWorktree: { type: Boolean, default: false },
  activePtyIds: { type: Set, required: true },
  activeSessionId: { type: String, default: null },
  sessionBusyState: { type: Map, required: true },
  attentionSessions: { type: Set, required: true },
  responseReadySessions: { type: Set, required: true },
  searchMatchIds: { type: Set, default: null },
  showArchived: Boolean,
  showStarredOnly: Boolean,
  showRunningOnly: Boolean,
  showTodayOnly: Boolean,
  visibleSessionCount: { type: Number, default: 10 },
  sessionMaxAgeDays: { type: Number, default: 3 },
  worktrees: { type: Array, default: () => [] },
});

const emit = defineEmits([
  'open', 'stop', 'star', 'archive', 'fork', 'jsonl', 'launch-config', 'rename',
  'new-session', 'settings', 'archive-sessions', 'remove-project',
]);

const folderId = computed(() => 'project-' + props.project.projectPath.replace(/[^a-zA-Z0-9_-]/g, '_'));

const avatar = computed(() =>
  window.getProjectAvatar ? window.getProjectAvatar(props.project.projectPath) : { initials: '?', color: '#666' }
);

const shortName = computed(() =>
  props.project.projectPath.split('/').filter(Boolean).slice(-2).join('/')
);

const worktreeName = computed(() => {
  const match = props.project.projectPath.match(/\/\.claude\/worktrees\/([^/]+)\/?$/);
  return match?.[1] || props.project.projectPath.split('/').pop();
});

// Initial collapse state: auto-collapse stale or project-name-only matches
const collapsed = ref(() => {
  if (props.project._projectMatchedOnly) return true;
  if (props.searchMatchIds || props.showStarredOnly || props.showRunningOnly) return false;
  const sessions = props.project.sessions || [];
  if (sessions.length === 0) return false;
  const mostRecent = sessions.reduce((a, b) => new Date(b.modified) > new Date(a.modified) ? b : a);
  return (Date.now() - new Date(mostRecent.modified)) > props.sessionMaxAgeDays * 86400000;
});

function toggle() { collapsed.value = !collapsed.value; }

const showOlder = ref(false);

// Build mixed items list: individual sessions + slug groups
const allItems = computed(() => {
  let sessions = props.project.sessions || [];

  if (!props.showArchived && !props.searchMatchIds) {
    sessions = sessions.filter(s => !s.archived);
  }
  if (props.showStarredOnly) sessions = sessions.filter(s => s.starred);
  if (props.showRunningOnly) sessions = sessions.filter(s => props.activePtyIds.has(s.sessionId));
  if (props.showTodayOnly) {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    sessions = sessions.filter(s => {
      if (!s.modified) return false;
      const d = new Date(s.modified);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
    });
  }
  if (props.searchMatchIds) {
    sessions = sessions.filter(s => props.searchMatchIds.has(s.sessionId));
  }

  // Group by slug
  const slugMap = new Map();
  const ungrouped = [];
  for (const s of sessions) {
    if (s.slug) {
      if (!slugMap.has(s.slug)) slugMap.set(s.slug, []);
      slugMap.get(s.slug).push(s);
    } else {
      ungrouped.push(s);
    }
  }

  const items = [];

  for (const s of ungrouped) {
    const running = props.activePtyIds.has(s.sessionId);
    const sortName = (s.name || s.summary || s.sessionId).toLowerCase();
    const sortTime = new Date(s.modified).getTime();
    items.push({ type: 'session', session: s, sortName, sortTime, pinned: !!s.starred, running });
  }

  for (const [slug, slugSessions] of slugMap) {
    if (slugSessions.length === 1) {
      const s = slugSessions[0];
      const sortName = (s.name || s.summary || s.sessionId).toLowerCase();
      const sortTime = new Date(s.modified).getTime();
      items.push({ type: 'session', session: s, sortName, sortTime, pinned: !!s.starred, running: props.activePtyIds.has(s.sessionId) });
    } else {
      const hasRunning = slugSessions.some(s => props.activePtyIds.has(s.sessionId));
      const hasPinned = slugSessions.some(s => s.starred);
      const mostRecentTime = Math.max(...slugSessions.map(s => new Date(s.modified).getTime()));
      items.push({ type: 'slug', slug, sessions: slugSessions, sortName: slug.toLowerCase(), sortTime: mostRecentTime, pinned: hasPinned, running: hasRunning });
    }
  }

  // Sort: running+pinned > running > pinned > alphabetical (stable, no reordering during active sessions)
  items.sort((a, b) => {
    const aPri = (a.pinned && a.running ? 3 : a.running ? 2 : a.pinned ? 1 : 0);
    const bPri = (b.pinned && b.running ? 3 : b.running ? 2 : b.pinned ? 1 : 0);
    if (aPri !== bPri) return bPri - aPri;
    return a.sortName.localeCompare(b.sortName);
  });

  return items;
});

const visibleItems = computed(() => {
  const anyFilter = props.showStarredOnly || props.showRunningOnly || props.showTodayOnly || props.searchMatchIds;
  if (anyFilter) return allItems.value;
  const ageCutoff = Date.now() - props.sessionMaxAgeDays * 86400000;
  let count = 0;
  return allItems.value.filter(item => {
    if (item.running || item.pinned || (count < props.visibleSessionCount && item.sortTime >= ageCutoff)) {
      count++;
      return true;
    }
    return false;
  });
});

const olderItems = computed(() => {
  const visIds = new Set(visibleItems.value.map(i => i.type === 'slug' ? 'slug-' + i.slug : i.session.sessionId));
  return allItems.value.filter(i => !visIds.has(i.type === 'slug' ? 'slug-' + i.slug : i.session.sessionId));
});

async function archiveAll() {
  emit('archive-sessions', props.project.sessions.filter(s => !s.archived));
}

// SVG icons
const gearSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const archiveSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
const plusSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
const plusSmSvg = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
const closeSvg = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const branchSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></svg>';
</script>
