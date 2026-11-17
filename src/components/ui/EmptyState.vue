<script setup lang="ts">
/* 空状态：图标 + 一句结论 + 一句可执行的下一步，不用插画。 */
withDefaults(defineProps<{ title?: string; hint?: string }>(), { title: '没有匹配的记录' });
</script>

<template>
  <div class="es">
    <svg
      class="es__ic"
      width="30"
      height="30"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 9h18" />
      <path d="M8.5 13.5h7" />
    </svg>
    <p class="es__t">{{ title }}</p>
    <p v-if="hint" class="es__h">{{ hint }}</p>
    <div v-if="$slots.action" class="es__a"><slot name="action" /></div>
  </div>
</template>

<style scoped>
.es {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--s8) var(--s5);
  text-align: center;
}
.es__ic {
  color: var(--bd-strong);
  margin-bottom: var(--s3);
}
.es__t {
  margin: 0;
  font-size: 14px;
  font-weight: 550;
  color: var(--t2);
}
.es__h {
  margin: 6px 0 0;
  max-width: 340px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--t3);
}
.es__a {
  margin-top: var(--s4);
}
</style>
