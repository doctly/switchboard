<template>
  <!-- ── SIDEBAR ────────────────────────────────────────────────── -->
  <div id="sidebar" :class="{ collapsed: store.sidebarCollapsed }">
    <button id="sidebar-expand-btn" data-tooltip="Show sidebar" @click="store.sidebarCollapsed = false" v-html="EXPAND_SVG"></button>

    <div id="account-selector">
      <AccountDropdownApp ref="accountDropdownRef" :callbacks="accountDropdownCallbacks" />
    </div>

    <div id="sidebar-header">
      <div id="sidebar-tabs">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="sidebar-tab"
          :class="{ active: store.activeTab === tab.id }"
          :data-tab="tab.id"
          :data-tooltip="tab.label"
          @click="setTab(tab.id)"
          v-html="tab.svg"
        ></button>
        <button id="global-settings-btn" data-tooltip="Global settings" @click="onGlobalSettings" v-html="GEAR_SVG"></button>
        <button id="sidebar-collapse-btn" data-tooltip="Hide sidebar" @click="store.sidebarCollapsed = true" v-html="COLLAPSE_SVG"></button>
      </div>

      <div id="session-filters" v-show="store.activeTab === 'sessions'">
        <button id="running-toggle" :class="{ active: store.showRunningOnly }" data-tooltip="Show running only" @click="toggleFilter('showRunningOnly')" v-html="RUNNING_SVG"></button>
        <button id="star-toggle" :class="{ active: store.showStarredOnly }" data-tooltip="Show pinned only" @click="toggleFilter('showStarredOnly')" v-html="STAR_SVG"></button>
        <button id="today-toggle" :class="{ active: store.showTodayOnly }" data-tooltip="Show today's sessions only" @click="toggleFilter('showTodayOnly')" v-html="TODAY_SVG"></button>
        <button id="archive-toggle" :class="{ active: store.showArchived }" data-tooltip="Show archived sessions" @click="toggleFilter('showArchived')" v-html="ARCHIVE_SVG"></button>
        <span id="loading-status" v-show="store.loadingStatus">{{ store.loadingStatus }}</span>
        <button id="grid-toggle-btn" data-tooltip="Session overview" @click="onToggleGrid" v-html="GRID_SVG"></button>
        <button id="resort-btn" data-tooltip="Re-sort sessions" @click="onResort" v-html="RESORT_SVG"></button>
        <button id="add-project-btn" data-tooltip="Add project" @click="onAddProject" v-html="ADD_PROJECT_SVG"></button>
      </div>
    </div>

    <div id="search-bar" :class="{ 'has-query': store.searchQuery }">
      <input
        id="search-input"
        type="text"
        :placeholder="searchPlaceholder"
        :value="store.searchQuery"
        @input="onSearchInput"
      />
      <button id="search-clear" type="button" aria-label="Clear search" @click="doClearSearch">&times;</button>
      <button
        id="search-titles-toggle"
        type="button"
        :class="{ active: store.searchTitlesOnly }"
        data-tooltip="Search titles only"
        aria-label="Search titles only"
        @click="toggleTitlesOnly"
      >Tt</button>
    </div>

    <!-- Sidebar content panels (v-show keeps DOM alive for vanilla JS queries) -->
    <div id="sidebar-content" v-show="store.activeTab === 'sessions' && !store.accountSwitching">
      <SidebarApp :callbacks="sidebarCallbacks" />
    </div>
    <div v-if="store.accountSwitching && store.activeTab === 'sessions'" id="account-switch-overlay" class="account-switch-preloader">
      <div class="acct-spinner"></div><span>Switching account…</span>
    </div>
    <div id="plans-content" v-show="store.activeTab === 'plans'">
      <PlansApp ref="plansRef" :callbacks="planCallbacks" />
    </div>
    <div id="stats-content" v-show="store.activeTab === 'stats'">
      <div class="plans-empty">Click the Stats tab to view activity heatmap.</div>
    </div>
    <div id="memory-content" v-show="store.activeTab === 'memory'">
      <MemoryApp ref="memoryRef" :callbacks="memoryCallbacks" />
    </div>
    <div id="accounts-content" v-show="store.activeTab === 'accounts'">
      <AccountsApp ref="accountsRef" :callbacks="accountsCallbacks" />
    </div>
    <div id="projects-content" v-show="store.activeTab === 'projects'">
      <ProjectsApp ref="projectsRef" :callbacks="projectsCallbacks" />
    </div>
  </div>

  <!-- ── RESIZE HANDLE ──────────────────────────────────────────── -->
  <div id="sidebar-resize-handle"></div>

  <!-- ── MAIN AREA ──────────────────────────────────────────────── -->
  <div id="main">
    <div id="placeholder">
      <p>Select a session from the sidebar to begin.</p>
    </div>
    <div id="stats-viewer" v-show="store.showStats">
      <div id="stats-viewer-header">
        <span id="stats-viewer-title">Activity</span>
        <button
          class="stats-refresh-btn"
          :class="{ 'stats-refresh-spinning': statsRef?.isRefreshing }"
          :disabled="statsRef?.isRefreshing"
          title="Refresh stats (runs claude /stats)"
          @click="statsRef?.refreshAll()"
          v-html="STATS_REFRESH_SVG"
        ></button>
      </div>
      <StatsApp ref="statsRef" />
    </div>
    <div id="memory-viewer" style="display:none;"></div>
    <div id="plan-viewer" style="display:none;"></div>
    <SettingsPanelApp v-if="store.settingsOpen" />
    <div id="project-viewer" style="display:none;">
      <ProjectViewerApp ref="projectViewerRef" :callbacks="projectViewerCallbacks" />
    </div>
    <div id="jsonl-viewer" v-show="store.showJsonl">
      <JsonlViewerApp ref="jsonlRef" />
    </div>
    <div id="terminal-area">
      <div id="vue-session-header">
        <SessionHeaderApp />
      </div>
      <!-- Legacy terminal header kept for JS references (hidden) -->
      <div id="terminal-header" style="display:none;">
        <div id="terminal-header-info">
          <span id="terminal-header-name"></span>
          <span id="terminal-header-pty-title" style="display:none;"></span>
          <span id="terminal-header-id"></span>
          <span id="terminal-header-shell" style="display:none;"></span>
          <span id="terminal-header-account" class="terminal-account-badge" style="display:none;"></span>
        </div>
        <div id="terminal-header-controls">
          <span id="terminal-header-status"></span>
          <button id="terminal-stop-btn" data-tooltip="Stop process">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>
          </button>
        </div>
      </div>
      <div id="grid-viewer" style="display:none;">
        <div id="grid-viewer-header">
          <span id="grid-viewer-title">Session Overview</span>
          <span id="grid-viewer-count"></span>
        </div>
      </div>
      <div id="terminals"></div>
    </div>
  </div>

  <!-- Status bar and grid cards rendered via Teleport into their existing container elements -->
  <Teleport to="#status-bar">
    <StatusBarApp ref="statusBarRef" />
  </Teleport>
  <Teleport to="#vue-grid-cards">
    <GridCardsApp ref="gridCardsRef" />
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { store } from '../store.js';
import SidebarApp from './SidebarApp.vue';
import SessionHeaderApp from './SessionHeaderApp.vue';
import PlansApp from './PlansApp.vue';
import MemoryApp from './MemoryApp.vue';
import AccountsApp from './AccountsApp.vue';
import AccountDropdownApp from './AccountDropdownApp.vue';
import ProjectsApp from './ProjectsApp.vue';
import StatusBarApp from './StatusBarApp.vue';
import GridCardsApp from './GridCardsApp.vue';
import SettingsPanelApp from './SettingsPanelApp.vue';
import ProjectViewerApp from './ProjectViewerApp.vue';
import StatsApp from './StatsApp.vue';
import JsonlViewerApp from './JsonlViewerApp.vue';

// ── Template refs ────────────────────────────────────────────────
const plansRef = ref(null);
const memoryRef = ref(null);
const accountsRef = ref(null);
const accountDropdownRef = ref(null);
const projectsRef = ref(null);
const statusBarRef = ref(null);
const gridCardsRef = ref(null);
const projectViewerRef = ref(null);
const statsRef = ref(null);
const jsonlRef = ref(null);

// ── Tab config ───────────────────────────────────────────────────
const TABS = [
  { id: 'sessions', label: 'Sessions', svg: '<svg width="18" height="18" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg>' },
  { id: 'plans', label: 'Plans', svg: '<svg width="18" height="18" viewBox="0 0 17 17" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M14 2v-2h-13v17h13v-2h2v-13h-2zM2 16v-15h2v15h-2zM13 16h-8v-15h8v15zM15 14h-1v-3h1v3zM15 10h-1v-3h1v3zM14 6v-3h1v3h-1zM6 4h5v1h-5v-1zM6 6h4v1h-4v-1z"/></svg>' },
  { id: 'memory', label: 'Agent Files', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>' },
  { id: 'stats', label: 'Stats', svg: '<svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M128 496H48V304h80zm224 0h-80V208h80zm112 0h-80V96h80zm-224 0h-80V16h80z"/></svg>' },
  { id: 'projects', label: 'Projects', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h3.17a1 1 0 0 1 .71.29L10.24 5.7A1 1 0 0 0 11 6h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="15.5" x2="13" y2="15.5"/></svg>' },
  { id: 'accounts', label: 'Accounts', svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="3.5"/><path d="M1.5 21c0-4 2.9-7 6.5-7s6.5 3 6.5 7"/><circle cx="17" cy="8.5" r="2.5"/><path d="M14.5 21c0-2.8 1.8-5 4.5-5s4.5 2.2 4.5 5"/></svg>' },
];

// ── Icons ────────────────────────────────────────────────────────
const EXPAND_SVG = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" height="20" width="20" xmlns="http://www.w3.org/2000/svg"><path d="M18 3a3 3 0 0 1 2.995 2.824l.005 .176v12a3 3 0 0 1 -2.824 2.995l-.176 .005h-12a3 3 0 0 1 -2.995 -2.824l-.005 -.176v-12a3 3 0 0 1 2.824 -2.995l.176 -.005h12zm-3 2h-9a1 1 0 0 0 -.993 .883l-.007 .117v12a1 1 0 0 0 .883 .993l.117 .007h9v-14zm-5.387 4.21l.094 .083l2 2a1 1 0 0 1 .083 1.32l-.083 .094l-2 2a1 1 0 0 1 -1.497 -1.32l.083 -.094l1.292 -1.293l-1.292 -1.293a1 1 0 0 1 -.083 -1.32l.083 -.094a1 1 0 0 1 1.32 -.083z"></path></svg>';
const COLLAPSE_SVG = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" height="20" width="20" xmlns="http://www.w3.org/2000/svg"><path d="M18 3a3 3 0 0 1 2.995 2.824l.005 .176v12a3 3 0 0 1 -2.824 2.995l-.176 .005h-12a3 3 0 0 1 -2.995 -2.824l-.005 -.176v-12a3 3 0 0 1 2.824 -2.995l.176 -.005h12zm0 2h-9v14h9a1 1 0 0 0 .993 -.883l.007 -.117v-12a1 1 0 0 0 -.883 -.993l-.117 -.007zm-2.293 4.293a1 1 0 0 1 .083 1.32l-.083 .094l-1.292 1.293l1.292 1.293a1 1 0 0 1 .083 1.32l-.083 .094a1 1 0 0 1 -1.32 .083l-.094 -.083l-2 -2a1 1 0 0 1 -.083 -1.32l.083 -.094l2 -2a1 1 0 0 1 1.414 0z"></path></svg>';
const GEAR_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-1.5 0a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"></path><path d="M12 1c.266 0 .532.009.797.028.763.055 1.345.617 1.512 1.304l.352 1.45c.019.078.09.171.225.221.247.089.49.19.728.302.13.061.246.044.315.002l1.275-.776c.603-.368 1.411-.353 1.99.147.402.349.78.726 1.128 1.129.501.578.515 1.386.147 1.99l-.776 1.274c-.042.069-.058.185.002.315.112.238.213.481.303.728.048.135.142.205.22.225l1.45.352c.687.167 1.249.749 1.303 1.512.038.531.038 1.063 0 1.594-.054.763-.616 1.345-1.303 1.512l-1.45.352c-.078.019-.171.09-.221.225-.089.248-.19.491-.302.728-.061.13-.044.246-.002.315l.776 1.275c.368.603.353 1.411-.147 1.99-.349.402-.726.78-1.129 1.128-.578.501-1.386.515-1.99.147l-1.274-.776c-.069-.042-.185-.058-.314.002a8.606 8.606 0 0 1-.729.303c-.135.048-.205.142-.225.22l-.352 1.45c-.167.687-.749 1.249-1.512 1.303-.531.038-1.063.038-1.594 0-.763-.054-1.345-.616-1.512-1.303l-.352-1.45c-.019-.078-.09-.171-.225-.221a8.138 8.138 0 0 1-.728-.302c-.13-.061-.246-.044-.315-.002l-1.275.776c-.603.368-1.411.353-1.99-.147-.402-.349-.78-.726-1.128-1.129-.501-.578-.515-1.386-.147-1.99l.776-1.274c.042-.069.058-.185-.002-.314a8.606 8.606 0 0 1-.303-.729c-.048-.135-.142-.205-.22-.225l-1.45-.352c-.687-.167-1.249-.749-1.304-1.512a11.158 11.158 0 0 1 0-1.594c.055-.763.617-1.345 1.304-1.512l1.45-.352c.078-.019.171-.09.221-.225.089-.248.19-.491.302-.728.061-.13.044-.246.002-.315l-.776-1.275c-.368-.603-.353-1.411.147-1.99.349-.402.726-.78 1.129-1.128.578-.501 1.386-.515 1.99-.147l1.274.776c.069.042.185.058.315-.002.238-.112.481-.213.728-.303.135-.048.205-.142.225-.22l.352-1.45c.167-.687.749-1.249 1.512-1.304C11.466 1.01 11.732 1 12 1Zm-.69 1.525c-.055.004-.135.05-.161.161l-.353 1.45a1.832 1.832 0 0 1-1.172 1.277 7.147 7.147 0 0 0-.6.249 1.833 1.833 0 0 1-1.734-.074l-1.274-.776c-.098-.06-.186-.036-.228 0a9.774 9.774 0 0 0-.976.976c-.036.042-.06.131 0 .228l.776 1.274c.314.529.342 1.18.074 1.734a7.147 7.147 0 0 0-.249.6 1.831 1.831 0 0 1-1.278 1.173l-1.45.351c-.11.027-.156.107-.16.162a9.63 9.63 0 0 0 0 1.38c.004.055.05.135.161.161l1.45.353a1.832 1.832 0 0 1 1.277 1.172c.074.204.157.404.249.6.268.553.24 1.204-.074 1.733l-.776 1.275c-.06.098-.036.186 0 .228.301.348.628.675.976.976.042.036.131.06.228 0l1.274-.776a1.83 1.83 0 0 1 1.734-.075c.196.093.396.176.6.25a1.831 1.831 0 0 1 1.173 1.278l.351 1.45c.027.11.107.156.162.16a9.63 9.63 0 0 0 1.38 0c.055-.004.135-.05.161-.161l.353-1.45a1.834 1.834 0 0 1 1.172-1.278 6.82 6.82 0 0 0 .6-.248 1.831 1.831 0 0 1 1.733.074l1.275.776c.098.06.186.036.228 0 .348-.301.675-.628.976-.976.036-.042.06-.131 0-.228l-.776-1.275a1.834 1.834 0 0 1-.075-1.733c.093-.196.176-.396.25-.6a1.831 1.831 0 0 1 1.278-1.173l1.45-.351c.11-.027.156-.107.16-.162a9.63 9.63 0 0 0 0-1.38c-.004-.055-.05-.135-.161-.161l-1.45-.353c-.626-.152-1.08-.625-1.278-1.172a6.576 6.576 0 0 0-.248-.6 1.833 1.833 0 0 1 .074-1.734l.776-1.274c.06-.098.036-.186 0-.228a9.774 9.774 0 0 0-.976-.976c-.042-.036-.131-.06-.228 0l-1.275.776a1.831 1.831 0 0 1-1.733.074 6.88 6.88 0 0 0-.6-.249 1.835 1.835 0 0 1-1.173-1.278l-.351-1.45c-.027-.11-.107-.156-.162-.16a9.63 9.63 0 0 0-1.38 0Z"></path></svg>';
const STATS_REFRESH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>';
const RUNNING_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4"/></svg>';
const STAR_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37.722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>';
const TODAY_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2v-12z"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M4 11h16"/><path d="M11 15h1"/><path d="M12 15v3"/></svg>';
const ARCHIVE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="m21.706 5.292-2.999-2.999A.996.996 0 0 0 18 2H6a.996.996 0 0 0-.707.293L2.294 5.292A.994.994 0 0 0 2 6v13c0 1.103.897 2 2 2h16c1.103 0 2-.897 2-2V6a.994.994 0 0 0-.294-.708zM6.414 4h11.172l1 1H5.414l1-1zM4 19V7h16l.002 12H4z"/><path d="M14 9h-4v3H7l5 5 5-5h-3z"/></svg>';
const GRID_SVG = '<svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';
const RESORT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>';
const ADD_PROJECT_SVG = '<svg width="14" height="14" viewBox="0 0 512 512" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M512 416c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96C0 60.7 28.7 32 64 32l128 0c20.1 0 39.1 9.5 51.2 25.6l19.2 25.6c6 8.1 15.5 12.8 25.6 12.8l160 0c35.3 0 64 28.7 64 64l0 256zM232 376c0 13.3 10.7 24 24 24s24-10.7 24-24l0-64 64 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-64 0 0-64c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 64-64 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l64 0 0 64z"/></svg>';

// ── Search ───────────────────────────────────────────────────────
const searchPlaceholder = computed(() => {
  switch (store.activeTab) {
    case 'plans': return 'Search plans...';
    case 'memory': return 'Search agent files...';
    case 'projects': return 'Search projects…';
    default: return 'Search sessions...';
  }
});

let searchDebounceTimer = null;

function onSearchInput(e) {
  store.searchQuery = e.target.value;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null;
    const query = store.searchQuery.trim();
    if (!query) { doClearSearch(); return; }
    window.__sb?.search?.(query, store.searchTitlesOnly);
  }, 200);
}

function doClearSearch() {
  store.searchQuery = '';
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  window.__sb?.clearSearch?.();
}

async function toggleTitlesOnly() {
  store.searchTitlesOnly = !store.searchTitlesOnly;
  await window.api?.setSetting('searchTitlesOnly', store.searchTitlesOnly);
  if (store.searchQuery.trim()) {
    window.__sb?.search?.(store.searchQuery.trim(), store.searchTitlesOnly);
  }
}

// ── Tab switching ────────────────────────────────────────────────
function setTab(tabId) {
  if (tabId === store.activeTab) return;
  store.activeTab = tabId;
  // Clear search on tab switch
  store.searchQuery = '';
  store.searchMatchIds = null;
  store.searchMatchProjectPaths = null;
  window.__sb?.onTabChange?.(tabId);
}

// ── Filter toggles ───────────────────────────────────────────────
function toggleFilter(filterName) {
  store[filterName] = !store[filterName];
  // Mutual exclusion: starred and running can't both be on
  if (filterName === 'showStarredOnly' && store.showStarredOnly) store.showRunningOnly = false;
  if (filterName === 'showRunningOnly' && store.showRunningOnly) store.showStarredOnly = false;
  localStorage.setItem(filterName, store[filterName] ? '1' : '0');
  window.__sb?.onFilterChange?.({
    showStarredOnly: store.showStarredOnly,
    showRunningOnly: store.showRunningOnly,
    showTodayOnly: store.showTodayOnly,
    showArchived: store.showArchived,
  });
}

// ── Sidebar action callbacks ──────────────────────────────────────
function onGlobalSettings() { window.__sb?.openGlobalSettings?.(); }
function onResort() { window.__sb?.resort?.(); }
function onAddProject() { window.__sb?.addProject?.(); }
function onToggleGrid() { window.__sb?.toggleGridView?.(); }

// ── Component callbacks ───────────────────────────────────────────
const sidebarCallbacks = {
  openSession: (s) => window.__sb?.openSession?.(s),
  stopSession: (id) => window.__sb?.stopSession?.(id),
  toggleStar: (id) => window.__sb?.toggleStar?.(id),
  archiveSession: (id) => window.__sb?.archiveSession?.(id),
  forkSession: (id) => window.__sb?.forkSession?.(id),
  showJsonl: (id) => window.__sb?.showJsonl?.(id),
  launchConfig: (id) => window.__sb?.launchConfig?.(id),
  renameSession: (id, name) => window.__sb?.renameSession?.(id, name),
  newSession: (project, btn) => window.__sb?.newSession?.(project, btn),
  openSettings: (path) => window.__sb?.openSettings?.(path),
  archiveSessions: (sessions) => window.__sb?.archiveSessions?.(sessions),
  removeProject: (path) => window.__sb?.removeProject?.(path),
};

const planCallbacks = {
  openPlan: (plan) => window.__sb?.openPlan?.(plan),
};

const memoryCallbacks = {
  openMemory: (file) => window.__sb?.openMemory?.(file),
};

const accountsCallbacks = {
  switchAccount: (id) => window.__sb?.switchAccount?.(id),
  openAccountHomeSession: (acc) => window.__sb?.openAccountHomeSession?.(acc),
  renameAccount: (id, name) => window.__sb?.renameAccount?.(id, name),
  deleteAccount: (id) => window.__sb?.deleteAccount?.(id),
  createAccount: (name) => window.__sb?.createAccount?.(name),
};

const accountDropdownCallbacks = {
  switchAccount: (id) => window.__sb?.switchAccount?.(id),
};

const projectsCallbacks = {
  openProject: (p) => window.__sb?.openProject?.(p),
  newSession: (p, btn) => window.__sb?.newSession?.(p, btn),
  addProject: () => window.__sb?.addProject?.(),
  projectRemoved: () => window.__sb?.projectRemoved?.(),
};

const projectViewerCallbacks = {
  newSession: (p, btn) => window.__sb?.newSession?.(p, btn),
  onTabChange: (tab) => window.__sb?.onPvTabChange?.(tab),
  worktreeDeleted: (worktreePath) => {
    store.projects = store.projects.filter(p => p.projectPath !== worktreePath);
  },
};

// ── Mount lifecycle ───────────────────────────────────────────────
onMounted(async () => {
  // Re-export component bridge APIs so app.js can call them
  Object.assign(window.vuePlans, {
    setPlans: (list) => plansRef.value?.setPlans(list),
    setActive: (f) => plansRef.value?.setActive(f),
    clearActive: () => plansRef.value?.clearActive(),
  });
  Object.assign(window.vueMemory, {
    setMemories: (data, ids) => memoryRef.value?.setMemories(data, ids),
    setFilter: (ids) => memoryRef.value?.setFilter(ids),
    setActive: (f) => memoryRef.value?.setActive(f),
    clearActive: () => memoryRef.value?.clearActive(),
  });
  Object.assign(window.vueAccounts, {
    setAccounts: (list, id) => accountsRef.value?.setAccounts(list, id),
    setActiveAccount: (id) => accountsRef.value?.setActiveAccount(id),
    setUsage: (usage) => accountsRef.value?.setUsage(usage),
  });
  Object.assign(window.vueAccountDropdown, {
    setAccounts: (list, id, usage) => accountDropdownRef.value?.setAccounts(list, id, usage),
    setActiveAccount: (id) => accountDropdownRef.value?.setActiveAccount(id),
    setUsage: (usage) => accountDropdownRef.value?.setUsage(usage),
    close: () => accountDropdownRef.value?.close(),
  });
  Object.assign(window.vueProjects, {
    setProjects: (list) => projectsRef.value?.setProjects(list),
    setSearch: (q) => projectsRef.value?.setSearch(q),
    clearActive: () => projectsRef.value?.clearActive(),
  });
  Object.assign(window.vueStatusBar, {
    setInfo: (text) => statusBarRef.value?.setInfo(text),
    setActivity: (text, type) => statusBarRef.value?.setActivity(text, type),
    setUpdater: (text, duration) => statusBarRef.value?.setUpdater(text, duration),
  });
  // GridCardsApp exposes addCard/updateCard/removeCard/clearAll directly
  window.vueGrid = gridCardsRef.value;

  const worktreePattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;
  window.vueProjectViewer = {
    open: (proj) => {
      const worktrees = store.projects
        .filter(p => { const m = p.projectPath.match(worktreePattern); return m && m[1] === proj.projectPath; })
        .map(p => ({ projectPath: p.projectPath, name: p.projectPath.match(worktreePattern)?.[2] || p.projectPath }));
      projectViewerRef.value?.open(proj, worktrees);
    },
    close: () => projectViewerRef.value?.close(),
    setTab: (tab) => projectViewerRef.value?.setTab(tab),
  };
  window.vueApp = { setTab };
  window.vueStats = {
    load: () => statsRef.value?.load(),
    invalidate: () => statsRef.value?.invalidate(),
  };
  window.vueJsonlViewer = { open: (s) => jsonlRef.value?.open(s) };

  // Settings panel — exposed so app.js and vanilla JS callers can open it.
  // Hides all vanilla-managed main-area content so the xterm canvas can't
  // intercept pointer events while settings is showing.
  window.openSettingsViewer = (scope, projectPath) => {
    const hide = ['terminal-area', 'placeholder', 'plan-viewer', 'memory-viewer', 'project-viewer'];
    for (const id of hide) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    store.showStats = false;
    store.showJsonl = false;
    store.settingsScope = scope || 'global';
    store.settingsProjectPath = projectPath || null;
    store.settingsOpen = true;
  };
  window.closeSettingsViewer = () => {
    store.settingsOpen = false;
    window._restoreAfterSettings?.();
  };

  // Restore persisted settings
  const savedTitlesOnly = await window.api?.getSetting('searchTitlesOnly');
  if (savedTitlesOnly) store.searchTitlesOnly = true;

  // Restore filter preferences from localStorage
  store.showRunningOnly = localStorage.getItem('showRunningOnly') === '1';
  store.showStarredOnly = localStorage.getItem('showStarredOnly') === '1';
  store.showTodayOnly = localStorage.getItem('showTodayOnly') === '1';
  store.showArchived = localStorage.getItem('showArchived') === '1';
});
</script>
