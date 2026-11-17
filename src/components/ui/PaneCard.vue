<script setup lang="ts">
/*
 * 面板卡：标题条 + 内容区。
 * 标题条用浅灰底而不是白底 —— 白底标题在整片白卡片里会「找不到头」。
 */
defineProps<{ title?: string; right?: string }>();
</script>

<template>
  <section class="pane">
    <header v-if="title" class="ph">
      <span class="ph__t">{{ title }}</span>
      <span v-if="right" class="ph__r">{{ right }}</span>
    </header>
    <div class="pb"><slot /></div>
  </section>
</template>

<style scoped>
.pane {
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  box-shadow: var(--sh-card);
}
.ph {
  display: flex;
  align-items: center;
  gap: var(--s2);
  position: relative;
  min-height: 52px;
  padding: 0 var(--s5);
  background: var(--panel-soft);
}
.ph::after {
  content: '';
  position: absolute;
  right: var(--s5);
  bottom: 0;
  left: var(--s5);
  height: 1px;
  border-radius: 999px;
  background: linear-gradient(90deg, transparent, var(--bd) 12%, var(--bd) 88%, transparent);
}
.ph__t {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--t1);
  letter-spacing: -0.01em;
}
.ph__r {
  margin-left: auto;
  color: var(--t3);
  font-size: 12.5px;
  font-family: var(--mono);
}
.pb {
  padding: var(--s5);
}
</style>
