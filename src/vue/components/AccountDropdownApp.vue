<template>
  <button class="account-btn-vue" data-tooltip="Switch account" @click.stop="toggle">
    <span class="account-btn-dot"></span>
    <span class="account-btn-name">{{ activeName }}</span>
    <span class="account-btn-chips">
      <span v-for="chip in activeChips" :key="chip" class="account-chip">{{ chip }}</span>
    </span>
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1 1l4 4 4-4"/>
    </svg>
  </button>

  <div v-if="open" class="account-dropdown-vue">
    <div
      v-for="acc in accounts"
      :key="acc.id"
      class="acct-dd-item"
      :class="{ active: acc.id === activeAccountId }"
      @click="onSwitch(acc.id)"
    >
      <span class="acct-dd-dot"></span>
      <span class="acct-dd-name">{{ acc.name }}</span>
      <span class="acct-dd-chips">
        <span v-for="chip in chips(acc.id)" :key="chip" class="account-chip">{{ chip }}</span>
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

const accounts = ref([]);
const activeAccountId = ref('default');
const usage = ref({});
const open = ref(false);

const activeName = computed(() => {
  const acc = accounts.value.find(a => a.id === activeAccountId.value);
  return acc?.name ?? 'Default';
});

const activeChips = computed(() => chips(activeAccountId.value));

function chips(id) {
  const u = usage.value[id];
  if (!u || u._error || u._rateLimited) return [];
  const out = [];
  if (u.session != null) out.push(`${u.session}% 5h`);
  return out;
}

function toggle() {
  open.value = !open.value;
}

function close() {
  open.value = false;
}

async function onSwitch(id) {
  close();
  if (id !== activeAccountId.value) {
    await props.callbacks.switchAccount?.(id);
  }
}

function onDocumentClick() {
  close();
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick);
});

defineExpose({
  setAccounts(list, activeId, usageObj) {
    accounts.value = list;
    if (activeId !== undefined) activeAccountId.value = activeId;
    if (usageObj !== undefined) usage.value = usageObj;
  },
  setActiveAccount(id) { activeAccountId.value = id; },
  setUsage(usageObj) { usage.value = { ...usageObj }; },
  close,
});
</script>
