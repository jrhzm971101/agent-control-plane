<script setup lang="ts">
/*
 * 分类 chips：互斥单选，带条数。
 *
 * 高度严格取 --ctl-h（34px），与输入框 / 下拉 / 按钮同高 —— chips 与筛选字段
 * 常在同一个筛选条里上下相邻，差 1px 就能看出歪。条数用等宽数字，
 * 切换时不会因为位数变化而抖动。
 */
defineProps<{
  items: Array<{
    key: string;
    label: string;
    count?: number | string;
    tone?: 'ok' | 'run' | 'err' | 'wait';
  }>;
  modelValue: string;
}>();

defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="chips" role="group">
    <button
      v-for="item in items"
      :key="item.key"
      class="chip"
      :class="{ on: item.key === modelValue }"
      type="button"
      :aria-pressed="item.key === modelValue"
      @click="$emit('update:modelValue', item.key)"
    >
      <span v-if="item.tone" class="cdot" :class="item.tone" aria-hidden="true" />
      <span>{{ item.label }}</span>
      <i v-if="item.count !== undefined">{{ item.count }}</i>
    </button>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  align-items: center;
  /* 12px：筛选行内所有组件的间距统一到这一档 */
  gap: var(--s3);
  flex-wrap: wrap;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: var(--ctl-h);
  padding: 0 11px;
  border: 1px solid var(--bd);
  /* 标签统一 6px 圆角，与按钮 / 输入框同一档 */
  border-radius: var(--r-sm);
  background: var(--panel);
  color: var(--t2);
  font-family: inherit;
  font-size: 13.5px;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.chip:hover {
  border-color: var(--bd-strong);
  color: var(--t1);
  background: var(--panel-soft);
}
.chip.on {
  border-color: var(--pri-line);
  background: var(--pri-soft);
  color: var(--pri-ink);
  font-weight: 600;
}
.chip i {
  padding: 0 5px;
  border-radius: var(--r-sm);
  background: var(--panel-sunken);
  color: var(--t2);
  font-style: normal;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.chip.on i {
  background: var(--panel);
  color: var(--pri-ink);
}
.cdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.cdot.ok {
  background: var(--dot-ok);
}
.cdot.run {
  background: var(--dot-run);
}
.cdot.err {
  background: var(--dot-err);
}
.cdot.wait {
  background: var(--dot-wait);
}
</style>
