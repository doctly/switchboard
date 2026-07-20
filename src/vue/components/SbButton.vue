<template>
  <button
    :type="type"
    :disabled="disabled"
    class="sb-btn"
    :class="[`sb-btn--${variant}`, `sb-btn--${size}`]"
    @click="$emit('click', $event)"
  >
    <slot name="icon" />
    <slot />
  </button>
</template>

<script setup>
defineProps({
  variant: { type: String, default: 'secondary' }, // primary | secondary | ghost | danger | success
  size: { type: String, default: 'md' },            // sm | md
  type: { type: String, default: 'button' },
  disabled: { type: Boolean, default: false },
});
defineEmits(['click']);
</script>
