<script setup lang="ts">
/*
 * 版本历史：快照列表 + 回滚入口。
 *
 * 三条口径写在这里，否则很容易被当成「功能没做全」：
 *
 * 1. 快照只增不减。每次发布写一版，没有清理策略（设计文档 §10.2）。
 *    所以这个列表会一直变长，页面不做分页也不做折叠 —— 它是审计轨迹，不是工作列表。
 *
 * 2. 回滚只写库、不热装配。回滚后的内容要等下一次发布才生效。这不是漏实现，
 *    而是刻意的：回滚是一句「我把内容退回去了」的声明，是否立即影响线上实例
 *    应该由人再确认一次。所以回滚成功后页面要提示「还需发布」。
 *
 * 3. 列表不返回 snapshot_json。agent 的快照是 6 张表的整行 JSON，几十 KB；
 *    一屏只显示版本号 / 时间 / 操作人 / 变更说明，正文由后端按版本号再取一次。
 */
import { formatDateTime } from '@/lib/format';
import EmptyState from '@/components/ui/EmptyState.vue';
import type { ResourceVersionInfo } from '@/api/controlplane/types';

withDefaults(
  defineProps<{
    versions: ResourceVersionInfo[];
    loading?: boolean;
    /** 当前生效的已发布版本号，用于标出「线上是这一版」。 */
    publishedVersion?: number | null;
  }>(),
  { loading: false, publishedVersion: null },
);

defineEmits<{ rollback: [version: number] }>();
</script>

<template>
  <div v-if="loading" class="loading">加载中…</div>
  <EmptyState
    v-else-if="versions.length === 0"
    title="还没有版本快照"
  />
  <ol v-else class="vs">
    <li v-for="item in versions" :key="item.version" class="vr">
      <div class="vr__hd">
        <span class="vr__v mono">v{{ item.version }}</span>
        <span v-if="item.version === publishedVersion" class="vr__cur">线上</span>
        <span class="spacer" />
        <span class="vr__t">{{ formatDateTime(item.createdAtMs) }}</span>
      </div>
      <div class="vr__note">{{ item.changeNote || '（未填写变更说明）' }}</div>
      <div class="vr__ft">
        <span class="hint">{{ item.createdBy || 'console' }}</span>
        <span class="spacer" />
        <el-button size="small" @click="$emit('rollback', item.version)">回滚到此版</el-button>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.vs {
  margin: 0;
  padding: 0;
  list-style: none;
}
.vr {
  padding: 12px 0;
  border-bottom: 1px solid var(--bd-soft);
}
.vr:last-child {
  border-bottom: none;
}
.vr__hd {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.vr__v {
  color: var(--t1);
  font-weight: 600;
}
.vr__cur {
  padding: 0 6px;
  border: 1px solid var(--grn-line);
  border-radius: var(--r-sm);
  background: var(--grn-bg);
  color: var(--grn);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}
.vr__t {
  color: var(--t3);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.vr__note {
  margin-top: 4px;
  color: var(--t2);
  font-size: 13px;
  line-height: 1.6;
}
.vr__ft {
  display: flex;
  align-items: center;
  margin-top: 8px;
}
</style>
