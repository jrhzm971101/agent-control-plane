<script setup lang="ts">
/*
 * 通用卡片：标题行右侧放徽标，底部一行说明。
 * 可点击时才给 hover 反馈 —— 不可点的卡片跟着抬手是骗人的。
 */
defineProps<{ title?: string; description?: string; clickable?: boolean }>();
</script>

<template>
  <article class="card" :class="{ clickable }" :tabindex="clickable ? 0 : undefined">
    <div v-if="title" class="r1">
      <div class="nm">{{ title }}</div>
      <slot name="badge" />
    </div>
    <div v-if="description" class="ds">{{ description }}</div>
    <slot />
    <div v-if="$slots.tags" class="tags"><slot name="tags" /></div>
    <div v-if="$slots.footer" class="ft"><slot name="footer" /></div>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  padding: var(--s5);
  background: var(--panel);
  border: 1px solid var(--bd);
  /* 卡片统一 8px；阴影极轻，分层仍以描边为主 */
  border-radius: var(--r-md);
  box-shadow: var(--sh-card);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.card.clickable {
  cursor: pointer;
}
.card.clickable:hover {
  border-color: var(--pri-line);
  box-shadow: var(--sh-card-hover);
}
.r1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s2);
  margin-bottom: 6px;
}
.nm {
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds {
  flex: 1;
  min-height: 40px;
  color: var(--t2);
  font-size: 13.5px;
  line-height: 1.6;
  /* 列表卡片只交代一句是什么：长描述截到两行，完整内容进详情。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--s3);
}
.ft {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--s3);
  padding-top: 12px;
  border-top: 1px solid var(--bd-soft);
  color: var(--t3);
  font-size: 12.5px;
}
</style>
