<template>
  <div class="pv-root" v-if="project">

    <!-- ── Diff / File view (full-screen overlay) ──────────────────── -->
    <template v-if="activeDiff || activeFile">
      <div class="pv-diff-nav">
        <button class="pv-nav-btn pv-nav-back" @click="closeOverlay">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <span class="pv-nav-file">
          <span class="pv-nav-filename">{{ overlayTitle }}</span>
          <span class="pv-nav-filepath">{{ overlayPath }}</span>
        </span>
        <template v-if="activeDiff">
          <div class="pv-nav-arrows">
            <button class="pv-nav-btn" @click="prevFile" :disabled="currentFileIndex <= 0" title="Previous file">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span class="pv-nav-counter">{{ currentFileIndex + 1 }} / {{ changedFiles.length }}</span>
            <button class="pv-nav-btn" @click="nextFile" :disabled="currentFileIndex >= changedFiles.length - 1" title="Next file">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </template>
        <template v-if="activeFile">
          <button class="pv-nav-btn pv-save-btn" @click="saveFile" :disabled="!fileModified || fileSaving">
            {{ fileSaving ? 'Saving…' : 'Save' }}
          </button>
        </template>
      </div>
      <div ref="diffContainerRef" class="pv-diff-container"></div>
    </template>

    <!-- ── Main panel ─────────────────────────────────────────────── -->
    <template v-else>
      <!-- Header -->
      <div class="pv-header">
        <ProjectAvatar class="pv-avatar" :project-path="project.projectPath" />
        <div class="pv-title-wrap">
          <div class="pv-name">
            {{ projectName }}
            <span v-if="worktrees.length" class="pv-wt-count-badge" :title="`${worktrees.length} worktree${worktrees.length > 1 ? 's' : ''}`">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              {{ worktrees.length }}
            </span>
            <span v-if="unpushedCount" class="pv-header-unpushed-badge" :title="`${unpushedCount} unpushed commit${unpushedCount > 1 ? 's' : ''}`">{{ unpushedCount }}</span>
          </div>
          <div class="pv-path">{{ viewedPath }}</div>
        </div>
        <button class="pv-new-btn" @click="newSession($event)">+ New session</button>
      </div>

      <!-- Worktree switcher -->
      <div v-if="worktrees.length" class="pv-worktree-bar">
        <button
          class="pv-wt-btn"
          :class="{ active: viewedPath === project.projectPath }"
          @click="setViewedPath(project.projectPath)"
        >main</button>
        <button
          v-for="wt in worktrees" :key="wt.projectPath"
          class="pv-wt-btn pv-wt-btn--deletable"
          :class="{ active: viewedPath === wt.projectPath }"
          @click="setViewedPath(wt.projectPath)"
        >
          {{ wt.name }}
          <span class="pv-wt-del" @click.stop="deleteWorktree(wt)" title="Delete worktree and branch">
            <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>
          </span>
        </button>
      </div>

      <!-- Tabs -->
      <div class="pv-tabs">
        <button v-for="t in TABS" :key="t.id" class="pv-tab" :class="{ active: activeTab === t.id }" @click="activeTab = t.id">{{ t.label }}</button>
      </div>

      <div class="pv-tab-body">
        <div v-if="loading" class="pv-loading">Loading…</div>

        <!-- ── OVERVIEW TAB ──────────────────────────────────────── -->
        <template v-else-if="activeTab === 'overview' && detail">
          <!-- Git toolbar -->
          <div class="pv-git-toolbar">
            <div class="pv-branch-wrap">
              <svg class="pv-branch-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              <select class="pv-branch-select" :value="detail.branch" @change="switchBranch($event.target.value)" :disabled="gitBusy">
                <optgroup label="Local">
                  <option v-for="b in branches" :key="b" :value="b">{{ b }}</option>
                </optgroup>
                <optgroup v-if="remoteBranches.length" label="Remote">
                  <option v-for="b in remoteBranches" :key="b" :value="b">{{ b }}</option>
                </optgroup>
              </select>
            </div>
            <button class="pv-git-btn" @click="doFetch" :disabled="gitBusy" title="git fetch --prune">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Fetch
            </button>
            <button class="pv-git-btn" @click="doPull" :disabled="gitBusy" title="git pull">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
              Pull
            </button>
            <button class="pv-git-btn" @click="showCreateBranch = true" :disabled="gitBusy" title="Create new branch">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Branch
            </button>
            <button class="pv-git-btn" @click="refreshStats" :disabled="statsRefreshing" title="Refresh git stats">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :style="statsRefreshing ? 'animation:pv-spin 1s linear infinite' : ''"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Refresh
            </button>
            <span v-if="gitMessage" class="pv-git-msg" :class="{ error: gitError }">{{ gitMessage }}</span>
            <span v-if="detail.totalAdded || detail.totalDeleted" class="pv-git-stats">
              <span class="pv-added" v-if="detail.totalAdded">+{{ detail.totalAdded }}</span>
              <span class="pv-deleted" v-if="detail.totalDeleted">−{{ detail.totalDeleted }}</span>
            </span>
          </div>

          <div class="pv-overview-grid">
            <!-- Left: changed files + commit -->
            <div class="pv-col-left">
              <!-- Changed files -->
              <div class="pv-card" v-if="detail.changedFiles.length">
                <div class="pv-card-title">
                  <span>Uncommitted changes</span>
                  <span class="pv-count-badge">{{ detail.changedFiles.length }}</span>
                </div>
                <div class="pv-file-list">
                  <div
                    v-for="f in detail.changedFiles" :key="f.file"
                    class="pv-file-row pv-file-row--clickable"
                    :class="{ loading: loadingFile === f.file }"
                    @click="openDiff(f.file)" :title="f.file"
                  >
                    <span class="pv-file-status" :class="fileStatus(f)">{{ fileStatusChar(f) }}</span>
                    <span class="pv-file-name">{{ f.file }}</span>
                    <span class="pv-file-diff">
                      <span v-if="f.added" class="pv-added">+{{ f.added }}</span>
                      <span v-if="f.deleted" class="pv-deleted">−{{ f.deleted }}</span>
                    </span>
                  </div>
                </div>
              </div>
              <div class="pv-card pv-empty-changes" v-else>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:.3"><polyline points="20 6 9 17 4 12"/></svg>
                <span>Working tree clean</span>
              </div>

              <!-- Commit panel -->
              <div class="pv-card pv-commit-card">
                <div class="pv-card-title">Commit</div>
                <div v-if="generating" class="pv-generating-wrap">
                  <span class="pv-generating-text">Generating…</span>
                </div>
                <textarea
                  v-else
                  class="pv-commit-input"
                  placeholder="Commit message…"
                  v-model="commitMessage"
                  rows="5"
                ></textarea>
                <div class="pv-git-user" v-if="gitUser.name || gitUser.email">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  <span class="pv-git-user-name">{{ gitUser.name }}</span>
                  <span class="pv-git-user-email" v-if="gitUser.email">&lt;{{ gitUser.email }}&gt;</span>
                </div>
                <div class="pv-gen-row">
                  <svg class="pv-gen-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                  <span class="pv-gen-label">Generate with Claude:</span>
                  <button class="pv-gen-style-btn" @click="generateCommitMsg('short')" :disabled="gitBusy || generating" title="One-sentence commit message">short</button>
                  <button class="pv-gen-style-btn" @click="generateCommitMsg('descriptive')" :disabled="gitBusy || generating" title="Title + bullet list of key changes">detailed</button>
                </div>
                <div class="pv-commit-actions">
                  <button class="pv-action-btn" @click="doCommit" :disabled="gitBusy || !commitMessage.trim()">
                    Commit
                  </button>
                </div>
              </div>
            </div>

            <!-- Right: containers + sessions -->
            <div class="pv-col-right">
              <div class="pv-card" v-if="detail.containers.length">
                <div class="pv-card-title">Docker Compose</div>
                <div class="pv-container-list">
                  <div v-for="c in detail.containers" :key="c.name" class="pv-container-row" :class="{ running: c.state.includes('running') }">
                    <span class="pv-container-dot"></span>
                    <span class="pv-container-name">{{ c.name }}</span>
                    <span class="pv-container-state">{{ c.status || c.state }}</span>
                    <span v-if="c.ports" class="pv-container-ports">{{ c.ports }}</span>
                  </div>
                </div>
              </div>

              <div class="pv-card" v-if="sessions.length">
                <div class="pv-card-title">Recent sessions</div>
                <div class="pv-session-list">
                  <div v-for="s in sessions" :key="s.id" class="pv-session-row" @click="openSession(s)">
                    <div class="pv-session-name">{{ s.name }}</div>
                    <div class="pv-session-date">{{ fmtDate(s.updatedAt) }}</div>
                  </div>
                </div>
              </div>

              <div class="pv-card pv-avatar-card" v-if="mrLink?.type === 'gitlab'">
                <div class="pv-card-title">Avatar</div>
                <div class="pv-avatar-preview">
                  <img v-if="avatarDataUrl" class="pv-avatar-preview-img" :src="avatarDataUrl" :alt="projectName">
                  <span v-else class="pv-avatar pv-avatar--large" :style="{ background: avatar.color }">{{ avatar.initials }}</span>
                </div>
                <SbButton @click="updateAvatar" :disabled="avatarLoading">
                  {{ avatarLoading ? 'Updating…' : 'Update Avatar' }}
                </SbButton>
              </div>
            </div>
          </div>
        </template>

        <!-- ── COMMITS TAB ───────────────────────────────────────── -->
        <template v-else-if="activeTab === 'commits' && detail">

          <!-- Push destination panel -->
          <div class="pv-push-panel">
            <div class="pv-push-panel-row">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              <span class="pv-push-panel-label">Remote</span>
              <span class="pv-push-panel-val" v-if="detail.upstream">{{ detail.upstream }}</span>
              <span class="pv-push-panel-val pv-push-panel-val--muted" v-else>no upstream set</span>
              <span class="pv-push-panel-url" v-if="detail.remoteUrl" :title="detail.remoteUrl">{{ detail.remoteUrl }}</span>
            </div>
            <div class="pv-push-panel-row" v-if="detail.tags && detail.tags.length">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
              <span class="pv-push-panel-label">Tags</span>
              <div class="pv-push-panel-tags">
                <span v-for="tag in detail.tags" :key="tag" class="pv-push-tag">{{ tag }}</span>
              </div>
            </div>
            <div class="pv-push-panel-row pv-push-panel-row--mr" v-if="mrLink">
              <!-- GitLab icon -->
              <svg v-if="mrLink.type === 'gitlab'" width="12" height="12" viewBox="0 0 380 380" fill="currentColor" style="color:#fc6d26;flex-shrink:0"><path d="M190 340.1L254.5 143H125.5L190 340.1z"/><path d="M190 340.1L125.5 143H28.6L190 340.1z" opacity=".7"/><path d="M28.6 143L9.4 201.8a13.3 13.3 0 0 0 4.8 14.9L190 340.1 28.6 143z" opacity=".4"/><path d="M28.6 143h96.9L83.9 16.6c-1.8-5.5-9.4-5.5-11.2 0L28.6 143z"/><path d="M190 340.1L254.5 143h96.9L190 340.1z" opacity=".7"/><path d="M351.4 143l19.2 58.8a13.3 13.3 0 0 1-4.8 14.9L190 340.1 351.4 143z" opacity=".4"/><path d="M351.4 143h-96.9l41.6-126.4c1.8-5.5 9.4-5.5 11.2 0L351.4 143z"/></svg>
              <!-- GitHub icon -->
              <svg v-else-if="mrLink.type === 'github'" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="color:#e6edf3;flex-shrink:0"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/></svg>
              <span class="pv-push-panel-label">{{ mrLink.label }}</span>
              <div class="pv-mr-links">
                <a class="pv-mr-link" :href="mrLink.listUrl" @click.prevent="openExternal(mrLink.listUrl)">Open list</a>
              </div>
            </div>
            <div class="pv-push-panel-actions">
              <button class="pv-action-btn pv-push-btn" @click="confirmPush = true" :disabled="gitBusy || !detail.upstream" title="Push to remote">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                Push{{ unpushedCount ? ` (${unpushedCount})` : '' }}
              </button>
            </div>
          </div>

          <!-- Unpushed commits panel -->
          <template v-if="unpushedCommits.length">
            <div class="pv-commits-section-label pv-commits-section-label--unpushed">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              {{ unpushedCommits.length }} unpushed commit{{ unpushedCommits.length > 1 ? 's' : '' }}
            </div>
            <div class="pv-commit-panel">
              <div class="pv-commit-panel-meta">
                <span class="pv-commit-panel-stat">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>
                  {{ unpushedCommits[0]?.author }}
                </span>
                <span class="pv-commit-panel-stat">{{ unpushedCommits[unpushedCommits.length - 1]?.date }} – {{ unpushedCommits[0]?.date }}</span>
              </div>
              <div class="pv-commit-list-full pv-commit-list-full--unpushed">
                <div v-for="c in unpushedCommits" :key="c.hash" class="pv-commit-item">
                  <span class="pv-commit-hash">{{ c.hash }}</span>
                  <span class="pv-commit-msg">{{ c.message }}</span>
                  <span class="pv-commit-author">{{ c.author }}</span>
                  <span class="pv-commit-date">{{ c.date }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- History -->
          <div v-if="detail.commits.length" class="pv-commits-section-label">History</div>
          <div class="pv-commit-list-full">
            <div v-for="c in detail.commits" :key="c.hash" class="pv-commit-item">
              <span class="pv-commit-hash">{{ c.hash }}</span>
              <span class="pv-commit-msg">{{ c.message }}</span>
              <span class="pv-commit-author">{{ c.author }}</span>
              <span class="pv-commit-date">{{ c.date }}</span>
            </div>
            <div v-if="!detail.commits.length" class="pv-empty">No commits found.</div>
          </div>
        </template>

        <!-- ── FILES TAB ─────────────────────────────────────────── -->
        <template v-else-if="activeTab === 'files'">
          <div class="pv-files-layout">
            <div class="pv-tree-panel">
              <div class="pv-tree-search">
                <input v-model="treeSearch" class="pv-tree-search-input" placeholder="Filter files…" />
              </div>
              <div class="pv-tree-scroll">
                <div v-if="treeLoading" class="pv-loading">Loading…</div>
                <FileTreeNode
                  v-else
                  v-for="node in filteredTree"
                  :key="node.path"
                  :node="node"
                  :search="treeSearch"
                  @open="openFileFromTree"
                />
              </div>
            </div>
          </div>
        </template>

        <!-- ── SESSIONS TAB ──────────────────────────────────────── -->
        <template v-else-if="activeTab === 'sessions'">
          <div v-if="activeSessions.length" class="pv-active-sessions">
            <div class="pv-commits-section-label" style="margin-top:0">
              <svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#34d399"/></svg>
              Active
            </div>
            <div v-for="s in activeSessions" :key="s.id" class="pv-asession-row" @click="openSession(s)">
              <div class="pv-asession-name">{{ s.name || s.id?.slice(0, 12) || '?' }}</div>
              <span class="pv-asession-badge" :class="s.busy ? 'busy' : 'idle'">{{ s.busy ? 'working' : 'idle' }}</span>
            </div>
          </div>
          <div v-if="sessions.length" class="pv-active-sessions" :style="activeSessions.length ? 'margin-top:16px' : ''">
            <div class="pv-commits-section-label" :style="activeSessions.length ? '' : 'margin-top:0'">Recent</div>
            <div v-for="s in sessions" :key="s.id" class="pv-asession-row" @click="openSession(s)">
              <div class="pv-asession-name">{{ s.name }}</div>
              <div class="pv-session-date">{{ fmtDate(s.updatedAt) }}</div>
            </div>
          </div>
          <div v-if="!activeSessions.length && !sessions.length" class="pv-empty">No sessions found.</div>
        </template>

        <!-- ── README TAB ────────────────────────────────────────── -->
        <template v-else-if="activeTab === 'readme'">
          <div v-if="readmeHtml" class="pv-readme" v-html="readmeHtml"></div>
          <div v-else class="pv-loading">Loading…</div>
        </template>

      </div>
    </template>

    <!-- ── Push confirmation dialog ──────────────────────────────── -->
    <div v-if="confirmPush" class="pv-dialog-overlay" @click.self="confirmPush = false">
      <div class="pv-dialog">
        <div class="pv-dialog-title">Push to remote?</div>
        <div class="pv-dialog-body">This will push the current branch to origin. Are you sure?</div>
        <div class="pv-dialog-actions">
          <button class="pv-dialog-cancel" @click="confirmPush = false">Cancel</button>
          <button class="pv-action-btn pv-push-btn" @click="doPush">Push</button>
        </div>
      </div>
    </div>

    <!-- ── Create branch dialog ───────────────────────────────────── -->
    <div v-if="showCreateBranch" class="pv-dialog-overlay" @click.self="showCreateBranch = false">
      <div class="pv-dialog">
        <div class="pv-dialog-title">Create branch</div>
        <div class="pv-dialog-body">
          <input
            class="pv-dialog-input"
            v-model="newBranchName"
            placeholder="Branch name"
            @keydown.enter="doCreateBranch"
            @keydown.escape="showCreateBranch = false"
            autofocus
          />
          <div class="pv-dialog-option">
            <SbSwitch v-model="checkoutBranch" />
            <span>Checkout branch</span>
          </div>
        </div>
        <div class="pv-dialog-actions">
          <SbButton variant="ghost" @click="showCreateBranch = false">Cancel</SbButton>
          <SbButton variant="primary" :disabled="!newBranchName.trim()" @click="doCreateBranch">Create</SbButton>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { store } from '../store.js';
import FileTreeNode from './FileTreeNode.vue';
import SbButton from './SbButton.vue';
import SbSwitch from './SbSwitch.vue';
import ProjectAvatar from './ProjectAvatar.vue';

const TABS = computed(() => [
  { id: 'overview', label: 'Overview' },
  { id: 'commits', label: unpushedCount.value ? `Commits (${unpushedCount.value})` : 'Commits' },
  { id: 'files', label: 'Files' },
  { id: 'sessions', label: activeSessions.value.length ? `Sessions (${activeSessions.value.length})` : 'Sessions' },
  ...(detail.value?.readmePath ? [{ id: 'readme', label: 'README' }] : []),
]);

const props = defineProps({ callbacks: { type: Object, required: true } });

const project = ref(null);
const worktrees = ref([]);
const viewedPath = ref('');
const detail = ref(null);
const loading = ref(false);
const activeTab = ref('overview');
watch(activeTab, (tab) => props.callbacks.onTabChange?.(tab));

// Incremented each time open() is called so the watcher fires
// even when the same project path is re-opened (net-zero ref change
// would otherwise suppress the Vue watcher).
const _openCount = ref(0);

// Git actions
const branches = ref([]);
const remoteBranches = ref([]);
const gitBusy = ref(false);
const gitMessage = ref('');
const gitError = ref(false);
const commitMessage = ref('');
const generating = ref(false);
const confirmPush = ref(false);

// Create branch dialog
const showCreateBranch = ref(false);
const newBranchName = ref('');
const checkoutBranch = ref(true);

// Avatar
const avatarDataUrl = ref(null);
const avatarLoading = ref(false);

// README
const readmeHtml = ref('');

// Changed files
const loadingFile = ref(null);

// Diff / file overlay
const activeDiff = ref(null);
const activeFile = ref(null);
const fileContent = ref('');
const fileModified = ref(false);
const fileSaving = ref(false);
const diffContainerRef = ref(null);
let editorView = null;

// File tree
const fileTree = ref([]);
const treeLoading = ref(false);
const treeSearch = ref('');

// Sessions
const sessions = ref([]);
const activeSessions = ref([]);

// Git user identity
const gitUser = ref({ name: '', email: '' });

// ── Computed ──────────────────────────────────────────────────────
const avatar = computed(() =>
  project.value && window.getProjectAvatar
    ? window.getProjectAvatar(project.value.projectPath)
    : { initials: '?', color: '#666' }
);
const projectName = computed(() =>
  project.value?.projectPath.split('/').filter(Boolean).pop() || ''
);
const changedFiles = computed(() => detail.value?.changedFiles || []);
const unpushedCommits = computed(() => detail.value?.unpushedCommits || []);
const unpushedCount = computed(() => unpushedCommits.value.length);
const currentFileIndex = computed(() =>
  changedFiles.value.findIndex(f => f.file === activeDiff.value?.filePath)
);
const overlayTitle = computed(() => {
  if (activeDiff.value) return basename(activeDiff.value.filePath);
  if (activeFile.value) return basename(activeFile.value);
  return '';
});
const overlayPath = computed(() => activeDiff.value?.filePath || activeFile.value || '');

const filteredTree = computed(() => {
  if (!treeSearch.value) return fileTree.value;
  return filterTree(fileTree.value, treeSearch.value.toLowerCase());
});

const mrLink = computed(() => {
  const url = detail.value?.remoteUrl;
  const branch = detail.value?.branch;
  if (!url) return null;
  // Normalise SSH → HTTPS: git@host:path.git → https://host/path
  let base = url.trim();
  const ssh = base.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) base = `https://${ssh[1]}/${ssh[2]}`;
  else base = base.replace(/\.git$/, '');
  if (base.includes('github.com')) {
    return { type: 'github', label: 'Pull Requests', listUrl: `${base}/pulls` };
  }
  if (base.includes('gitlab')) {
    return { type: 'gitlab', label: 'Merge Requests', listUrl: `${base}/-/merge_requests` };
  }
  return null;
});

// ── Utils ─────────────────────────────────────────────────────────
function basename(p) { return p ? p.replace(/\\/g, '/').split('/').pop() || p : ''; }
function fmtDate(t) {
  if (!t) return '';
  try { return window.formatDate ? window.formatDate(new Date(t)) : new Date(t).toLocaleDateString(); } catch { return ''; }
}

function fileStatus(f) {
  if (!f.added && f.deleted) return 'deleted';
  if (f.added && !f.deleted) return 'added';
  return 'modified';
}
function fileStatusChar(f) {
  if (!f.added && f.deleted) return 'D';
  if (f.added && !f.deleted) return 'A';
  return 'M';
}

function filterTree(nodes, q) {
  const result = [];
  for (const n of nodes) {
    if (n.isDir) {
      const children = filterTree(n.children || [], q);
      if (children.length) result.push({ ...n, children, _expanded: true });
    } else if (n.name.toLowerCase().includes(q)) {
      result.push(n);
    }
  }
  return result;
}

// ── Data loading ──────────────────────────────────────────────────
watch([viewedPath, _openCount], async ([p]) => {
  if (!p) return;
  activeDiff.value = null;
  activeFile.value = null;
  commitMessage.value = '';
  avatarDataUrl.value = null;
  readmeHtml.value = '';
  if (activeTab.value === 'readme') activeTab.value = 'overview';
  loadAvatar();
  // Show stale cache immediately — no blank flash
  const cached = await window.api.getProjectGitCache(p).catch(() => null);
  if (cached) {
    detail.value = cached;
    loading.value = false;
  } else {
    detail.value = null;
    loading.value = true;
  }
  // Load branches + sessions in parallel with fresh detail
  const rootPath = project.value?.projectPath;
  const [det, br, sess, terminals, userInfo] = await Promise.all([
    window.api.getProjectDetail(p).catch(() => null),
    window.api.gitBranches(p).catch(() => null),
    window.api.getProjectSessions(rootPath || p).catch(() => null),
    window.api.getActiveTerminals().catch(() => null),
    window.api.getGitUserInfo(p).catch(() => null),
  ]);
  detail.value = det || detail.value;
  if (det) _pushProjectInfo(p, det);
  branches.value = br?.ok ? br.branches : [];
  remoteBranches.value = br?.ok ? (br.remotes || []) : [];
  if (sess?.ok) sessions.value = sess.sessions;
  if (userInfo?.ok) gitUser.value = { name: userInfo.name, email: userInfo.email };
  if (terminals) {
    activeSessions.value = Object.values(terminals)
      .filter(t => t.projectPath === (rootPath || p) && !t.exited)
      .map(t => ({ id: t.id, name: t.title || t.id?.slice(0, 12), busy: t.busy || false }));
  }
  // Reconcile worktrees against actual git state (source of truth: git worktree list)
  if (det?.worktreePaths !== undefined) {
    const wtPattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;
    const actualPaths = new Set(det.worktreePaths);
    // Remove stale entries
    const stale = worktrees.value.filter(w => !actualPaths.has(w.projectPath));
    if (stale.length) {
      stale.forEach(w => props.callbacks.worktreeDeleted?.(w.projectPath));
      if (!actualPaths.has(viewedPath.value)) setViewedPath(rootPath || p);
    }
    // Add new entries not yet in store.projects
    const known = new Set(worktrees.value.map(w => w.projectPath));
    const added = det.worktreePaths
      .filter(wp => !known.has(wp))
      .map(wp => { const m = wp.match(wtPattern); return m ? { projectPath: wp, name: m[2] } : null; })
      .filter(Boolean);
    if (stale.length || added.length) {
      worktrees.value = [
        ...worktrees.value.filter(w => actualPaths.has(w.projectPath)),
        ...added,
      ];
    }
  }
  loading.value = false;
});

watch(activeTab, async (tab) => {
  if (tab === 'files' && !fileTree.value.length && viewedPath.value) {
    treeLoading.value = true;
    const res = await window.api.getFileTree(viewedPath.value).catch(() => null);
    if (res?.ok) fileTree.value = res.tree;
    treeLoading.value = false;
  }
  if (tab === 'readme' && !readmeHtml.value && detail.value?.readmePath) {
    const res = await window.api.readFileForPanel(detail.value.readmePath).catch(() => null);
    const content = res?.ok ? res.content : '';
    readmeHtml.value = content && window.marked ? window.marked.parse(content) : content;
  }
});

// ── Diff overlay ──────────────────────────────────────────────────
watch([activeDiff, activeFile], async ([diff, file]) => {
  if (editorView) {
    try { typeof editorView.destroy === 'function' ? editorView.destroy() : editorView.a?.destroy(); } catch {}
    editorView = null;
  }
  if (!diff && !file) return;
  await nextTick();
  const el = diffContainerRef.value;
  if (!el) return;
  el.innerHTML = '';
  if (diff) {
    editorView = window.createReadOnlyMergeViewer?.(el, diff.oldContent, diff.newContent, diff.filePath);
  } else if (file) {
    editorView = window.createEditableViewer?.(el, fileContent.value, file);
    if (editorView) {
      editorView.dom?.addEventListener('input', () => { fileModified.value = true; });
    }
  }
});

async function openDiff(filePath) {
  if (loadingFile.value) return;
  loadingFile.value = filePath;
  try {
    const result = await window.api.getFileDiff(viewedPath.value, filePath);
    if (!result?.ok) return;
    activeFile.value = null;
    activeDiff.value = { filePath, oldContent: result.oldContent, newContent: result.newContent };
  } finally { loadingFile.value = null; }
}

async function openFileFromTree(path) {
  const fullPath = `${viewedPath.value}/${path}`;
  const res = await window.api.readFileForPanel(fullPath).catch(() => null);
  if (!res?.ok) return;
  fileContent.value = res.content;
  fileModified.value = false;
  activeDiff.value = null;
  activeFile.value = fullPath;
}

async function saveFile() {
  if (!activeFile.value || !editorView) return;
  fileSaving.value = true;
  const content = editorView.state?.doc?.toString?.() ?? fileContent.value;
  await window.api.saveFileForPanel(activeFile.value, content).catch(() => {});
  fileModified.value = false;
  fileSaving.value = false;
}

function closeOverlay() {
  activeDiff.value = null;
  activeFile.value = null;
}
function prevFile() {
  const i = currentFileIndex.value;
  if (i > 0) openDiff(changedFiles.value[i - 1].file);
}
function nextFile() {
  const i = currentFileIndex.value;
  if (i < changedFiles.value.length - 1) openDiff(changedFiles.value[i + 1].file);
}

// ── Git actions ───────────────────────────────────────────────────
function showGitMsg(msg, isError = false, ms = 4000) {
  gitMessage.value = msg; gitError.value = isError;
  setTimeout(() => { gitMessage.value = ''; gitError.value = false; }, ms);
}

async function switchBranch(branch) {
  if (branch === detail.value?.branch) return;
  gitBusy.value = true;
  const res = await window.api.gitCheckout(viewedPath.value, branch);
  gitBusy.value = false;
  if (res.ok) { showGitMsg(`Switched to ${branch}`); await reload(); }
  else showGitMsg(res.error || 'Checkout failed', true);
}

async function doFetch() {
  gitBusy.value = true;
  showGitMsg('Fetching…');
  const res = await window.api.gitFetch(viewedPath.value);
  gitBusy.value = false;
  if (res.ok) { showGitMsg('Fetched'); const br = await window.api.gitBranches(viewedPath.value); if (br?.ok) { branches.value = br.branches; remoteBranches.value = br.remotes || []; } }
  else showGitMsg(res.error || 'Fetch failed', true);
}

async function doPull() {
  gitBusy.value = true;
  showGitMsg('Pulling…');
  const res = await window.api.gitPull(viewedPath.value);
  gitBusy.value = false;
  if (res.ok) { showGitMsg('Pulled'); await reload(); }
  else showGitMsg(res.error || 'Pull failed', true);
}

async function generateCommitMsg(style = 'short') {
  generating.value = true; gitBusy.value = true;
  const res = await window.api.gitGenerateCommitMsg(viewedPath.value, style);
  generating.value = false; gitBusy.value = false;
  if (res.ok) commitMessage.value = res.message;
  else showGitMsg(res.error || 'Generation failed', true);
}

async function doCommit() {
  if (!commitMessage.value.trim()) return;
  gitBusy.value = true;
  const res = await window.api.gitCommit(viewedPath.value, commitMessage.value.trim());
  gitBusy.value = false;
  if (res.ok) { showGitMsg('Committed'); commitMessage.value = ''; await reload(); }
  else showGitMsg(res.error || 'Commit failed', true);
}

async function doPush() {
  confirmPush.value = false;
  gitBusy.value = true;
  showGitMsg('Pushing…');
  const res = await window.api.gitPush(viewedPath.value);
  gitBusy.value = false;
  if (res.ok) { showGitMsg('Pushed successfully'); await reload(); }
  else showGitMsg(res.error || 'Push failed', true);
}

async function doCreateBranch() {
  const name = newBranchName.value.trim();
  if (!name) return;
  showCreateBranch.value = false;
  gitBusy.value = true;
  const res = await window.api.gitCreateBranch(viewedPath.value, name, checkoutBranch.value);
  gitBusy.value = false;
  if (res.ok) {
    showGitMsg(checkoutBranch.value ? `Switched to new branch "${name}"` : `Created branch "${name}"`);
    newBranchName.value = '';
    checkoutBranch.value = true;
    const br = await window.api.gitBranches(viewedPath.value).catch(() => null);
    if (br?.ok) { branches.value = br.branches; remoteBranches.value = br.remotes || []; }
    await reload();
  } else {
    showGitMsg(res.error || 'Failed to create branch', true);
  }
}

async function reload() {
  const p = viewedPath.value;
  if (!p) return;
  const det = await window.api.getProjectDetail(p).catch(() => null);
  detail.value = det;
  _pushProjectInfo(p, det);
}

const statsRefreshing = ref(false);

async function refreshStats() {
  const p = viewedPath.value;
  if (!p || statsRefreshing.value) return;
  statsRefreshing.value = true;
  try {
    const [det, br] = await Promise.all([
      window.api.getProjectDetail(p).catch(() => null),
      window.api.gitBranches(p).catch(() => null),
    ]);
    if (det) detail.value = det;
    if (br?.ok) { branches.value = br.branches; remoteBranches.value = br.remotes || []; }
    _pushProjectInfo(p, det);
  } finally {
    statsRefreshing.value = false;
  }
}

function _pushProjectInfo(path, det) {
  if (!det) return;
  window.vueProjects?.updateProjectInfo(path, {
    branch: det.branch,
    added: det.totalAdded,
    deleted: det.totalDeleted,
    unpushedCount: det.unpushedCommits?.length ?? 0,
    containers: det.containers,
  });
}

function setViewedPath(path) {
  if (path === viewedPath.value) return;
  fileTree.value = [];
  viewedPath.value = path;
}

async function deleteWorktree(wt) {
  if (!confirm(`Delete worktree "${wt.name}" and its branch?\n\nThis cannot be undone.`)) return;
  const res = await window.api.deleteWorktree(project.value.projectPath, wt.projectPath);
  if (!res.ok) { showGitMsg(res.error || 'Failed to delete worktree', true); return; }
  if (viewedPath.value === wt.projectPath) setViewedPath(project.value.projectPath);
  worktrees.value = worktrees.value.filter(w => w.projectPath !== wt.projectPath);
  showGitMsg(`Deleted worktree "${wt.name}"${res.branch ? ` and branch "${res.branch}"` : ''}`);
  props.callbacks.worktreeDeleted?.(wt.projectPath);
}

function openSession(s) { window.__sb?.openSessionById?.(s.id); }
function openExternal(url) { window.api?.openExternal?.(url); }

async function loadAvatar() {
  if (!project.value) return;
  const url = await window.api.getProjectAvatar(project.value.projectPath).catch(() => null);
  avatarDataUrl.value = url;
  if (url) store.avatarDataUrls[project.value.projectPath] = url;
}

async function updateAvatar() {
  if (!project.value || !detail.value?.remoteUrl) return;
  avatarLoading.value = true;
  try {
    const url = await window.api.fetchGitlabAvatar(project.value.projectPath, detail.value.remoteUrl);
    avatarDataUrl.value = url;
    if (url) store.avatarDataUrls[project.value.projectPath] = url;
    else delete store.avatarDataUrls[project.value.projectPath];
  } catch (e) {
    console.error('Avatar fetch failed:', e);
  } finally {
    avatarLoading.value = false;
  }
}
function newSession(e) { if (project.value) props.callbacks.newSession?.(project.value, e?.currentTarget); }

// ── Periodic git refresh when active sessions are running ─────────
let _gitRefreshTimer = null;

onMounted(() => {
  _gitRefreshTimer = setInterval(async () => {
    const p = viewedPath.value;
    if (!p || !activeSessions.value.length) return;
    const det = await window.api.getProjectDetail(p).catch(() => null);
    if (det) detail.value = det;
  }, 30000);
});

onUnmounted(() => clearInterval(_gitRefreshTimer));

// ── Expose ────────────────────────────────────────────────────────
defineExpose({
  open(proj, wts = []) {
    project.value = proj;
    worktrees.value = wts;
    viewedPath.value = proj?.projectPath || '';
    _openCount.value++;
  },
  close() { project.value = null; worktrees.value = []; viewedPath.value = ''; detail.value = null; activeDiff.value = null; activeFile.value = null; },
  setTab(tab) { activeTab.value = tab; },
  setViewedPath,
});
</script>
