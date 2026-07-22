import { createApp } from 'vue';
import { store } from '../vue/store.js';
import LandingApp from './LandingApp.vue';
import { MOCK_PROJECTS, MOCK_ACCOUNTS, MOCK_ACTIVE_PTY_IDS, MOCK_PROJECT_INFO, getProjectAvatar } from './mock-data.js';
import '../../public/style.css';

// Stub Electron IPC bridge with no-op async Proxy
window.api = new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'onProjectInfoUpdated') return () => {};
    if (prop === 'getProjectInfo') return async (path) => MOCK_PROJECT_INFO[path] ?? null;
    return async () => null;
  },
});

// Stub globals used by Vue components
window.cleanDisplayName = (name) => (name || '').replace(/\n/g, ' ').trim();
window.lastActivityTime = new Map();
window.getProjectAvatar = getProjectAvatar;

window.formatDate = (date) => {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
};

// Prevent confirm dialogs in the demo (archive/remove prompts)
window.confirm = () => false;

// Populate store with mock data
store.projects = MOCK_PROJECTS;
store.activePtyIds = MOCK_ACTIVE_PTY_IDS;
store.sessionMaxAgeDays = 30;
store.visibleSessionCount = 20;

// Stub bridge globals (App.vue populates these in onMounted — not needed here)
window.__sb = {};
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
window.vueStore = store;

// Expose mock accounts so LandingApp can call setAccounts after mount
window.MOCK_ACCOUNTS = MOCK_ACCOUNTS;

createApp(LandingApp).mount('#landing-app');

// Tooltip system (mirrors public/app.js — runs after mount)
setTimeout(() => {
  const tip = document.getElementById('app-tooltip');
  if (!tip) return;
  let timer = null;
  let activeEl = null;

  function showTip(el) {
    tip.textContent = el.dataset.tooltip;
    tip.style.display = 'block';
    tip.style.opacity = '0';
    const rect = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    let top = rect.bottom + 6;
    if (left < 4) left = 4;
    if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
    if (top + th > window.innerHeight - 4) top = rect.top - th - 6;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.style.opacity = '1';
  }

  function hideTip() {
    clearTimeout(timer);
    tip.style.opacity = '0';
    activeEl = null;
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (el === activeEl) return;
    clearTimeout(timer);
    tip.style.opacity = '0';
    activeEl = el;
    if (!el) return;
    timer = setTimeout(() => showTip(el), 350);
  });

  document.addEventListener('mouseout', (e) => {
    if (!activeEl) return;
    if (!activeEl.contains(e.relatedTarget)) hideTip();
  });

  document.addEventListener('click', hideTip);
  document.addEventListener('scroll', hideTip, true);
}, 100);
