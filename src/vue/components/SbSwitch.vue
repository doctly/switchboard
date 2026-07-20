<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    class="sb-switch"
    :class="{ 'sb-switch--on': modelValue }"
    @click="toggle"
  >
    <span class="sb-switch-thumb" />
  </button>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);
function toggle() {
  if (!props.disabled) emit('update:modelValue', !props.modelValue);
}
</script>
