import { createApp } from 'vue';
import { store } from './store.js';
import App from './components/App.vue';
import ViewerContentApp from './components/ViewerContentApp.vue';

// Expose store for direct mutation from app.js
window.vueStore = store;

// Stub bridge objects — populated by App.vue onMounted (via template refs).
// These run synchronously during app.mount(), before any other script executes.
window.vueSidebar = {
  store,
  setProjects(projects) { store.projects = projects.map(p => ({ ...p })); },
  setActivePtyIds(ids) { store.activePtyIds = new Set(ids); },
  setActiveSession(id) { store.activeSessionId = id; },
  setBusy(sessionId, busy) {
    if (busy) store.sessionBusyState.set(sessionId, true);
    else store.sessionBusyState.delete(sessionId);
  },
  addAttention(sessionId) { store.attentionSessions.add(sessionId); },
  setResponseReady(sessionId) {
    store.responseReadySessions.add(sessionId);
    store.sessionBusyState.delete(sessionId);
  },
  clearNotifications(sessionId) {
    store.attentionSessions.delete(sessionId);
    store.responseReadySessions.delete(sessionId);
  },
  setFilters({ showStarredOnly, showRunningOnly, showTodayOnly, showArchived }) {
    if (showStarredOnly !== undefined) store.showStarredOnly = showStarredOnly;
    if (showRunningOnly !== undefined) store.showRunningOnly = showRunningOnly;
    if (showTodayOnly !== undefined) store.showTodayOnly = showTodayOnly;
    if (showArchived !== undefined) store.showArchived = showArchived;
  },
  setSearch(matchIds, matchProjectPaths) {
    store.searchMatchIds = matchIds;
    store.searchMatchProjectPaths = matchProjectPaths;
  },
  setVisibility(count, ageDays) {
    store.visibleSessionCount = count;
    store.sessionMaxAgeDays = ageDays;
  },
  setHeaderSession(session) { store.headerSession = session; },
  setHeaderPtyTitle(title) { store.headerPtyTitle = title || null; },
  setHeaderShellProfile(profile) { store.headerShellProfile = profile || null; },
  setHeaderAccount(name) { store.headerAccount = name || null; },
  clearHeader() {
    store.headerSession = null;
    store.headerPtyTitle = null;
    store.headerShellProfile = null;
    store.headerAccount = null;
  },
};

// Factory for mounting ViewerContentApp into a plain DOM container (used by file-panel.js)
window.createViewerPanel = function(container, opts = {}) {
  const app = createApp(ViewerContentApp, {
    language: opts.language || 'markdown',
    storageKey: opts.storageKey,
    showCopyPath: !!opts.copyPath,
    showCopyContent: !!opts.copyContent,
    onSave: opts.onSave || null,
    onClose: opts.onClose || null,
  });
  const instance = app.mount(container);
  return {
    open: (...args) => instance.open(...args),
    destroy: () => instance.destroy(),
    getContent: () => instance.getContent(),
  };
};

// Stubs for component bridge APIs — App.vue onMounted fills these in
window.vuePlans = {};
window.vueMemory = {};
window.vueAccounts = {};
window.vueProjects = {};
window.vuePlanViewer = {};
window.vueMemoryViewer = {};
window.vueStatusBar = {};
window.vueAccountDropdown = {};
window.vueGrid = {};
window.vueDialogs = {};

// Mount the single root app (synchronous — all onMounted hooks run before returning)
createApp(App).mount('#app-container');
