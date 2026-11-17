<script setup lang="ts">
/** 深色代码块；内容已经是字符串，组件不做序列化。 */
defineProps<{ content: string }>();
</script>

<template>
  <pre class="j">{{ content }}</pre>
</template>