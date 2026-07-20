<template>
  <div>
    <ProjectGroup
      v-for="project in visibleProjects"
      :key="project.projectPath"
      :project="project"
      :worktrees="worktreeMap.get(project.projectPath) || []"
      :active-pty-ids="store.activePtyIds"
      :active-session-id="store.activeSessionId"
      :session-busy-state="store.sessionBusyState"
      :attention-sessions="store.attentionSessions"
      :response-ready-sessions="store.responseReadySessions"
      :search-match-ids="store.searchMatchIds"
      :show-archived="store.showArchived"
      :show-starred-only="store.showStarredOnly"
      :show-running-only="store.showRunningOnly"
      :show-today-only="store.showTodayOnly"
      :visible-session-count="store.visibleSessionCount"
      :session-max-age-days="store.sessionMaxAgeDays"
      @open="onOpen"
      @stop="onStop"
      @star="onStar"
      @archive="onArchive"
      @fork="onFork"
      @jsonl="onJsonl"
      @launch-config="onLaunchConfig"
      @rename="onRename"
      @new-session="onNewSession"
      @settings="onSettings"
      @archive-sessions="onArchiveSessions"
      @remove-project="onRemoveProject"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { store } from '../store.js';
import ProjectGroup from './ProjectGroup.vue';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

const worktreePattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;

const worktreeMap = computed(() => {
  const map = new Map();
  for (const p of store.projects) {
    const match = p.projectPath.match(worktreePattern);
    if (match) {
      const parent = match[1];
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent).push(p);
    }
  }
  return map;
});

const worktreeSet = computed(() => {
  const s = new Set();
  for (const p of store.projects) {
    if (worktreePattern.test(p.projectPath)) s.add(p.projectPath);
  }
  return s;
});

const visibleProjects = computed(() => {
  let projects = store.projects;

  if (store.searchMatchIds !== null) {
    // Search: show all projects that match by session or by project name
    projects = projects
      .map(p => {
        const hasMatchingSessions = p.sessions.some(s => store.searchMatchIds.has(s.sessionId));
        const projectMatched = store.searchMatchProjectPaths?.has(p.projectPath);
        if (!hasMatchingSessions && !projectMatched) return null;
        return {
          ...p,
          sessions: hasMatchingSessions ? p.sessions.filter(s => store.searchMatchIds.has(s.sessionId)) : [],
          _projectMatchedOnly: projectMatched && !hasMatchingSessions,
        };
      })
      .filter(Boolean);
  } else {
    // Default: hide projects with no non-archived sessions
    projects = projects.filter(p => {
      const nonArchived = store.showArchived
        ? p.sessions
        : p.sessions.filter(s => !s.archived);
      return nonArchived.length > 0;
    });
  }

  return projects.filter(p => !worktreeSet.value.has(p.projectPath));
});

function onOpen(session) { props.callbacks.openSession?.(session); }
function onStop(id) { props.callbacks.stopSession?.(id); }
function onStar(id) { props.callbacks.toggleStar?.(id); }
function onArchive(id) { props.callbacks.archiveSession?.(id); }
function onFork(id) { props.callbacks.forkSession?.(id); }
function onJsonl(id) { props.callbacks.showJsonl?.(id); }
function onLaunchConfig(id) { props.callbacks.launchConfig?.(id); }
function onRename(id, name) { props.callbacks.renameSession?.(id, name); }
function onNewSession(project, btn) { props.callbacks.newSession?.(project, btn); }
function onSettings(path) { props.callbacks.openSettings?.(path); }
function onArchiveSessions(sessions) { props.callbacks.archiveSessions?.(sessions); }
function onRemoveProject(path) { props.callbacks.removeProject?.(path); }
</script>
