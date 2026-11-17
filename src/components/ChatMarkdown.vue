<script setup lang="ts">
/*
 * 一条 assistant 回答的 Markdown 正文。
 *
 * 为什么单独做成组件：renderMarkdown 是对话页最重的一次计算（markdown-it 解析 +
 * highlight.js 切词）。它原先直接写在 ChatPage 的 v-html 里，而父组件在流式期间
 * 每收到一个 delta 都会重渲染 —— 于是**整段历史**的 Markdown 会被反复重新解析，
 * 历史越长越卡。
 *
 * 拆出来之后，text 没变的那些消息在父组件重渲染时会被 Vue 直接跳过；即使某次
 * 仍被求值，computed 也会按当前的 text 命中缓存，不会重复解析。
 */
import { computed } from 'vue';
import { renderMarkdown } from '@/features/chat/markdown';

const props = defineProps<{
  text: string;
  /** 生成中的那条挂光标（样式在 ChatPage 的 .bub__md--streaming）。 */
  streaming?: boolean;
}>();

const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <div class="bub__md" :class="{ 'bub__md--streaming': streaming }" v-html="html" />
</template>
