<template>
  <div class="settings-panel">
    <div class="settings-panel-header">
      <span class="settings-panel-title">{{ title }}</span>
    </div>

    <div class="settings-panel-body">
      <div v-if="loading" class="settings-loading">Loading…</div>
      <div v-else class="settings-form">

        <!-- ── Claude CLI Options ───────────────────────────────── -->
        <div class="settings-section">
          <div class="settings-section-title">Claude CLI Options</div>

          <div class="settings-field">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Permission Mode</span>
                <label v-if="isProject" class="settings-use-global">
                  <input type="checkbox" :checked="useGlobal.permissionMode" @change="toggleGlobal('permissionMode', $event.target.checked)" />
                  Use global default
                </label>
              </div>
              <div class="settings-description">Permission mode passed to the <code>claude</code> command</div>
            </div>
            <div class="settings-field-control">
              <select class="settings-select" v-model="form.permissionMode" :disabled="isProject && useGlobal.permissionMode">
                <option value="">Default (none)</option>
                <option value="acceptEdits">Accept Edits</option>
                <option value="plan">Plan Mode</option>
                <option value="dontAsk">Don't Ask</option>
                <option value="bypassPermissions">Bypass</option>
              </select>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Worktree</span>
                <label v-if="isProject" class="settings-use-global">
                  <input type="checkbox" :checked="useGlobal.worktree" @change="toggleGlobal('worktree', $event.target.checked)" />
                  Use global default
                </label>
              </div>
              <div class="settings-description">Enable worktree for new sessions</div>
            </div>
            <div class="settings-field-control">
              <SbSwitch v-model="form.worktree" :disabled="isProject && useGlobal.worktree" />
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Worktree Name</span>
                <label v-if="isProject" class="settings-use-global">
                  <input type="checkbox" :checked="useGlobal.worktreeName" @change="toggleGlobal('worktreeName', $event.target.checked)" />
                  Use global default
                </label>
              </div>
              <div class="settings-description">Custom name for worktree branches</div>
            </div>
            <div class="settings-field-control">
              <input type="text" class="settings-input" v-model="form.worktreeName"
                placeholder="auto" :disabled="isProject && useGlobal.worktreeName" style="width:140px" />
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Chrome</span>
                <label v-if="isProject" class="settings-use-global">
                  <input type="checkbox" :checked="useGlobal.chrome" @change="toggleGlobal('chrome', $event.target.checked)" />
                  Use global default
                </label>
              </div>
              <div class="settings-description">Enable Chrome browser automation</div>
            </div>
            <div class="settings-field-control">
              <SbSwitch v-model="form.chrome" :disabled="isProject && useGlobal.chrome" />
            </div>
          </div>

          <div class="settings-field settings-field-wide">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Additional Directories</span>
                <label v-if="isProject" class="settings-use-global">
                  <input type="checkbox" :checked="useGlobal.addDirs" @change="toggleGlobal('addDirs', $event.target.checked)" />
                  Use global default
                </label>
              </div>
              <div class="settings-description">Extra directories to include in Claude sessions</div>
            </div>
            <div class="settings-field-control">
              <input type="text" class="settings-input" v-model="form.addDirs"
                placeholder="/path/to/dir1, /path/to/dir2" :disabled="isProject && useGlobal.addDirs" />
            </div>
          </div>
        </div>

        <!-- ── Session Launch ──────────────────────────────────── -->
        <div class="settings-section">
          <div class="settings-section-title">Session Launch</div>

          <div class="settings-field settings-field-wide">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Pre-launch Command</span>
                <label v-if="isProject" class="settings-use-global">
                  <input type="checkbox" :checked="useGlobal.preLaunchCmd" @change="toggleGlobal('preLaunchCmd', $event.target.checked)" />
                  Use global default
                </label>
              </div>
              <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
            </div>
            <div class="settings-field-control">
              <input type="text" class="settings-input" v-model="form.preLaunchCmd"
                placeholder="e.g. aws-vault exec profile --" :disabled="isProject && useGlobal.preLaunchCmd" />
            </div>
          </div>
        </div>

        <!-- ── Application (global only) ──────────────────────── -->
        <template v-if="!isProject">
          <div class="settings-section">
            <div class="settings-section-title">Application</div>

            <div class="settings-field">
              <div class="settings-field-info">
                <span class="settings-label">Terminal Theme</span>
                <div class="settings-description">Color theme for terminal sessions</div>
              </div>
              <div class="settings-field-control">
                <select class="settings-select" v-model="form.terminalTheme">
                  <option v-for="(theme, key) in terminalThemes" :key="key" :value="key">{{ theme.label }}</option>
                </select>
              </div>
            </div>

            <div class="settings-field settings-field-wide">
              <div class="settings-field-info">
                <span class="settings-label">Terminal Font</span>
                <div class="settings-description">Monospace font for terminal sessions</div>
              </div>
              <div class="settings-field-control settings-font-control">
                <select class="settings-select" v-model="form.monoFont">
                  <option v-for="(font, key) in terminalFonts" :key="key" :value="key">{{ font.label }}</option>
                </select>
                <span class="settings-font-preview" :style="{ fontFamily: terminalFonts[form.monoFont]?.family }">
                  fn main() { println!("Hello, 世界"); }
                </span>
              </div>
            </div>

            <div class="settings-field settings-field-wide">
              <div class="settings-field-info">
                <span class="settings-label">App Font</span>
                <div class="settings-description">Font for the application interface (sidebar, labels, viewer)</div>
              </div>
              <div class="settings-field-control settings-font-control">
                <select class="settings-select" v-model="form.uiFont">
                  <option v-for="(font, key) in terminalFonts" :key="key" :value="key">{{ font.label }}</option>
                </select>
                <span class="settings-font-preview" :style="{ fontFamily: terminalFonts[form.uiFont]?.family }">
                  Switchboard — 42 sessions
                </span>
              </div>
            </div>

            <div class="settings-field">
              <div class="settings-field-info">
                <span class="settings-label">Shell Profile</span>
                <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
              </div>
              <div class="settings-field-control">
                <select class="settings-select" v-model="form.shellProfile">
                  <option value="auto">Auto (detect)</option>
                  <option v-for="p in shellProfiles" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </div>
            </div>

            <div class="settings-field">
              <div class="settings-field-info">
                <span class="settings-label">Max Visible Sessions</span>
                <div class="settings-description">Show up to this many sessions before collapsing the rest behind "+N older"</div>
              </div>
              <div class="settings-field-control">
                <input type="number" class="settings-input settings-input-compact"
                  v-model.number="form.visibleSessionCount" min="1" max="100" />
              </div>
            </div>

            <div class="settings-field">
              <div class="settings-field-info">
                <span class="settings-label">Session Max Age (days)</span>
                <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
              </div>
              <div class="settings-field-control">
                <input type="number" class="settings-input settings-input-compact"
                  v-model.number="form.sessionMaxAgeDays" min="1" max="365" />
              </div>
            </div>

            <div class="settings-field">
              <div class="settings-field-info">
                <span class="settings-label">IDE Emulation</span>
                <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
              </div>
              <div class="settings-field-control">
                <SbSwitch v-model="form.mcpEmulation" />
              </div>
            </div>

            <div class="settings-field">
              <div class="settings-field-info">
                <span class="settings-label">Show Avatars</span>
                <div class="settings-description">Show project initials avatars on session groups and grid cards</div>
              </div>
              <div class="settings-field-control">
                <SbSwitch v-model="form.showAvatars" />
              </div>
            </div>
          </div>

          <!-- ── Git ───────────────────────────────────────────── -->
          <div class="settings-section">
            <div class="settings-section-title">Git</div>
            <div class="settings-field settings-field--column">
              <div class="settings-field-info">
                <span class="settings-label">Commit Message Prompt</span>
                <div class="settings-description">Instruction sent to Claude CLI when generating a commit message. The git diff is appended automatically. Leave empty to use the default.</div>
              </div>
              <div class="settings-field-control settings-field-control--full">
                <textarea
                  class="settings-textarea"
                  v-model="form.commitMessagePrompt"
                  placeholder="Enter prompt…"
                  rows="5"
                ></textarea>
                <button class="settings-reset-btn" @click="form.commitMessagePrompt = ''" v-if="form.commitMessagePrompt">Reset to default</button>
              </div>
            </div>
          </div>

          <!-- ── Integrations ──────────────────────────────────────── -->
          <div class="settings-section">
            <div class="settings-section-title">Integrations</div>
            <div class="settings-field">
              <div class="settings-field-info">
                <span class="settings-label">GitLab Token</span>
                <div class="settings-description">Personal access token for GitLab API (read_api scope). Used for downloading project avatars.</div>
              </div>
              <div class="settings-field-control">
                <input
                  type="password"
                  class="settings-input"
                  v-model="form.gitlabToken"
                  placeholder="glpat-…"
                  autocomplete="off"
                >
              </div>
            </div>
          </div>

          <!-- ── Updates ────────────────────────────────────────── -->
          <div class="settings-section">
            <div class="settings-section-title">Updates</div>
            <div class="settings-field">
              <div class="settings-field-info">
                <span class="settings-label">Version</span>
                <div class="settings-description">
                  <span v-if="appVersion">v{{ appVersion }}</span>
                  <span v-if="updateStatus" class="settings-update-status"> — {{ updateStatus }}</span>
                  <a
                    v-if="newVersion"
                    class="settings-update-link"
                    href="#"
                    @click.prevent="window.api.openExternal('https://github.com/fortael/switchboard/releases/latest')"
                  >Download v{{ newVersion }} ↗</a>
                </div>
              </div>
              <div class="settings-field-control">
                <SbButton variant="secondary" size="sm" @click="checkUpdates">Check for Updates</SbButton>
              </div>
            </div>
          </div>
        </template>

        <!-- ── Action buttons ─────────────────────────────────── -->
        <div class="settings-btn-row">
          <SbButton variant="secondary" size="sm" @click="close">Cancel</SbButton>
          <SbButton :variant="'primary'" size="sm" @click="save" :disabled="saveState === 'saved'">
            {{ saveState === 'saved' ? '✓ Saved' : 'Save Settings' }}
          </SbButton>
          <SbButton v-if="isProject" variant="danger" size="sm" @click="removeProject">Hide Project</SbButton>
          <span v-if="ideNotice" class="settings-notice">{{ ideNotice }}</span>
        </div>

      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { store } from '../store.js';
import SbSwitch from './SbSwitch.vue';
import SbButton from './SbButton.vue';

// ── Derived from store ────────────────────────────────────────────
const isProject = computed(() => store.settingsScope === 'project');
const projectPath = computed(() => store.settingsProjectPath);
const settingsKey = computed(() => isProject.value ? 'project:' + projectPath.value : 'global');
const title = computed(() => {
  const shortName = isProject.value
    ? (projectPath.value?.split('/').filter(Boolean).slice(-2).join('/') || projectPath.value)
    : 'Global';
  return (isProject.value ? 'Project Settings — ' : 'Global Settings — ') + shortName;
});

// ── Local state ───────────────────────────────────────────────────
const loading = ref(true);
const saveState = ref('idle'); // 'idle' | 'saved'
const ideNotice = ref('');
const appVersion = ref('');
const updateStatus = ref('');
const newVersion = ref('');
const shellProfiles = ref([]);
const terminalThemes = computed(() => window.TERMINAL_THEMES || {});
const terminalFonts = computed(() => window.TERMINAL_FONTS || {});

const COMMIT_MSG_PROMPT_DEFAULT = `Write a concise git commit message (max 72 chars for first line) for these changes. Use conventional commit format (feat/fix/refactor/docs/chore). Output ONLY the commit message, no explanation:`;
const commitMsgPromptDefault = COMMIT_MSG_PROMPT_DEFAULT;

const form = reactive({
  permissionMode: '',
  worktree: false,
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 10,
  sessionMaxAgeDays: 3,
  terminalTheme: 'switchboard',
  mcpEmulation: true,
  shellProfile: 'auto',
  showAvatars: true,
  monoFont: 'default',
  uiFont: 'default',
  commitMessagePrompt: '',
  gitlabToken: '',
});

const useGlobal = reactive({
  permissionMode: true,
  worktree: true,
  worktreeName: true,
  chrome: true,
  preLaunchCmd: true,
  addDirs: true,
});

let originalMcpEmulation = true;

// ── Helpers ───────────────────────────────────────────────────────
function effectiveValue(current, global, field, fallback) {
  if (isProject.value && (current[field] === undefined || current[field] === null)) {
    return global[field] !== undefined ? global[field] : fallback;
  }
  return current[field] !== undefined ? current[field] : fallback;
}

function isUsingGlobal(current, field) {
  return current[field] === undefined || current[field] === null;
}

// ── Load settings ─────────────────────────────────────────────────
async function loadSettings() {
  loading.value = true;
  const current = (await window.api.getSetting(settingsKey.value)) || {};
  const global = isProject.value ? ((await window.api.getSetting('global')) || {}) : {};

  const overrideFields = ['permissionMode', 'worktree', 'worktreeName', 'chrome', 'preLaunchCmd', 'addDirs'];
  for (const field of overrideFields) {
    if (isProject.value) {
      useGlobal[field] = isUsingGlobal(current, field);
    }
    form[field] = effectiveValue(current, global, field, getDefault(field));
  }

  if (!isProject.value) {
    form.visibleSessionCount = current.visibleSessionCount ?? 10;
    form.sessionMaxAgeDays = current.sessionMaxAgeDays ?? 3;
    form.terminalTheme = current.terminalTheme ?? 'switchboard';
    form.mcpEmulation = current.mcpEmulation !== false;
    form.shellProfile = current.shellProfile ?? 'auto';
    form.showAvatars = current.showAvatars !== false;
    form.monoFont = current.monoFont ?? 'default';
    form.uiFont = current.uiFont ?? 'default';
    form.commitMessagePrompt = current.commitMessagePrompt || COMMIT_MSG_PROMPT_DEFAULT;
    form.gitlabToken = current.gitlabToken || '';
    originalMcpEmulation = form.mcpEmulation;

    try { shellProfiles.value = await window.api.getShellProfiles(); } catch { shellProfiles.value = []; }
    window.api.getAppVersion().then(v => { appVersion.value = v; });
  }

  loading.value = false;
}

function getDefault(field) {
  const defaults = { permissionMode: '', worktree: false, worktreeName: '', chrome: false, preLaunchCmd: '', addDirs: '' };
  return defaults[field];
}

// ── "Use global" toggle ───────────────────────────────────────────
function toggleGlobal(field, checked) {
  useGlobal[field] = checked;
}

// ── Save ──────────────────────────────────────────────────────────
async function save() {
  let settings = {};

  if (isProject.value) {
    const overrideFields = ['permissionMode', 'worktree', 'worktreeName', 'chrome', 'preLaunchCmd', 'addDirs'];
    for (const field of overrideFields) {
      if (!useGlobal[field]) {
        settings[field] = form[field];
      }
    }
  } else {
    const existing = (await window.api.getSetting('global')) || {};
    settings = {
      ...existing,
      permissionMode: form.permissionMode || null,
      worktree: form.worktree,
      worktreeName: form.worktreeName,
      chrome: form.chrome,
      preLaunchCmd: form.preLaunchCmd,
      addDirs: form.addDirs,
      visibleSessionCount: form.visibleSessionCount || 10,
      sessionMaxAgeDays: form.sessionMaxAgeDays || 3,
      terminalTheme: form.terminalTheme || 'switchboard',
      mcpEmulation: form.mcpEmulation,
      shellProfile: form.shellProfile || 'auto',
      showAvatars: form.showAvatars,
      monoFont: form.monoFont || 'default',
      uiFont: form.uiFont || 'default',
      commitMessagePrompt: form.commitMessagePrompt === COMMIT_MSG_PROMPT_DEFAULT ? '' : (form.commitMessagePrompt || ''),
      gitlabToken: form.gitlabToken || '',
    };
  }

  await window.api.setSetting(settingsKey.value, settings);

  if (!isProject.value) {
    window._setVisibleSessionCount?.(settings.visibleSessionCount);
    window._setSessionMaxAge?.(settings.sessionMaxAgeDays);
    window._applyTerminalTheme?.(settings.terminalTheme);
    window._setShowAvatars?.(settings.showAvatars);
    if (window.TERMINAL_FONTS?.[settings.monoFont]) {
      window._applyTerminalFont?.(window.TERMINAL_FONTS[settings.monoFont].family);
    }
    window._applyUiFont?.(settings.uiFont);
    if (typeof refreshSidebar === 'function') refreshSidebar();

    if (settings.mcpEmulation !== originalMcpEmulation) {
      ideNotice.value = 'IDE Emulation setting changed. New sessions will use the updated setting — running sessions are not affected.';
      setTimeout(() => { ideNotice.value = ''; }, 8000);
    }
  }

  saveState.value = 'saved';
  setTimeout(() => close(), 600);
}

// ── Close ─────────────────────────────────────────────────────────
function close() {
  store.settingsOpen = false;
  window._restoreAfterSettings?.();
}

// ── Remove project ────────────────────────────────────────────────
async function removeProject() {
  const shortName = projectPath.value?.split('/').filter(Boolean).slice(-2).join('/') || projectPath.value;
  if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
  await window.api.removeProject(projectPath.value);
  store.settingsOpen = false;
  if (typeof loadProjects === 'function') loadProjects();
}

// ── Updates ───────────────────────────────────────────────────────
function checkUpdates() { window.api.updaterCheck(); }

// ── Lifecycle ─────────────────────────────────────────────────────
onMounted(async () => {
  await loadSettings();
  if (!isProject.value) {
    window.api.onUpdaterEvent((type, data) => {
      switch (type) {
        case 'checking': updateStatus.value = 'checking…'; newVersion.value = ''; break;
        case 'update-available': updateStatus.value = `v${data.version} available`; newVersion.value = data.version; break;
        case 'update-not-available': updateStatus.value = 'up to date'; newVersion.value = ''; break;
        case 'error': updateStatus.value = 'check failed'; newVersion.value = ''; break;
      }
    });
  }
});
</script>
