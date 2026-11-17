<script setup lang="ts">
/*
 * 筛选条：chips（可选）+ 字段区 + 结果计数 + 动作。
 *
 * 字段区用 flex-end 对齐 —— 有的字段带标签、有的带按钮，底边对齐才不会参差。
 * 结果计数放在右侧动作旁，筛选完能立刻确认「筛出来几条」，不用去数表。
 */
import { computed, useSlots } from 'vue';

const props = defineProps<{
  /** 结果计数。total 与 count 不同时显示「筛选出 x / 共 y」。 */
  result?: { count: number; total?: number; noun?: string };
}>();

const slots = useSlots();
const hasRow = computed(() => Boolean(slots.default || slots.actions || props.result));
const filtered = computed(
  () => props.result?.total !== undefined && props.result.total !== props.result.count,
);
</script>

<template>
  <section class="fbar">
    <div v-if="$slots.chips" class="fbar__chips"><slot name="chips" /></div>
    <div v-if="hasRow" class="fbar__row">
      <div class="fbar__fields"><slot /></div>
      <div class="fbar__side">
        <span v-if="result" class="fbar__count">
          <template v-if="filtered">筛选出 <b>{{ result.count }}</b> / 共 {{ result.total }}</template>
          <template v-else>共 <b>{{ result.count }}</b></template>
          {{ result.noun ?? '条' }}
        </span>
        <slot name="actions" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.fbar {
  /* 卡片内边距 20px、与下一个模块的间距 20px：和 .stack / PageHeader 同一节奏 */
  padding: var(--s5);
  margin-bottom: var(--s5);
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  box-shadow: var(--sh-card);
}
.fbar__chips {
  padding-bottom: var(--s3);
  margin-bottom: var(--s3);
  border-bottom: 1px solid var(--bd-soft);
}
.fbar__row {
  display: flex;
  align-items: flex-end;
  gap: var(--s3);
  flex-wrap: wrap;
}
.fbar__fields {
  display: flex;
  align-items: flex-end;
  gap: var(--s3);
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}
.fbar__side {
  display: flex;
  align-items: center;
  gap: var(--s3);
  margin-left: auto;
  /*
   * 撑成恰好一格控件高（34px）：字段区最后一行就是 34px 的控件，配合外层的
   * align-items: flex-end，右侧按钮与输入框底边严格齐平，计数文字也落在同一中线上。
   * 原先用 padding-bottom: 1px 去凑，反而让按钮比输入框高 1px。
   */
  min-height: var(--ctl-h);
}
.fbar__count {
  font-size: 13px;
  color: var(--t3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.fbar__count b {
  color: var(--t1);
  font-weight: 600;
}

/* 窄屏：字段铺满，动作换行后靠左，避免挤成两行错位 */
@media (max-width: 900px) {
  .fbar__fields > :deep(*) {
    flex: 1 1 160px;
  }
  .fbar__side {
    width: 100%;
    margin-left: 0;
    justify-content: space-between;
  }
}
</style>
