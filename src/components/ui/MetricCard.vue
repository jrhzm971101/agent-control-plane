<script setup lang="ts">
/*
 * 指标卡：标签 + 大数字 + 口径说明。
 *
 * 数字用等宽数字，一排卡片横向读过去位数是对齐的；
 * 「值」与「单位」字号拉开，避免 12M 被读成 12M 个东西。
 */
import AppBadge from './AppBadge.vue';
import type { BadgeVariant } from './types';

defineProps<{
  label: string;
  value: string;
  unit?: string;
  badge?: { text: string; variant: BadgeVariant };
  footer?: string;
}>();
</script>

<template>
  <article class="card">
    <div class="r1">
      <div class="nm">{{ label }}</div>
      <AppBadge v-if="badge" :variant="badge.variant">{{ badge.text }}</AppBadge>
    </div>
    <div class="v">{{ value }}<span v-if="unit">{{ unit }}</span></div>
    <div v-if="footer" class="ft">{{ footer }}</div>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  padding: var(--s5);
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  box-shadow: var(--sh-card);
}
.r1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s2);
  margin-bottom: var(--s3);
}
.nm {
  font-size: 14px;
  font-weight: 600;
  color: var(--t2);
  letter-spacing: 0.01em;
}
.v {
  font-size: 32px;
  font-weight: 620;
  line-height: 1.1;
  letter-spacing: -0.025em;
  color: var(--t1);
  font-variant-numeric: tabular-nums;
}
.v span {
  margin-left: 2px;
  font-size: 15px;
  font-weight: 500;
  color: var(--t3);
}
.ft {
  margin-top: var(--s2);
  color: var(--t3);
  font-size: 12.5px;
  line-height: 1.6;
}
</style>
