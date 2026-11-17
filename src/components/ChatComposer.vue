<script setup lang="ts">
/*
 * 对话输入框 —— 首屏（居中、放大）与对话中（贴底、单行起）两个位置共用同一份。
 *
 * 为什么抽成组件而不是在页面上写两遍：光标行为、IME 组词判断、
 * Enter / Shift+Enter 的分支必须完全一致。写两遍迟早有一边漏改，
 * 而最容易漏的正是 isComposing 那一条（不判它，中文输入法打拼音时按回车会把半截词发出去）。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** 正在等回答：输入框与按钮一起锁住。 */
    sending: boolean;
    /** 现在能不能发（有内容 + 选了 agent + 没在等）。 */
    sendable: boolean;
    /** lg = 首屏那个大的；sm = 对话中贴底那个。 */
    size?: 'lg' | 'sm';
  }>(),
  { size: 'sm' },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  stop: [];
}>();

// 首屏多给两行：空页面上一个只有一行的输入框会显得整个页面没准备好
const minRows = computed(() => (props.size === 'lg' ? 3 : 1));

function onKeydown(event: KeyboardEvent): void {
  // 组词中的回车是"确认候选词"，不是发送
  if (event.isComposing) return;
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  emit('submit');
}
</script>

<template>
  <div class="cp" :class="`cp--${size}`">
    <el-input
      :model-value="modelValue"
      type="textarea"
      resize="none"
      :autosize="{ minRows, maxRows: 8 }"
      placeholder="输入问题"
      :disabled="sending"
      @update:model-value="emit('update:modelValue', $event)"
      @keydown="onKeydown"
    />
    <div class="cp__row">
      <div class="cp__btns">
        <el-button v-if="sending" @click="emit('stop')">停止</el-button>
        <el-button type="primary" :disabled="!sendable" @click="emit('submit')">发送</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 描边与圆角由 element.css 统一给（1px 内阴影），这里只调内边距 */
.cp :deep(.el-textarea__inner) {
  padding: 10px 12px;
  border-radius: var(--r-lg);
  line-height: 1.7;
}
/* 首屏那个大一号：字号与内边距一起抬，只抬一边会显得字浮在框里 */
.cp--lg :deep(.el-textarea__inner) {
  padding: 14px 16px;
  font-size: 15px;
  line-height: 1.75;
}
.cp__row {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-top: var(--s2);
}
.cp__btns {
  display: flex;
  gap: var(--s2);
  margin-left: auto;
}
</style>
