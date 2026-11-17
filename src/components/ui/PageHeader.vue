<script setup lang="ts">
/*
 * 页面标题区：大标题 + 一句口径说明 + 右侧动作。
 *
 * 标题与说明都可省略：菜单页的页面名已经由侧栏与页签重复表达，
 * 内容区只保留操作按钮即可；详情页仍可传 title 保留上下文。
 */
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <header
    v-if="title || subtitle || $slots.meta || $slots.actions"
    class="hd"
    :class="{ 'hd--actions-only': !title && !subtitle && !$slots.meta }"
  >
    <div v-if="title || subtitle || $slots.meta" class="hd__main">
      <h1 v-if="title">{{ title }}</h1>
      <p v-if="subtitle" class="hd__sub">{{ subtitle }}</p>
      <slot name="meta" />
    </div>
    <div v-if="$slots.actions" class="hd__act"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s6);
  /* 与下方第一个内容块保持 16px：标题块本身不再叠加 h1 的默认下边距。 */
  margin-bottom: var(--s4);
}
.hd__main {
  min-width: 0;
}
.hd h1 {
  margin-bottom: 0;
}
.hd__sub {
  max-width: 76ch;
  margin: 6px 0 0;
  color: var(--t2);
  font-size: 14px;
  line-height: 1.65;
  /* 标题下方的模块说明：压一层透明度与标题拉开层级（字号保持原样） */
  opacity: 0.8;
}
.hd__act {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--s2);
  flex: 0 0 auto;
  margin-left: auto;
  padding-top: 3px;
}

/* 只剩操作按钮时，把整行压到右侧，不留下标题区的空位。 */
.hd--actions-only {
  justify-content: flex-end;
}

/* 窄屏时动作区移到标题下方：否则按钮会把标题挤成一条窄缝，中文逐字换行。 */
@media (max-width: 900px) {
  .hd {
    flex-direction: column;
    align-items: stretch;
    gap: var(--s3);
  }
  .hd__act {
    justify-content: flex-start;
    margin-left: 0;
    padding-top: 0;
  }
}
</style>
