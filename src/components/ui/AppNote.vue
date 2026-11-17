<script setup lang="ts">
/* 说明块：左侧 2px 竖条表示语气，底色保持中性，避免整页花花绿绿。 */
withDefaults(defineProps<{ tone?: 'default' | 'warn' }>(), { tone: 'default' });
</script>

<template>
  <div class="note" :class="tone">
    <slot />
  </div>
</template>

<style scoped>
.note {
  padding: 10px 12px;
  border: 1px solid var(--bd);
  border-left: 2px solid var(--pri);
  border-radius: var(--r-md);
  background: var(--panel-soft);
  color: var(--t2);
  font-size: 13px;
  line-height: 1.65;
}
.note.warn {
  border-left-color: var(--red);
}
.note :deep(b) {
  color: var(--t1);
  font-weight: 600;
}
</style>
