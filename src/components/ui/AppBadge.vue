<script setup lang="ts">
/*
 * 状态徽标：浅底 + 同色描边 + 深色文字。
 *
 * 底色浅、文字深是刻意的 —— 徽标常和正文同排，底色太重会把整行的视觉重心拉过去。
 * 每个 variant 都同时用了底色和文字色两重区分，色觉障碍下也还能读出差别。
 */
import type { BadgeVariant } from './types';

defineProps<{ variant: BadgeVariant }>();
</script>

<template>
  <span class="bdg" :class="variant"><slot /></span>
</template>

<style scoped>
.bdg {
  display: inline-block;
  padding: 1px 8px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  letter-spacing: 0.01em;
}
/* 主色族：Harness / 外部接入 */
.harness,
.external {
  background: var(--pri-soft);
  border-color: var(--pri-line);
  color: var(--pri-ink);
}
/* 中性：ReAct / 已停用 / 等待 */
.react,
.off {
  background: var(--panel-soft);
  border-color: var(--bd);
  color: var(--t2);
}
.off {
  color: var(--t3);
}
.wait {
  background: var(--panel-tint);
  border-color: var(--bd);
  color: var(--t2);
}
/* 成功族：托管 / 只读 / 正常 */
.managed,
.ro,
.ok {
  background: var(--grn-bg);
  border-color: var(--grn-line);
  color: var(--grn);
}
/* 警示族：驻场 / 读写 / 待补 */
.hosted,
.rw {
  background: var(--amb-bg);
  border-color: var(--amb-line);
  color: var(--amb);
}
/* 失败 */
.err {
  background: var(--red-bg);
  border-color: var(--red-line);
  color: var(--red);
}
</style>
