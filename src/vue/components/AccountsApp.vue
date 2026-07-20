<template>
  <div>
    <div class="project-group">
      <div class="project-header">
        <span class="project-name">Accounts</span>
      </div>
      <div class="project-sessions">
        <div
          v-for="acc in accounts"
          :key="acc.id"
          class="session-item account-item"
          :class="{ active: acc.id === activeAccountId }"
          @click="onSwitch(acc)"
        >
          <div class="session-row">
            <div class="account-name-row">
              <template v-if="editingId === acc.id">
                <input
                  class="account-row-name-input"
                  v-model="editName"
                  :ref="el => { if (el) activeEditInput = el }"
                  @blur="saveEdit(acc)"
                  @keydown.enter.prevent="saveEdit(acc)"
                  @keydown.escape="cancelEdit"
                  @click.stop
                />
              </template>
              <template v-else>
                <div class="session-summary" @dblclick.stop="startEdit(acc)">{{ acc.name }}</div>
              </template>
              <div class="account-card-actions">
                <button
                  v-if="editingId !== acc.id"
                  class="account-edit-btn"
                  data-tooltip="Rename"
                  @click.stop="startEdit(acc)"
                  v-html="editSvg"
                ></button>
                <button
                  class="account-open-btn"
                  data-tooltip="Open Claude session in home directory"
                  @click.stop="onOpenClaude(acc)"
                >Open Claude</button>
                <button
                  v-if="acc.id !== 'default'"
                  class="account-row-del"
                  data-tooltip="Remove account"
                  @click.stop="onDelete(acc)"
                  v-html="trashSvg"
                ></button>
              </div>
            </div>
            <div class="session-subtitle">{{ acc.configDir || '~/.claude (default)' }}</div>
            <div v-if="hasUsage(acc.id)" class="account-usage-block">
              <div v-for="row in usageRows(acc.id)" :key="row.key" class="account-usage-row">
                <span class="account-usage-label">{{ row.label }}</span>
                <div class="account-usage-bar">
                  <div
                    class="account-usage-bar-fill"
                    :class="{ danger: row.pct >= 90, warn: row.pct >= 70 && row.pct < 90 }"
                    :style="{ width: Math.min(row.pct, 100) + '%' }"
                  ></div>
                </div>
                <span class="account-usage-info">{{ row.pct }}%{{ row.resetIn ? `  · resets in ${row.resetIn}~` : '' }}</span>
              </div>
              <div v-if="usage[acc.id]?._cached" class="account-usage-cached-note">cached data</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="project-group">
      <div class="project-header" :class="{ collapsed: !addOpen }" @click="addOpen = !addOpen">
        <span class="arrow">&#9660;</span>
        <span class="project-name">Add account</span>
      </div>
      <div class="project-sessions accounts-add-section">
        <p class="accounts-add-desc">Each account uses its own Claude credentials and session history. Add a second account to switch between personal and work Claude Pro plans, or any two separate logins.</p>
        <div class="accounts-add-form">
          <input
            v-model="newName"
            placeholder="Account name (e.g. Work / Personal)"
            @keydown.enter="addAccount"
          />
          <div class="text-center">
            <button class="btn-green" :disabled="adding" @click="addAccount">
              {{ adding ? 'Adding…' : 'Add account' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

const accounts = ref([]);
const activeAccountId = ref('default');
const usage = ref({});
const editingId = ref(null);
const editName = ref('');
let activeEditInput = null;
const newName = ref('');
const adding = ref(false);
const addOpen = ref(false);

function hasUsage(id) {
  const u = usage.value[id];
  if (!u || u._error || u._rateLimited) return false;
  return u.session != null || u.weekAll != null;
}

function usageRows(id) {
  const u = usage.value[id] || {};
  const rows = [];
  if (u.session != null) rows.push({ key: 'session', label: '5h', pct: u.session, resetIn: u.sessionResetIn });
  if (u.weekAll != null) rows.push({ key: 'weekAll', label: '7d', pct: u.weekAll, resetIn: u.weekAllResetIn });
  return rows;
}

async function startEdit(acc) {
  editingId.value = acc.id;
  editName.value = acc.name;
  activeEditInput = null;
  await nextTick();
  activeEditInput?.focus();
  activeEditInput?.select();
}

async function saveEdit(acc) {
  if (editingId.value !== acc.id) return;
  editingId.value = null;
  const newN = editName.value.trim() || acc.name;
  if (newN !== acc.name) {
    acc.name = newN;
    await props.callbacks.renameAccount?.(acc.id, newN);
  }
}

function cancelEdit() {
  editingId.value = null;
}

async function onSwitch(acc) {
  if (acc.id !== activeAccountId.value) {
    await props.callbacks.switchAccount?.(acc.id);
  }
}

function onOpenClaude(acc) {
  props.callbacks.openAccountHomeSession?.(acc);
}

async function onDelete(acc) {
  if (!confirm(`Remove account "${acc.name}"?`)) return;
  props.callbacks.deleteAccount?.(acc.id);
}

async function addAccount() {
  const name = newName.value.trim();
  if (!name) return;
  adding.value = true;
  const newAcc = await props.callbacks.createAccount?.(name);
  adding.value = false;
  if (newAcc) newName.value = '';
}

defineExpose({
  setAccounts(list, activeId) {
    accounts.value = list;
    if (activeId !== undefined) activeAccountId.value = activeId;
  },
  setActiveAccount(id) { activeAccountId.value = id; },
  setUsage(usageObj) { usage.value = { ...usageObj }; },
});

const editSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const trashSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
</script>
