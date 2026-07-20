<template>
  <div
    class="session-item"
    :class="[...classes, { active }]"
    :id="itemId"
    @click="$emit('click')"
  >
    <div class="session-row">
      <slot name="leading" />
      <div class="session-info">
        <div class="session-summary">{{ title }}</div>
        <div v-if="subtitle" class="session-subtitle">{{ subtitle }}</div>
        <div v-if="meta" class="session-meta">{{ meta }}</div>
      </div>
      <slot name="trailing" />
    </div>
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: null },
  meta: { type: String, default: null },
  active: { type: Boolean, default: false },
  classes: { type: Array, default: () => [] },
  itemId: { type: String, default: undefined },
});
defineEmits(['click']);
</script>
