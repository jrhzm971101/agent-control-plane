<script setup lang="ts">
/*
 * 表格卡：标题条 + 表格体 + 统计页脚。
 *
 * 为什么表格要套一层卡，而不是裸放 <el-table>：
 * 裸表格的边界由边框和页面底色决定，一张表就能撑满整屏却没有「这是几笔数据」的交代。
 * 套卡之后标题、条数、动作、页脚统计各有位置，多张表摞起来也是一致的块级节奏。
 *
 * 表格本身不加圆角 —— 圆角由卡片裁，表格四角保持直角才不会在底部漏出白边。
 */
withDefaults(
  defineProps<{
    title?: string;
    /** 标题右侧的条数徽标 */
    count?: number | string;
    loading?: boolean;
    /** 无数据时交给页脚/空状态的说明 */
    emptyTitle?: string;
    emptyHint?: string;
    /** 页脚左侧文字，例如「仅展示调用量最高的 40 条」 */
    footerNote?: string;
  }>(),
  { emptyTitle: '没有匹配的记录' },
);
</script>

<template>
  <section class="tc">
    <header v-if="title || $slots.actions" class="tc__hd">
      <h2 class="tc__ttl">
        {{ title }}
        <span v-if="count !== undefined" class="tc__cnt">{{ count }}</span>
      </h2>
      <div v-if="$slots.actions" class="tc__act"><slot name="actions" /></div>
    </header>

    <div class="tc__bd">
      <div v-if="loading" class="loading">加载中…</div>
      <slot v-else />
    </div>

    <footer v-if="$slots.footer || footerNote" class="tc__ft">
      <span class="tc__note"><slot name="footer">{{ footerNote }}</slot></span>
    </footer>
  </section>
</template>

<style scoped>
.tc {
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  box-shadow: var(--sh-card);
}
.tc__hd {
  display: flex;
  align-items: center;
  gap: var(--s3);
  position: relative;
  min-height: 56px;
  padding: 0 var(--s5);
  background: var(--panel);
}
.tc__hd::after {
  content: '';
  position: absolute;
  right: var(--s5);
  bottom: 0;
  left: var(--s5);
  height: 1px;
  border-radius: 999px;
  background: linear-gradient(90deg, transparent, var(--bd) 10%, var(--bd) 90%, transparent);
}
.tc__ttl {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--t1);
}
.tc__cnt {
  padding: 0 8px;
  border-radius: var(--r-sm);
  background: var(--pri-soft);
  color: var(--pri-ink);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 21px;
  font-variant-numeric: tabular-nums;
}
.tc__act {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-left: auto;
}
.tc__bd {
  background: var(--panel);
}
.tc__ft {
  padding: 12px var(--s5);
  border-top: 1px solid var(--bd-soft);
  background: var(--panel-soft);
  /* 页脚是辅助文本：字号比正文小一档，再压一层透明度，读表时不会抢视线 */
  font-size: 12px;
  color: var(--t3);
}
.tc__note {
  display: block;
  line-height: 1.6;
  opacity: 0.7;
}
</style>
