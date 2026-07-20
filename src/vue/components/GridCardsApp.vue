<template>
  <template v-for="[sessionId, card] in activeCards" :key="sessionId">
    <Teleport :to="card.headerEl">
      <span
        class="grid-card-avatar"
        :class="card.busy ? 'busy' : card.running ? 'running' : 'stopped'"
        :style="{ background: card.color }"
      >{{ card.initials }}</span>
      <span class="grid-card-name">{{ card.name }}</span>
      <span class="grid-card-project">{{ card.project }}</span>
      <button
        v-if="card.running"
        class="grid-card-stop-btn"
        data-tooltip="Stop session"
        @click.stop="stop(sessionId)"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
          <rect x="2" y="2" width="8" height="8" rx="1"/>
        </svg>
      </button>
    </Teleport>
    <Teleport :to="card.footerEl">
      <span>{{ card.running ? 'Running' : 'Stopped' }}</span>
      <span>{{ card.time }}</span>
    </Teleport>
  </template>
</template>

<script setup>
import { reactive } from 'vue';

const activeCards = reactive(new Map());

function stop(sessionId) {
  window.confirmAndStopSession?.(sessionId);
}

defineExpose({
  addCard(sessionId, headerEl, footerEl, { name, project, initials, color, running, busy, time }) {
    activeCards.set(sessionId, { headerEl, footerEl, name, project, initials, color, running: !!running, busy: !!busy, time: time || '' });
  },

  updateCard(sessionId, running, busy, time) {
    const card = activeCards.get(sessionId);
    if (!card) return;
    card.running = !!running;
    card.busy = !!busy;
    if (time !== undefined) card.time = time;
  },

  removeCard(sessionId) {
    activeCards.delete(sessionId);
  },

  clearAll() {
    activeCards.clear();
  },
});
</script>
