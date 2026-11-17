<script setup lang="ts">
import type { DotTone } from './types';

defineProps<{ tone: DotTone }>();
</script>

<template>
  <span class="dot" :class="tone" aria-hidden="true" />
</template>

<style scoped>
.dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ok {
  background: var(--dot-ok);
}
/* 运行中：外圈光晕表示「正在进行」，静止态不会有这层 */
.run {
  background: var(--dot-run);
  box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.18);
}
.err {
  background: var(--dot-err);
}
.wait {
  background: var(--dot-wait);
}
</style>
