<template>
  <div>
    <div v-if="plans.length === 0" class="plans-empty">
      No plans found in ~/.claude/plans/
    </div>

    <div v-else class="project-group">
      <div class="project-header">
        <span class="project-name">Plans</span>
      </div>
      <div class="project-sessions">
        <ListItem
          v-for="plan in plans"
          :key="plan.filename"
          :title="plan.title || plan.filename"
          :subtitle="plan.filename"
          :meta="fmtDate(plan.modified)"
          :active="activePlan === plan.filename"
          :classes="['plan-item']"
          @click="openPlan(plan)"
        >
          <template #leading>
            <span class="memory-brain-icon" v-html="planSvg"></span>
          </template>
        </ListItem>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import ListItem from './ListItem.vue';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

const plans = ref([]);
const activePlan = ref(null);

function fmtDate(d) {
  return window.formatDate ? window.formatDate(new Date(d)) : d;
}

function openPlan(plan) {
  activePlan.value = plan.filename;
  props.callbacks.openPlan?.(plan);
}

// Bridge API
defineExpose({
  setPlans(list) { plans.value = list; },
  setActive(filename) { activePlan.value = filename; },
  clearActive() { activePlan.value = null; },
});

const planSvg = '<svg width="15" height="15" viewBox="0 0 17 17" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M14 2v-2h-13v17h13v-2h2v-13h-2zM2 16v-15h2v15h-2zM13 16h-8v-15h8v15zM15 14h-1v-3h1v3zM15 10h-1v-3h1v3zM14 6v-3h1v3h-1zM6 4h5v1h-5v-1zM6 6h4v1h-4v-1z"/></svg>';
</script>
