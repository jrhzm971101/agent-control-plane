<script setup lang="ts">
/*
 * 键值对编辑器（MCP 的 headers / query-params 用）。
 *
 * 为什么不用「对象 + JSON 文本框」：请求头这种配置的日常操作是"加一条、改一条、删一条"，
 * 让人手写 JSON 意味着每次都要处理逗号与引号，而写错之后报错的是整个保存动作。
 *
 * 也不做拦住式的表单校验：这里没有"校验"可言（空的键就是"没填"），
 * 保存时直接丢弃空键行即可（见 lib/kvRows.ts 的 toRecord），少一层来回。
 *
 * 为什么编辑态是数组而不是对象：对象表达不了"正在输入的空键" —— 键一旦为空，
 * 那一行就从对象里消失了，输入框会被立刻清空。
 */
import type { KVRow } from '@/lib/kvRows';

const props = withDefaults(
  defineProps<{
    modelValue: KVRow[];
    keyPlaceholder?: string;
    valuePlaceholder?: string;
    addLabel?: string;
  }>(),
  {
    keyPlaceholder: '名称',
    valuePlaceholder: '值',
    addLabel: '+ 添加一项',
  },
);

const emit = defineEmits<{ 'update:modelValue': [value: KVRow[]] }>();

function add() {
  emit('update:modelValue', [...props.modelValue, { key: '', value: '' }]);
}

function remove(index: number) {
  const next = [...props.modelValue];
  next.splice(index, 1);
  emit('update:modelValue', next);
}

function setKey(index: number, key: string) {
  const next = [...props.modelValue];
  next[index] = { ...next[index], key };
  emit('update:modelValue', next);
}

function setValue(index: number, value: string) {
  const next = [...props.modelValue];
  next[index] = { ...next[index], value };
  emit('update:modelValue', next);
}
</script>

<template>
  <div class="kv">
    <p v-if="modelValue.length === 0" class="hint">还没有配置项。</p>
    <div v-for="(row, index) in modelValue" :key="index" class="kv__row">
      <el-input
        :model-value="row.key"
        :placeholder="keyPlaceholder"
        class="mono"
        @update:model-value="(value: string) => setKey(index, value)"
      />
      <el-input
        :model-value="row.value"
        :placeholder="valuePlaceholder"
        @update:model-value="(value: string) => setValue(index, value)"
      />
      <el-button text type="danger" @click="remove(index)">移除</el-button>
    </div>
    <el-button size="small" @click="add">{{ addLabel }}</el-button>
  </div>
</template>

<style scoped>
.kv__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
  gap: var(--s2);
  margin-bottom: 6px;
}
</style>