<script setup lang="ts">
/*
 * 三态开关。
 *
 * 为什么不用 el-switch / el-checkbox：它们只有两档，而「没设置」与「显式关闭」在装配期
 * 是两个完全不同的结果 —— 前者不下发 setter（框架把默认值改了，平台跟着变），
 * 后者显式覆盖成 false（把当前默认值钉死，且没有任何地方会提示这件事）。
 * 所以这里必须是三选的下拉，并且「未设置」要占一个明确的档位，而不是一个空占位符。
 *
 * 实现上的坑：el-option 的 value 不能直接给 null —— 组件内部把 null 当成「未选中」，
 * 选中态会失效。所以对外仍是 TriState，内部用字符串哨兵值过渡。
 */
import { computed } from 'vue';
import type { TriState } from '@/api/controlplane/types';

const props = withDefaults(defineProps<{ modelValue: TriState; disabled?: boolean }>(), {
  disabled: false,
});

const emit = defineEmits<{ 'update:modelValue': [value: TriState] }>();

const UNSET = '__unset__';

const current = computed(() => (props.modelValue === null ? UNSET : String(props.modelValue)));

function onChange(value: string) {
  emit('update:modelValue', value === UNSET ? null : value === 'true');
}
</script>

<template>
  <el-select :model-value="current" :disabled="disabled" @change="onChange">
    <el-option label="未设置" :value="UNSET" />
    <el-option label="开启" value="true" />
    <el-option label="关闭" value="false" />
  </el-select>
</template>
