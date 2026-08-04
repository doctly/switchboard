<template>
  <div>
    <div class="project-group">
      <div class="project-header">
        <span class="project-name">Projects ({{ filteredProjects.length }})</span>
        <button class="project-new-btn" data-tooltip="Add" @click="callbacks.addProject?.()">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/>
          </svg>
        </button>
        <div class="projects-sort-wrap">
          <button
            v-for="[key, label] in sortOptions"
            :key="key"
            class="projects-sort-btn"
            :class="{ active: sortOrder === key }"
            @click="sortOrder = key"
          >{{ label }}</button>
          <button
            class="projects-sort-btn"
            :class="{ active: showContainers }"
            @click="showContainers = !showContainers"
            title="Toggle container visibility"
          >Containers</button>
        </div>
      </div>
      <div class="project-sessions">
        <div v-if="filteredProjects.length === 0" class="projects-empty-hint">
          {{ searchQuery ? 'No matching projects.' : 'No projects yet. Click Add to select a folder.' }}
        </div>
        <div
          v-for="project in filteredProjects"
          :key="project.projectPath"
          class="session-item project-item"
          :class="{ active: project.projectPath === activeProjectPath, syncing: loadingPaths.has(project.projectPath) }"
          @click="openProject(project)"
        >
          <div class="session-row">
            <ProjectAvatar class="project-card-avatar" :project-path="project.projectPath" />
            <div class="session-info">
              <div class="session-summary">
                <span class="project-item-name">{{ projectName(project) }}</span>
                <span v-if="projectInfo[project.projectPath]?.unpushedCount ?? project.unpushedCount" class="project-unpushed-badge">{{ projectInfo[project.projectPath]?.unpushedCount ?? project.unpushedCount }}</span>
                <span v-if="loadingPaths.has(project.projectPath)" class="project-syncing-dot"></span>
              </div>
              <div class="session-subtitle" :title="project.projectPath">{{ project.projectPath }}</div>
              <div class="session-meta">{{ baseMeta(project) }}</div>
              <div v-if="projectInfo[project.projectPath]?.branch" class="session-meta project-branch-meta">
                <span class="project-env-branch-icon">⎇</span>
                {{ projectInfo[project.projectPath].branch }}
                <span v-if="projectInfo[project.projectPath].added" class="project-env-added">+{{ projectInfo[project.projectPath].added }}</span>
                <span v-if="projectInfo[project.projectPath].deleted" class="project-env-deleted">−{{ projectInfo[project.projectPath].deleted }}</span>
              </div>
              <div v-if="showContainers && projectInfo[project.projectPath]?.containers?.length" class="project-card-env">
                <div class="project-env-containers-box">
                  <div class="project-env-containers-hdr">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-4 0v2M8 7V5a2 2 0 0 0-4 0v2"/></svg>
                    CONTAINERS · {{ projectInfo[project.projectPath].containers.length }}
                  </div>
                  <div
                    v-for="c in projectInfo[project.projectPath].containers"
                    :key="c.name"
                    class="project-env-container-row"
                  >
                    <span
                      class="project-env-dot"
                      :class="{
                        running: c.state.includes('running'),
                        starting: !c.state.includes('running') && (c.state.includes('starting') || c.status?.toLowerCase().includes('starting'))
                      }"
                    ></span>
                    <span class="project-env-cname">{{ c.name }}</span>
                    <span class="project-env-cuptime">{{ parseUptime(c.status) }}</span>
                    <span
                      v-if="!c.state.includes('running') && c.state && c.state !== 'exited'"
                      class="project-env-cbadge"
                      :class="{ starting: c.state.includes('starting') || c.status?.toLowerCase().includes('starting') }"
                    >{{ c.state }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="project-card-actions" @click.stop>
              <button
                class="project-card-new-btn"
                data-tooltip="New session"
                @click.stop="callbacks.newSession?.(project, $event.currentTarget)"
              >
                <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/>
                </svg>
              </button>
              <button
                class="project-card-del-btn"
                data-tooltip="Remove project"
                @click.stop="removeProject(project)"
                v-html="trashSvg"
              ></button>
            </div>
          </div>
        </div>
      </div>
      <div class="projects-add-row">
        <button class="projects-add-btn" @click="callbacks.addProject?.()">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/>
          </svg>
          Add project
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import ProjectAvatar from './ProjectAvatar.vue';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

const projects = ref([]);
const searchQuery = ref('');
const sortOrder = ref('name');
const showContainers = ref(true);
const projectInfo = reactive({});
const loadingPaths = reactive(new Set());
const activeProjectPath = ref(null);
const sortOptions = [['name', 'Name'], ['changes', 'Changes']];

let queueGen = 0;

// Batch reactive updates into one rAF flush to avoid per-project re-renders
let pendingInfoUpdates = {};
let flushScheduled = false;
function scheduleInfoFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    for (const [path, info] of Object.entries(pendingInfoUpdates)) {
      projectInfo[path] = projectInfo[path] ? { ...projectInfo[path], ...info } : info;
      loadingPaths.delete(path);
    }
    pendingInfoUpdates = {};
  });
}

const WORKTREE_RE = /\/\.claude\/worktrees\/[^/]+\/?$/;

const filteredProjects = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const base = projects.value.filter(p => !WORKTREE_RE.test(p.projectPath));
  let list = q
    ? base.filter(p => {
        const name = p.projectPath.split('/').filter(Boolean).pop() || '';
        return name.toLowerCase().includes(q) || p.projectPath.toLowerCase().includes(q);
      })
    : [...base];

  if (sortOrder.value === 'name') {
    list.sort((a, b) => {
      const na = a.projectPath.split('/').filter(Boolean).pop() || '';
      const nb = b.projectPath.split('/').filter(Boolean).pop() || '';
      return na.localeCompare(nb);
    });
  } else {
    list.sort((a, b) => {
      const ia = projectInfo[a.projectPath];
      const ib = projectInfo[b.projectPath];
      const sa = (ia?.added || 0) + (ia?.deleted || 0);
      const sb = (ib?.added || 0) + (ib?.deleted || 0);
      return sb - sa;
    });
  }
  return list;
});

function projectName(p) {
  return p.projectPath.split('/').filter(Boolean).pop() || p.projectPath;
}


function baseMeta(p) {
  const n = p.sessions.length;
  const last = p.sessions[0];
  const activity = last
    ? (window.formatDate ? window.formatDate(new Date(last.modified)) : last.modified)
    : '—';
  const info = projectInfo[p.projectPath];
  const size = info?.sizeMb != null ? ` · ${info.sizeMb} MB` : '';
  return `${n} session${n !== 1 ? 's' : ''} · ${activity}${size}`;
}

function parseUptime(status) {
  return window.parseContainerUptime ? window.parseContainerUptime(status) : '';
}

function openProject(project) {
  activeProjectPath.value = project.projectPath;
  props.callbacks.openProject?.(project);
}

async function removeProject(project) {
  const name = project.projectPath.split('/').pop();
  if (!confirm(`Remove "${name}" from the project list?\n\nSession files are not deleted.`)) return;
  await window.api.removeProject(project.projectPath);
  props.callbacks.projectRemoved?.();
}

async function runInfoQueue(gen, list) {
  for (const project of list) {
    if (queueGen !== gen) break;
    if (projectInfo[project.projectPath]) continue; // already loaded, skip
    loadingPaths.add(project.projectPath);
    try {
      const info = await window.api.getProjectInfo(project.projectPath);
      if (queueGen !== gen) break;
      if (info) {
        pendingInfoUpdates[project.projectPath] = info;
        scheduleInfoFlush();
      } else {
        loadingPaths.delete(project.projectPath);
      }
    } catch {
      loadingPaths.delete(project.projectPath);
    }
  }
}

onMounted(() => {
  window.api.onProjectInfoLoading?.((path) => {
    loadingPaths.add(path);
  });
  window.api.onProjectInfoUpdated?.((path, info) => {
    if (info) {
      pendingInfoUpdates[path] = info;
      scheduleInfoFlush();
    } else {
      loadingPaths.delete(path);
    }
  });
});

defineExpose({
  setProjects(list) {
    projects.value = list;
    queueGen++;
    runInfoQueue(queueGen, list);
  },
  setSearch(q) { searchQuery.value = q || ''; },
  clearActive() { activeProjectPath.value = null; },
  updateProjectInfo(path, info) {
    if (info) {
      pendingInfoUpdates[path] = info;
      scheduleInfoFlush();
    }
  },
});

const trashSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
</script>
