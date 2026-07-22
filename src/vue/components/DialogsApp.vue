<template>
  <!-- New Session Popover -->
  <Teleport to="body">
    <div v-if="popoverProject" ref="popoverEl" class="new-session-popover" :style="popoverStyle">
      <button class="popover-option" @click="popoverClaude">
        <span class="popover-option-icon claude-icon" v-html="CLAUDE_SVG"></span> Claude
      </button>
      <button class="popover-option" @click="popoverClaudeConfig">
        <span class="popover-option-icon claude-icon" v-html="CLAUDE_SVG"></span> Claude (Configure...)
      </button>
      <button class="popover-option popover-option-terminal" @click="popoverTerminal">
        <span class="popover-option-icon terminal-icon" v-html="TERMINAL_SVG"></span> Terminal
      </button>
    </div>
  </Teleport>

  <!-- New Session Dialog -->
  <Teleport to="body">
    <div v-if="newSessionProject" class="new-session-overlay" @mousedown.self="closeNewSession">
      <div class="new-session-dialog">
        <h3>New Session — {{ shortPath(newSessionProject.projectPath) }}</h3>
        <div class="settings-field">
          <div class="settings-label">Permission Mode</div>
          <div class="permission-grid">
            <button
              v-for="m in PERM_MODES" :key="String(m.value)"
              class="permission-option" :class="{ selected: !nsDanger && nsMode === m.value }"
              @click="nsSelectMode(m.value)"
            >
              <span class="perm-name">{{ m.label }}</span>
              <span class="perm-desc">{{ m.desc }}</span>
            </button>
            <button class="permission-option dangerous" :class="{ selected: nsDanger }" @click="nsToggleDanger">
              <span class="perm-name">Dangerous Skip</span>
              <span class="perm-desc">Skip all safety prompts (use with caution)</span>
            </button>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Worktree</span>
            <div class="settings-description">Run session in an isolated git worktree</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" v-model="nsWorktreeName"
              placeholder="name (optional)" style="width:140px" @input="onNsWorktreeInput">
            <SbSwitch v-model="nsWorktree" />
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Chrome</span>
            <div class="settings-description">Enable Chrome browser automation</div>
          </div>
          <div class="settings-field-control">
            <SbSwitch v-model="nsChrome" />
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Pre-launch Command</span>
            <div class="settings-description">Prepended to the claude command</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" v-model="nsPreLaunch"
              placeholder="e.g. aws-vault exec profile --">
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Additional Directories</span>
            <div class="settings-description">Extra directories to include (comma-separated)</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" v-model="nsAddDirs"
              placeholder="/path/to/dir1, /path/to/dir2">
          </div>
        </div>
        <div class="new-session-actions">
          <button class="new-session-cancel-btn" @click="closeNewSession">Cancel</button>
          <button class="btn-green" @click="startNewSession">Start</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Resume Session Dialog -->
  <Teleport to="body">
    <div v-if="resumeSession" class="new-session-overlay" @mousedown.self="closeResumeSession">
      <div class="new-session-dialog">
        <h3>Resume Session — {{ resumeSessionName }}</h3>
        <div class="settings-field">
          <div class="settings-label">Permission Mode</div>
          <div class="permission-grid">
            <button
              v-for="m in PERM_MODES" :key="String(m.value)"
              class="permission-option" :class="{ selected: !rsDanger && rsMode === m.value }"
              @click="rsSelectMode(m.value)"
            >
              <span class="perm-name">{{ m.label }}</span>
              <span class="perm-desc">{{ m.desc }}</span>
            </button>
            <button class="permission-option dangerous" :class="{ selected: rsDanger }" @click="rsToggleDanger">
              <span class="perm-name">Dangerous Skip</span>
              <span class="perm-desc">Skip all safety prompts (use with caution)</span>
            </button>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Chrome</span>
            <div class="settings-description">Enable Chrome browser automation</div>
          </div>
          <div class="settings-field-control">
            <SbSwitch v-model="rsChrome" />
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Pre-launch Command</span>
            <div class="settings-description">Prepended to the claude command</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" v-model="rsPreLaunch"
              placeholder="e.g. aws-vault exec profile --">
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Additional Directories</span>
            <div class="settings-description">Extra directories to include (comma-separated)</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" v-model="rsAddDirs"
              placeholder="/path/to/dir1, /path/to/dir2">
          </div>
        </div>
        <div class="new-session-actions">
          <button class="new-session-cancel-btn" @click="closeResumeSession">Cancel</button>
          <button class="btn-green" @click="doResume">Resume</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Add Project Dialog -->
  <Teleport to="body">
    <div v-if="addProjectOpen" class="add-project-overlay" @mousedown.self="closeAddProject">
      <div class="add-project-dialog">
        <h3>Add Project</h3>
        <div class="add-project-hint">Select a folder to create a new project. To start a session in an existing project, use the + on its project header.</div>
        <div class="folder-input-row">
          <input ref="addPathInputRef" type="text" id="add-project-path" v-model="addProjectPath"
            placeholder="/path/to/project" autocomplete="off" spellcheck="false">
          <button class="add-project-browse-btn" @click="browseProject">Browse</button>
        </div>
        <div class="add-project-error" v-show="addProjectError">{{ addProjectError }}</div>
        <div class="add-project-actions">
          <button class="add-project-cancel-btn" @click="closeAddProject">Cancel</button>
          <button class="add-project-add-btn" @click="doAddProject">Add</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import SbSwitch from './SbSwitch.vue';

const PERM_MODES = [
  { value: null, label: 'Default', desc: 'Prompt for all actions' },
  { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
  { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
  { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
];

const CLAUDE_SVG = '<svg width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg>';
const TERMINAL_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';

// ── Popover ───────────────────────────────────────────────────────
const popoverProject = ref(null);
const popoverEl = ref(null);
const popoverStyle = ref({});
let popoverCbs = {};
let popoverOutsideHandler = null;

async function openPopover(project, anchorEl, cbs) {
  popoverCbs = cbs || {};
  popoverProject.value = project;
  popoverStyle.value = { position: 'fixed', top: '0', left: '-9999px', visibility: 'hidden' };
  await nextTick();
  if (!popoverEl.value) return;
  const pw = popoverEl.value.offsetWidth;
  const ph = popoverEl.value.offsetHeight;
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const top = rect.bottom + 4 + ph > window.innerHeight ? rect.top - ph - 4 : rect.bottom + 4;
    const left = Math.max(8, rect.right - pw);
    popoverStyle.value = { position: 'fixed', top: top + 'px', left: left + 'px' };
  } else {
    popoverStyle.value = {
      position: 'fixed',
      top: Math.max(8, window.innerHeight / 2 - ph / 2) + 'px',
      left: Math.max(8, window.innerWidth / 2 - pw / 2) + 'px',
    };
  }
  setTimeout(() => {
    popoverOutsideHandler = (e) => {
      if (popoverEl.value && !popoverEl.value.contains(e.target) && e.target !== anchorEl) {
        closePopover();
      }
    };
    document.addEventListener('mousedown', popoverOutsideHandler);
  }, 0);
}

function closePopover() {
  popoverProject.value = null;
  if (popoverOutsideHandler) {
    document.removeEventListener('mousedown', popoverOutsideHandler);
    popoverOutsideHandler = null;
  }
}

function popoverClaude() {
  const p = popoverProject.value;
  closePopover();
  popoverCbs.onClaude?.(p);
}
function popoverClaudeConfig() {
  const p = popoverProject.value;
  closePopover();
  popoverCbs.onClaudeConfig?.(p);
}
function popoverTerminal() {
  const p = popoverProject.value;
  closePopover();
  popoverCbs.onTerminal?.(p);
}

// ── New Session Dialog ────────────────────────────────────────────
const newSessionProject = ref(null);
const nsMode = ref(null);
const nsDanger = ref(false);
const nsWorktree = ref(false);
const nsWorktreeName = ref('');
const nsChrome = ref(false);
const nsPreLaunch = ref('');
const nsAddDirs = ref('');
let nsEffective = null;
let nsOnStart = null;

function openNewSession(project, effective, onStart) {
  newSessionProject.value = project;
  nsEffective = effective;
  nsOnStart = onStart;
  nsMode.value = effective.permissionMode || null;
  nsDanger.value = !!effective.dangerouslySkipPermissions;
  nsWorktree.value = !!effective.worktree;
  nsWorktreeName.value = effective.worktreeName || '';
  nsChrome.value = !!effective.chrome;
  nsPreLaunch.value = effective.preLaunchCmd || '';
  nsAddDirs.value = effective.addDirs || '';
}

function closeNewSession() { newSessionProject.value = null; nsOnStart = null; }

function nsSelectMode(mode) { nsDanger.value = false; nsMode.value = mode; }
function nsToggleDanger() { nsDanger.value = !nsDanger.value; if (nsDanger.value) nsMode.value = null; }
function onNsWorktreeInput() { if (nsWorktreeName.value.trim()) nsWorktree.value = true; }

function startNewSession() {
  const options = {};
  if (nsDanger.value) {
    options.dangerouslySkipPermissions = true;
  } else if (nsMode.value) {
    options.permissionMode = nsMode.value;
  }
  if (nsWorktree.value) { options.worktree = true; options.worktreeName = nsWorktreeName.value.trim(); }
  if (nsChrome.value) options.chrome = true;
  if (nsPreLaunch.value.trim()) options.preLaunchCmd = nsPreLaunch.value.trim();
  options.addDirs = nsAddDirs.value.trim();
  if (nsEffective?.mcpEmulation === false) options.mcpEmulation = false;
  const cb = nsOnStart;
  closeNewSession();
  cb?.(options);
}

// ── Resume Session Dialog ─────────────────────────────────────────
const resumeSession = ref(null);
const rsMode = ref(null);
const rsDanger = ref(false);
const rsChrome = ref(false);
const rsPreLaunch = ref('');
const rsAddDirs = ref('');
let rsEffective = null;
let rsOnResume = null;

const resumeSessionName = computed(() => {
  const s = resumeSession.value;
  return s ? (s.name || s.aiTitle || s.summary || s.sessionId?.slice(0, 8) || '') : '';
});

function openResumeSession(session, effective, onResume) {
  resumeSession.value = session;
  rsEffective = effective;
  rsOnResume = onResume;
  rsMode.value = effective.permissionMode || null;
  rsDanger.value = !!effective.dangerouslySkipPermissions;
  rsChrome.value = !!effective.chrome;
  rsPreLaunch.value = effective.preLaunchCmd || '';
  rsAddDirs.value = effective.addDirs || '';
}

function closeResumeSession() { resumeSession.value = null; rsOnResume = null; }

function rsSelectMode(mode) { rsDanger.value = false; rsMode.value = mode; }
function rsToggleDanger() { rsDanger.value = !rsDanger.value; if (rsDanger.value) rsMode.value = null; }

function doResume() {
  const options = {};
  if (rsDanger.value) {
    options.dangerouslySkipPermissions = true;
  } else if (rsMode.value) {
    options.permissionMode = rsMode.value;
  }
  if (rsChrome.value) options.chrome = true;
  if (rsPreLaunch.value.trim()) options.preLaunchCmd = rsPreLaunch.value.trim();
  options.addDirs = rsAddDirs.value.trim();
  if (rsEffective?.mcpEmulation === false) options.mcpEmulation = false;
  const cb = rsOnResume;
  closeResumeSession();
  cb?.(options);
}

// ── Add Project Dialog ────────────────────────────────────────────
const addProjectOpen = ref(false);
const addProjectPath = ref('');
const addProjectError = ref('');
const addPathInputRef = ref(null);
let apOnAdd = null;

async function openAddProject(onAdd) {
  addProjectOpen.value = true;
  addProjectPath.value = '';
  addProjectError.value = '';
  apOnAdd = onAdd;
  await nextTick();
  addPathInputRef.value?.focus();
}

function closeAddProject() { addProjectOpen.value = false; apOnAdd = null; }

async function browseProject() {
  const folder = await window.api.browseFolder();
  if (folder) addProjectPath.value = folder;
}

async function doAddProject() {
  const path = addProjectPath.value.trim();
  if (!path) { addProjectError.value = 'Please enter a folder path.'; return; }
  addProjectError.value = '';
  const result = await window.api.addProject(path);
  if (result.error) { addProjectError.value = result.error; return; }
  const cb = apOnAdd;
  closeAddProject();
  cb?.();
}

// ── Shared helpers ────────────────────────────────────────────────
function shortPath(p) { return (p || '').split('/').filter(Boolean).slice(-2).join('/'); }

function onDocKeydown(e) {
  if (e.key === 'Escape') {
    if (popoverProject.value) { closePopover(); return; }
    if (newSessionProject.value) { closeNewSession(); return; }
    if (resumeSession.value) { closeResumeSession(); return; }
    if (addProjectOpen.value) { closeAddProject(); return; }
  }
  if (e.key === 'Enter' && !e.target.matches('input, select, textarea')) {
    if (newSessionProject.value) { startNewSession(); return; }
    if (resumeSession.value) { doResume(); return; }
    if (addProjectOpen.value) { doAddProject(); return; }
  }
}

onMounted(() => document.addEventListener('keydown', onDocKeydown));
onUnmounted(() => document.removeEventListener('keydown', onDocKeydown));

defineExpose({ openNewSession, openResumeSession, openAddProject, openPopover });
</script>
