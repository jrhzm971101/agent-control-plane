<script setup lang="ts">
/* 运行 / 事件条目列表，轨迹页的 run 列与概览页的「需要关注」共用。 */
import StatusDot from './StatusDot.vue';
import type { RunItem } from './types';

defineProps<{ items: RunItem[]; selectedId?: string; selectable?: boolean }>();
defineEmits<{ select: [id: string] }>();
</script>

<template>
  <div class="runs">
    <div
      v-for="item in items"
      :key="item.id"
      class="runitem"
      :class="{ sel: selectable && item.id === selectedId, selectable }"
      @click="selectable && $emit('select', item.id)"
    >
      <div class="a">
        <StatusDot :tone="item.tone" />
        <b>{{ item.title }}</b>
      </div>
      <div v-if="item.meta" class="b">{{ item.meta }}</div>
      <div v-if="item.note" class="n" :title="item.note">{{ item.note }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 抵消 PaneCard 的内边距，让分隔线通到卡片边缘 */
.runs {
  margin: calc(var(--s4) * -1);
}
.runitem {
  padding: 11px var(--s4);
  border-bottom: 1px solid var(--bd-soft);
  transition: background-color var(--dur) var(--ease);
}
.runitem:last-child {
  border-bottom: none;
}
.runitem.selectable {
  cursor: pointer;
}
.runitem.selectable:hover {
  background: var(--panel-soft);
}
.runitem.sel {
  background: var(--pri-soft);
  box-shadow: inset 2px 0 0 var(--pri);
}
.a {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 3px;
}
.a b {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 570;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.b {
  display: flex;
  align-items: center;
  gap: var(--s2);
  color: var(--t3);
  font-size: 12px;
  font-family: var(--mono);
}
.n {
  margin-top: 3px;
  color: var(--t3);
  font-size: 12.5px;
  line-height: 1.6;
  /* 概览侧栏只负责让人决定要不要处理，完整说明不在这里铺开。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
