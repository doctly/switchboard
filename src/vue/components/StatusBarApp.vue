<template>
  <span>{{ info }}</span>
  <span :class="activityClass">{{ activity }}</span>
  <span>{{ updater }}</span>
</template>

<script setup>
import { ref } from 'vue';

const info = ref('');
const activity = ref('');
const activityClass = ref('');
const updater = ref('');

let activityTimer = null;
let updaterTimer = null;

defineExpose({
  setInfo(text) {
    info.value = text;
  },

  setActivity(text, type) {
    if (activityTimer) clearTimeout(activityTimer);
    activity.value = text;
    activityClass.value = type === 'done' ? 'status-done' : '';
    if (!text || type === 'done') {
      activityTimer = setTimeout(() => {
        activity.value = '';
        activityClass.value = '';
      }, type === 'done' ? 3000 : 0);
    }
  },

  setUpdater(text, duration) {
    if (updaterTimer) clearTimeout(updaterTimer);
    updater.value = text;
    if (duration) {
      updaterTimer = setTimeout(() => { updater.value = ''; }, duration);
    }
  },
});
</script>
