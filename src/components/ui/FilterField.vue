<script setup lang="ts">
/*
 * 筛选字段：标签在上、控件在下。
 *
 * 为什么标签放上面而不是用 placeholder 顶替：
 * 占位符一输入就消失，筛完回来根本看不出这格筛的是什么；标签常驻才能一眼读懂。
 * 所有字段用同一套「12.5px 标签 + 34px（--ctl-h）控件」的骨架，一排排下来才是齐的。
 */
withDefaults(defineProps<{ label: string; width?: string }>(), { width: '208px' });
</script>

<template>
  <label class="ff" :style="{ width }">
    <span class="ff__lb">{{ label }}</span>
    <span class="ff__ctl"><slot /></span>
  </label>
</template>

<style scoped>
.ff {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.ff__lb {
  font-size: 12.5px;
  font-weight: 550;
  line-height: 1.4;
  color: var(--t2);
  letter-spacing: 0.01em;
}
.ff__ctl {
  display: block;
  min-width: 0;
}
.ff__ctl :deep(.el-input),
.ff__ctl :deep(.el-select),
.ff__ctl :deep(.el-date-editor),
.ff__ctl :deep(.el-input-number) {
  width: 100%;
}
</style>
