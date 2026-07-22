<template>
  <div class="lp-root">

    <!-- ── HERO ───────────────────────────────────────────────── -->
    <header class="lp-hero">
      <div class="lp-hero-inner">
        <img class="lp-logo" :src="iconUrl" alt="Switchboard icon" width="72" height="72">
        <h1 class="lp-title">Switchboard</h1>
        <p class="lp-tagline">The session manager for Claude Code</p>
        <div class="lp-cta">
          <a class="lp-btn-primary" href="https://github.com/fortael/switchboard/releases" target="_blank" rel="noopener">
            Download
          </a>
          <a class="lp-btn-secondary" href="https://github.com/fortael/switchboard" target="_blank" rel="noopener">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            GitHub
          </a>
        </div>
        <div class="lp-platforms">
          <span>macOS</span><span>·</span><span>Linux</span><span>·</span><span>Windows</span>
        </div>
      </div>
    </header>

    <!-- ── INTERACTIVE DEMO ──────────────────────────────────── -->
    <section class="lp-demo-section">
      <div class="lp-section-inner">
        <h2 class="lp-section-title">Try the real interface</h2>
        <p class="lp-section-subtitle">This is the actual Switchboard UI — powered by the real Vue components, with mock data. Click the tabs, browse sessions, switch views.</p>

        <div class="lp-app-window">
          <!-- macOS-style title bar -->
          <div class="lp-titlebar">
            <div class="lp-traffic-lights">
              <span class="lp-tl lp-tl-close"></span>
              <span class="lp-tl lp-tl-min"></span>
              <span class="lp-tl lp-tl-max"></span>
            </div>
            <span class="lp-titlebar-name">Switchboard</span>
          </div>

          <!-- App body -->
          <div class="lp-app-body">

            <!-- Sidebar (reuses real CSS IDs from style.css) -->
            <div id="sidebar">

              <!-- Account dropdown -->
              <div id="account-selector">
                <AccountDropdownApp ref="accountDropdownRef" :callbacks="demoCallbacks" />
              </div>

              <!-- Tab bar -->
              <div id="sidebar-header">
                <div id="sidebar-tabs">
                  <button
                    v-for="tab in DEMO_TABS"
                    :key="tab.id"
                    class="sidebar-tab"
                    :class="{ active: store.activeTab === tab.id }"
                    :data-tooltip="tab.label"
                    @click="setTab(tab.id)"
                    v-html="tab.svg"
                  ></button>
                </div>
                <div id="session-filters" v-show="store.activeTab === 'sessions'">
                  <button id="running-toggle" :class="{ active: store.showRunningOnly }" data-tooltip="Show running only" @click="store.showRunningOnly = !store.showRunningOnly"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4"/></svg></button>
                  <button id="star-toggle" :class="{ active: store.showStarredOnly }" data-tooltip="Show pinned only" @click="store.showStarredOnly = !store.showStarredOnly"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37.722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg></button>
                  <button id="today-toggle" :class="{ active: store.showTodayOnly }" data-tooltip="Show today's sessions only" @click="store.showTodayOnly = !store.showTodayOnly"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2v-12z"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M4 11h16"/><path d="M11 15h1"/><path d="M12 15v3"/></svg></button>
                  <button id="archive-toggle" :class="{ active: store.showArchived }" data-tooltip="Show archived sessions" @click="store.showArchived = !store.showArchived"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="m21.706 5.292-2.999-2.999A.996.996 0 0 0 18 2H6a.996.996 0 0 0-.707.293L2.294 5.292A.994.994 0 0 0 2 6v13c0 1.103.897 2 2 2h16c1.103 0 2-.897 2-2V6a.994.994 0 0 0-.294-.708zM6.414 4h11.172l1 1H5.414l1-1zM4 19V7h16l.002 12H4z"/><path d="M14 9h-4v3H7l5 5 5-5h-3z"/></svg></button>
                  <button id="grid-toggle-btn" :class="{ active: store.gridViewActive }" data-tooltip="Session overview" @click="store.gridViewActive = !store.gridViewActive"><svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg></button>
                  <button id="resort-btn" data-tooltip="Re-sort sessions"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></button>
                  <button id="add-project-btn" data-tooltip="Add project"><svg width="14" height="14" viewBox="0 0 512 512" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M512 416c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96C0 60.7 28.7 32 64 32l128 0c20.1 0 39.1 9.5 51.2 25.6l19.2 25.6c6 8.1 15.5 12.8 25.6 12.8l160 0c35.3 0 64 28.7 64 64l0 256zM232 376c0 13.3 10.7 24 24 24s24-10.7 24-24l0-64 64 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-64 0 0-64c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 64-64 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l64 0 0 64z"/></svg></button>
                </div>
              </div>

              <!-- Search bar -->
              <div id="search-bar">
                <input id="search-input" type="text" placeholder="Search sessions..." readonly style="pointer-events:none;" />
              </div>

              <!-- Sessions panel -->
              <div id="sidebar-content" v-show="store.activeTab === 'sessions'">
                <SidebarApp :callbacks="demoCallbacks" />
              </div>

              <!-- Projects panel -->
              <div id="projects-content" v-show="store.activeTab === 'projects'">
                <ProjectsApp ref="projectsRef" :callbacks="demoCallbacks" />
              </div>

              <!-- Accounts panel -->
              <div id="accounts-content" v-show="store.activeTab === 'accounts'">
                <AccountsApp ref="accountsRef" :callbacks="demoCallbacks" />
              </div>

              <!-- Plans panel -->
              <div id="plans-content" v-show="store.activeTab === 'plans'">
                <PlansApp ref="plansRef" :callbacks="demoCallbacks" />
              </div>

              <!-- Memory panel -->
              <div id="memory-content" v-show="store.activeTab === 'memory'">
                <MemoryApp ref="memoryRef" :callbacks="demoCallbacks" />
              </div>

              <!-- Stats / other placeholder -->
              <div v-show="!['sessions','projects','accounts','plans','memory'].includes(store.activeTab)" class="lp-demo-empty-tab">
                <div class="plans-empty">No data in demo mode.</div>
              </div>

            </div>

            <!-- Resize handle visual -->
            <div id="sidebar-resize-handle" style="pointer-events:none;"></div>

            <!-- Main area -->
            <div id="main">
              <div v-if="!activeSession" id="placeholder" style="display:flex;">
                <p>Click a session from the sidebar to see it here.</p>
              </div>

              <div v-else class="lp-terminal-area">
                <div class="lp-terminal-header">
                  <div class="lp-terminal-header-info">
                    <span class="lp-terminal-name">{{ displayName(activeSession) }}</span>
                    <span class="lp-terminal-id">{{ activeSession.sessionId }}</span>
                  </div>
                  <div class="lp-terminal-status">
                    <span v-if="isRunning(activeSession)" class="lp-status-running">
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4"/></svg>
                      Running
                    </span>
                    <span v-else class="lp-status-done">
                      {{ activeSession.messageCount }} msgs
                    </span>
                  </div>
                </div>
                <div class="lp-terminal-body">
                  <div
                    v-for="(line, i) in terminalLines"
                    :key="i"
                    class="lp-term-line"
                    :class="'lp-term-' + line.t"
                  >
                    <span v-if="line.t === 'spin'" class="lp-spinner">⠸</span>
                    {{ line.v }}
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </section>

    <!-- ── FEATURES ───────────────────────────────────────────── -->
    <section class="lp-features">
      <div class="lp-section-inner">
        <h2 class="lp-section-title">Everything Claude Code needs</h2>
        <div class="lp-feature-grid">
          <div class="lp-feature-card">
            <div class="lp-feature-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            </div>
            <h3>Session Browser</h3>
            <p>Every Claude conversation, instantly searchable. Full-text search across all your projects and sessions — find anything in seconds.</p>
          </div>
          <div class="lp-feature-card">
            <div class="lp-feature-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="3.5"/><path d="M1.5 21c0-4 2.9-7 6.5-7s6.5 3 6.5 7"/><circle cx="17" cy="8.5" r="2.5"/><path d="M14.5 21c0-2.8 1.8-5 4.5-5s4.5 2.2 4.5 5"/></svg>
            </div>
            <h3>Multi-Account</h3>
            <p>Switch between personal and work Claude accounts in one click. Separate credentials, separate session histories, zero friction.</p>
          </div>
          <div class="lp-feature-card">
            <div class="lp-feature-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>
            </div>
            <h3>IDE Diff Viewer</h3>
            <p>Review every file change Claude proposes before it's applied. Accept, reject, or edit individual hunks — all with syntax highlighting.</p>
          </div>
          <div class="lp-feature-card">
            <div class="lp-feature-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>
            </div>
            <h3>Plans &amp; Memory</h3>
            <p>Browse Claude's planning files and agent memory files. Understand what Claude is thinking, and edit memory files directly in the app.</p>
          </div>
          <div class="lp-feature-card">
            <div class="lp-feature-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h3.17a1 1 0 0 1 .71.29L10.24 5.7A1 1 0 0 0 11 6h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>
            </div>
            <h3>Project Dashboard</h3>
            <p>See all your projects in one view — with git branch, uncommitted changes, Docker container status, and session history at a glance.</p>
          </div>
          <div class="lp-feature-card">
            <div class="lp-feature-icon">
              <svg width="22" height="22" viewBox="0 0 512 512" fill="currentColor"><path d="M128 496H48V304h80zm224 0h-80V208h80zm112 0h-80V96h80zm-224 0h-80V16h80z"/></svg>
            </div>
            <h3>Activity Stats</h3>
            <p>Track your Claude Code usage with a GitHub-style activity heatmap. See your most productive days and projects at a glance.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── INSTALL ────────────────────────────────────────────── -->
    <section class="lp-install">
      <div class="lp-section-inner">
        <h2 class="lp-section-title">Get started</h2>
        <div class="lp-install-grid">
          <div class="lp-install-card">
            <div class="lp-install-platform">
              <svg width="20" height="20" viewBox="0 0 814 1000" fill="currentColor"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-36.8-162.1-124.3C46.7 740.3 0 599.1 0 517.8c0-220.1 144.4-336.6 284.1-336.6 75.2 0 137.7 49.3 184.8 49.3 44.9 0 115.1-52.3 200.4-52.3zM518.3 15.3c28.5-35.3 50-84.2 50-133.1 0-6.7-.6-13.3-1.9-19.3-47.7 1.9-104.8 31.9-138.8 71.5-26.2 30.3-52.2 79.2-52.2 128.7 0 7.4 1.3 14.7 1.9 17.1 3.2.5 8.4 1.3 13.6 1.3 43.5 0 98.9-28.9 127.4-66.2z"/></svg>
              macOS
            </div>
            <a class="lp-dl-btn" href="https://github.com/fortael/switchboard/releases" target="_blank" rel="noopener">Download .dmg</a>
            <p class="lp-install-note">arm64 + x64 universal</p>
          </div>
          <div class="lp-install-card">
            <div class="lp-install-platform">
              <svg width="20" height="20" viewBox="0 0 88 88" fill="currentColor"><path d="M0 0h42v42H0V0zm4 4h34v34H4V4zm42-4h42v42H46V0zm4 4h34v34H50V4zM0 46h42v42H0V46zm4 4h34v34H4V50zm42-4h42v42H46V46zm4 4h34v34H50V50z"/></svg>
              Windows
            </div>
            <a class="lp-dl-btn" href="https://github.com/fortael/switchboard/releases" target="_blank" rel="noopener">Download .exe</a>
            <p class="lp-install-note">NSIS installer</p>
          </div>
          <div class="lp-install-card">
            <div class="lp-install-platform">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.581 19.049c-.55-.446-.336-1.431-.907-1.917.553-3.365-.997-6.331-2.845-8.232a9.286 9.286 0 0 0-6.636-2.736 9.65 9.65 0 0 0-2.108.234C4.924 7.086 2 10.006 2 13.5c0 3.866 3.134 7 7 7 .295 0 .585-.019.87-.055 1.5.35 3.17.55 4.13.65.96.101 3.001.51 4.001-.24 0 0 .5-.5 1-.5s1 .5 1.5.5 1-.5 1.5-.5.5.5.5.5c0 0-.97-1.857-.92-1.806zM9 19.5c-3.309 0-6-2.691-6-6s2.691-6 6-6 6 2.691 6 6-2.691 6-6 6z"/></svg>
              Linux
            </div>
            <a class="lp-dl-btn" href="https://github.com/fortael/switchboard/releases" target="_blank" rel="noopener">Download .AppImage</a>
            <p class="lp-install-note">AppImage + .deb</p>
          </div>
        </div>
        <p class="lp-install-prereq">Requires <a href="https://docs.anthropic.com/en/docs/claude-code/getting-started" target="_blank" rel="noopener">Claude Code CLI</a> to be installed.</p>
      </div>
    </section>

    <!-- Tooltip element (matches public/style.css #app-tooltip) -->
    <div id="app-tooltip"></div>

    <!-- ── FOOTER ─────────────────────────────────────────────── -->
    <footer class="lp-footer">
      <div class="lp-footer-inner">
        <span>Switchboard · Open source · MIT license</span>
        <a href="https://github.com/fortael/switchboard" target="_blank" rel="noopener">github.com/fortael/switchboard</a>
      </div>
    </footer>

  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';

const iconUrl = 'icon.png';
import { store } from '../vue/store.js';
import SidebarApp from '../vue/components/SidebarApp.vue';
import AccountsApp from '../vue/components/AccountsApp.vue';
import AccountDropdownApp from '../vue/components/AccountDropdownApp.vue';
import ProjectsApp from '../vue/components/ProjectsApp.vue';
import PlansApp from '../vue/components/PlansApp.vue';
import MemoryApp from '../vue/components/MemoryApp.vue';
import { MOCK_ACCOUNTS, MOCK_PROJECTS, MOCK_ACTIVE_PTY_IDS, MOCK_TERMINAL_LINES, MOCK_USAGE, MOCK_PLANS, MOCK_MEMORIES } from './mock-data.js';

const accountDropdownRef = ref(null);
const accountsRef = ref(null);
const projectsRef = ref(null);
const plansRef = ref(null);
const memoryRef = ref(null);

// Tabs shown in the demo (full set)
const DEMO_TABS = [
  { id: 'sessions', label: 'Sessions', svg: '<svg width="18" height="18" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 Z"/></svg>' },
  { id: 'plans',   label: 'Plans',   svg: '<svg width="18" height="18" viewBox="0 0 17 17" fill="currentColor"><path d="M14 2v-2h-13v17h13v-2h2v-13h-2zM2 16v-15h2v15h-2zM13 16h-8v-15h8v15zM15 14h-1v-3h1v3zM15 10h-1v-3h1v3zM14 6v-3h1v3h-1zM6 4h5v1h-5v-1zM6 6h4v1h-4v-1z"/></svg>' },
  { id: 'memory',  label: 'Agent Files', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>' },
  { id: 'stats',   label: 'Stats',   svg: '<svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor"><path d="M128 496H48V304h80zm224 0h-80V208h80zm112 0h-80V96h80zm-224 0h-80V16h80z"/></svg>' },
  { id: 'projects', label: 'Projects', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h3.17a1 1 0 0 1 .71.29L10.24 5.7A1 1 0 0 0 11 6h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="15.5" x2="13" y2="15.5"/></svg>' },
  { id: 'accounts', label: 'Accounts', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="3.5"/><path d="M1.5 21c0-4 2.9-7 6.5-7s6.5 3 6.5 7"/><circle cx="17" cy="8.5" r="2.5"/><path d="M14.5 21c0-2.8 1.8-5 4.5-5s4.5 2.2 4.5 5"/></svg>' },
];

// Demo callbacks (no-ops — prevents console errors from real handlers)
const demoCallbacks = {
  openSession: (s) => { store.activeSessionId = s.sessionId; },
  stopSession: () => {},
  toggleStar: () => {},
  archiveSession: () => {},
  forkSession: () => {},
  showJsonl: () => {},
  launchConfig: () => {},
  renameSession: () => {},
  newSession: () => {},
  openSettings: () => {},
  archiveSessions: () => {},
  removeProject: () => {},
  openProject: (p) => { store.activeSessionId = null; },
  addProject: () => {},
  projectRemoved: () => {},
  switchAccount: (id) => { accountDropdownRef.value?.setActiveAccount?.(id); },
  openAccountHomeSession: () => {},
  openPlan: () => {},
  openMemory: () => {},
  renameAccount: () => {},
  deleteAccount: () => {},
  createAccount: () => null,
};

function setTab(id) {
  store.activeTab = id;
  store.activeSessionId = null;
}

const activeSession = computed(() => {
  if (!store.activeSessionId) return null;
  for (const p of store.projects) {
    const s = p.sessions.find(s => s.sessionId === store.activeSessionId);
    if (s) return s;
  }
  return null;
});

const terminalLines = computed(() => {
  if (!store.activeSessionId) return [];
  return MOCK_TERMINAL_LINES[store.activeSessionId] || [];
});

function displayName(session) {
  return session?.name || session?.summary || 'Untitled';
}

function isRunning(session) {
  return session && MOCK_ACTIVE_PTY_IDS.has(session.sessionId);
}

onMounted(async () => {
  accountDropdownRef.value?.setAccounts(MOCK_ACCOUNTS, 'default', MOCK_USAGE);
  accountsRef.value?.setAccounts(MOCK_ACCOUNTS, 'default');
  accountsRef.value?.setUsage(MOCK_USAGE);
  projectsRef.value?.setProjects(MOCK_PROJECTS);
  plansRef.value?.setPlans(MOCK_PLANS);
  memoryRef.value?.setMemories(MOCK_MEMORIES);

  // ProjectGroup.vue uses ref(fn) for lazy collapsed init. In Vue 3.5, if the
  // lazy init resolves to a truthy function rather than a boolean, all projects
  // appear collapsed. Click the arrows to expand all collapsed project groups.
  await nextTick();
  setTimeout(() => {
    document.querySelectorAll('#sidebar .project-header.collapsed .arrow').forEach(el => el.click());
  }, 50);
});
</script>

<style>
/* Override Electron-specific globals so the landing page can scroll */
html, body {
  height: auto !important;
  overflow: auto !important;
}

/* The landing app root fills the page */
#landing-app {
  min-height: 100vh;
  background: var(--surface-app);
  color: var(--text-primary);
}

/* ── Landing root ────────────────────────────────────────── */
.lp-root {
  font-family: var(--font-sans);
}

/* ── Hero ────────────────────────────────────────────────── */
.lp-hero {
  background: radial-gradient(ellipse at 50% 0%, rgba(242, 136, 75, 0.12) 0%, transparent 65%),
              var(--surface-app);
  text-align: center;
  padding: 56px 24px 48px;
}

.lp-hero-inner {
  max-width: 680px;
  margin: 0 auto;
}

.lp-logo {
  display: block;
  margin: 0 auto 20px;
}

.lp-title {
  font-size: 56px;
  font-weight: 700;
  letter-spacing: -1.5px;
  color: var(--white);
  margin: 0 0 12px;
  line-height: 1.1;
}

.lp-tagline {
  font-size: 20px;
  color: var(--orange-400);
  font-weight: 500;
  margin: 0 0 20px;
}

.lp-desc {
  font-size: 16px;
  color: var(--text-secondary);
  line-height: 1.7;
  margin: 0 0 36px;
}

.lp-cta {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.lp-btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--orange-500);
  color: #0a0a0c;
  font-weight: 600;
  font-size: 15px;
  padding: 10px 24px;
  border-radius: 8px;
  text-decoration: none;
  transition: background 0.15s;
}

.lp-btn-primary:hover { background: var(--orange-400); }

.lp-btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  font-weight: 500;
  font-size: 15px;
  padding: 10px 24px;
  border-radius: 8px;
  text-decoration: none;
  transition: background 0.15s, border-color 0.15s;
}

.lp-btn-secondary:hover {
  background: rgba(255,255,255,0.1);
  border-color: var(--border-strong);
}

.lp-platforms {
  display: flex;
  gap: 8px;
  justify-content: center;
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ── Section common ──────────────────────────────────────── */
.lp-section-inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 24px;
}

.lp-section-title {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.8px;
  color: var(--white);
  text-align: center;
  margin: 0 0 12px;
}

.lp-section-subtitle {
  text-align: center;
  font-size: 15px;
  color: var(--text-secondary);
  max-width: 600px;
  margin: 0 auto 48px;
  line-height: 1.6;
}

/* ── Features ────────────────────────────────────────────── */
.lp-features {
  padding: 90px 24px;
  border-bottom: 1px solid var(--border-subtle);
}

.lp-feature-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-top: 56px;
}

@media (max-width: 900px) {
  .lp-feature-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 560px) {
  .lp-feature-grid { grid-template-columns: 1fr; }
}

.lp-feature-card {
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 28px;
  transition: border-color 0.2s;
}

.lp-feature-card:hover { border-color: var(--border-default); }

.lp-feature-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(242, 136, 75, 0.1);
  border-radius: 10px;
  color: var(--orange-400);
  margin-bottom: 16px;
}

.lp-feature-card h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--white);
  margin: 0 0 10px;
}

.lp-feature-card p {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin: 0;
}

/* ── Demo section ────────────────────────────────────────── */
.lp-demo-section {
  padding: 48px 24px 80px;
  border-bottom: 1px solid var(--border-subtle);
}

/* App window frame */
.lp-app-window {
  border: 1px solid var(--border-default);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.6);
  max-width: 1000px;
  margin: 0 auto;
  height: 540px;
  display: flex;
  flex-direction: column;
  user-select: none;
}

/* macOS title bar */
.lp-titlebar {
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-subtle);
  height: 38px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  flex-shrink: 0;
  gap: 12px;
}

.lp-traffic-lights { display: flex; gap: 7px; }

.lp-tl {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  display: inline-block;
}

.lp-tl-close  { background: #ff5f57; }
.lp-tl-min    { background: #ffbd2e; }
.lp-tl-max    { background: #28c840; }

.lp-titlebar-name {
  font-size: 13px;
  color: var(--text-tertiary);
  font-weight: 500;
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

/* App body (sidebar + main) */
.lp-app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

/* Override sidebar height for the demo container */
.lp-app-body #sidebar {
  height: 100%;
  width: 280px;
  min-width: 180px;
  max-width: 280px;
}

.lp-app-body #main {
  flex: 1;
  overflow: hidden;
  background: var(--surface-app);
  display: flex;
  flex-direction: column;
}

/* Demo-specific overrides for sidebar components */
.lp-demo-empty-tab {
  padding: 20px 0;
}

/* Terminal area in main */
.lp-terminal-area {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface-app);
}

.lp-terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--surface-panel);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.lp-terminal-header-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.lp-terminal-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lp-terminal-id {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.lp-terminal-status {
  flex-shrink: 0;
  font-size: 12px;
  font-family: var(--font-mono);
}

.lp-status-running {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--green-500);
}

.lp-status-done {
  color: var(--text-tertiary);
}

.lp-terminal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 22px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  background: #0d0d10;
}

.lp-term-line { display: flex; align-items: baseline; gap: 6px; }
.lp-term-cmd  { color: var(--gray-100); }
.lp-term-info { color: var(--text-tertiary); }
.lp-term-sep  { color: var(--gray-600); letter-spacing: -0.5px; }
.lp-term-ok   { color: var(--green-500); }
.lp-term-spin { color: var(--orange-400); }
.lp-term-done { color: var(--gray-400); }

.lp-spinner {
  color: var(--orange-400);
  animation: lp-spin-frames 0.8s linear infinite;
  display: inline-block;
}

@keyframes lp-spin-frames {
  0%   { content: '⠸'; }
  25%  { content: '⠼'; }
  50%  { content: '⠴'; }
  75%  { content: '⠦'; }
  100% { content: '⠸'; }
}

/* ── Install ─────────────────────────────────────────────── */
.lp-install {
  padding: 90px 24px;
  border-bottom: 1px solid var(--border-subtle);
}

.lp-install-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  max-width: 700px;
  margin: 56px auto 0;
}

@media (max-width: 600px) {
  .lp-install-grid { grid-template-columns: 1fr; }
}

.lp-install-card {
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
}

.lp-install-platform {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.lp-dl-btn {
  display: inline-block;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 7px 14px;
  font-size: 13px;
  color: var(--text-primary);
  text-decoration: none;
  transition: background 0.15s;
}

.lp-dl-btn:hover { background: rgba(255,255,255,0.1); }

.lp-install-note {
  font-size: 11px;
  color: var(--text-tertiary);
  margin: 0;
}

.lp-install-prereq {
  text-align: center;
  margin-top: 32px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.lp-install-prereq a {
  color: var(--orange-400);
  text-decoration: none;
}

.lp-install-prereq a:hover { text-decoration: underline; }

/* ── Footer ──────────────────────────────────────────────── */
.lp-footer {
  background: var(--surface-panel);
  border-top: 1px solid var(--border-subtle);
  padding: 24px;
}

.lp-footer-inner {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-tertiary);
  gap: 16px;
  flex-wrap: wrap;
}

.lp-footer-inner a {
  color: var(--text-tertiary);
  text-decoration: none;
}

.lp-footer-inner a:hover { color: var(--text-secondary); }
</style>
