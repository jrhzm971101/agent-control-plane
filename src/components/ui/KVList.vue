<script setup lang="ts">
/*
 * 键值列表：左列定宽，多块清单叠在一起时键是对齐的。
 *
 * labelWidth 只在键是「标识符」时用得到：max-context-tokens 这种长键在 96px 里
 * 会被从连字符处折成两行，行高跟着变，同一张卡里就参差不齐了。
 * 中文键保持默认宽度，不要把全站的键列一起放宽（值列会跟着变窄）。
 */
import AppBadge from './AppBadge.vue';
import type { KVItem } from './types';

withDefaults(defineProps<{ items: KVItem[]; labelWidth?: string }>(), {
  labelWidth: '96px',
});
</script>

<template>
  <dl class="kv" :style="{ '--kv-label-w': labelWidth }">
    <template v-for="item in items" :key="item.label">
      <dt>{{ item.label }}</dt>
      <dd :class="{ mono: item.mono }">
        <AppBadge v-if="item.badge" :variant="item.badge.variant">{{ item.badge.text }}</AppBadge>
        <!--
          带 to 的值渲染成链接（见 ui/types.ts 的 KVItem.to）。
          做成"等宽的虚线下划线"而不是蓝色实线：键值对里的一列链接如果都上色，
          整块清单会变成一片蓝，反而看不出哪一条才是当前要点的那个。
          虚线下划线保留"这是可点的"这个信号，同时让文字仍然读起来像标识。
        -->
        <router-link v-else-if="item.to" class="lk" :to="item.to">{{ item.value }}</router-link>
        <template v-else>{{ item.value }}</template>
        <!-- 补充说明：字号比正文小一档、透明度压一层，读键值对时不会抢视线 -->
        <div v-if="item.note" class="nt">{{ item.note }}</div>
      </dd>
    </template>
  </dl>
</template>

<style scoped>
.kv {
  display: grid;
  grid-template-columns: var(--kv-label-w) minmax(0, 1fr);
  gap: var(--s2) var(--s3);
  margin: 0;
  font-size: 13.5px;
}
dt {
  color: var(--t3);
  line-height: 1.6;
}
dd {
  margin: 0;
  color: var(--t2);
  line-height: 1.6;
  word-break: break-word;
  font-variant-numeric: tabular-nums;
}
dd.mono {
  font-family: var(--mono);
  font-size: 12.5px;
}
.nt {
  margin-top: 2px;
  color: var(--t3);
  font-size: 12.5px;
  line-height: 1.6;
  opacity: 0.9;
}

</style>
