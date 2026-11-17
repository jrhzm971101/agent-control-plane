<script setup lang="ts">
/*
 * 调用树。用 el-table 的树形数据能力承载（官方用自绘组件，
 * 这里换成 Element Plus 原生能力，交互与键盘可达性由组件库保证）。
 */
import { computed } from 'vue';
import StatusDot from './ui/StatusDot.vue';
import { formatDuration, formatTokens } from '@/lib/format';
import type { TraceNode } from '@/features/traces/model';

const props = defineProps<{
  nodes: TraceNode[];
  spanMs: number;
  selectedPath?: string;
}>();

const emit = defineEmits<{ select: [path: string] }>();

const rows = computed(() => props.nodes);

function barWidth(node: TraceNode): string {
  if (node.durationMs === null) return '0%';
  return `${Math.max(2, Math.round((node.durationMs / props.spanMs) * 100))}%`;
}

function rowClass({ row }: { row: TraceNode }): string {
  return row.path === props.selectedPath ? 'trace-row-sel' : '';
}
</script>

<template>
  <el-table
    class="trace-table"
    :data="rows"
    row-key="path"
    :tree-props="{ children: 'children' }"
    default-expand-all
    @row-click="(row: TraceNode) => emit('select', row.path)"
    :row-class-name="rowClass"
  >
    <el-table-column label="节点" min-width="330">
      <template #default="{ row }">
        <div class="node">
          <StatusDot :tone="row.status" />
          <span class="nm" :class="{ kind: row.kind !== 'agent' }">{{ row.label }}</span>
          <span v-if="row.source" class="src">{{ row.source }}</span>
        </div>
      </template>
    </el-table-column>
    <!-- 进度条是纯视觉列，判读靠「长短对比」而不是精确刻度，150px 足够；
        省下的 50px 让给「节点」列 —— 那一列才是真正要读的。 -->
    <el-table-column label="耗时占比" width="150">
      <template #default="{ row }">
        <div class="bar"><i :style="{ width: barWidth(row) }" /></div>
      </template>
    </el-table-column>
    <el-table-column label="耗时" width="80" align="right">
      <template #default="{ row }">
        <span class="mono">{{ formatDuration(row.durationMs) }}</span>
      </template>
    </el-table-column>
    <el-table-column label="Token" width="80" align="right">
      <template #default="{ row }">
        <span class="mono">{{ formatTokens(row.tokens) }}</span>
      </template>
    </el-table-column>
  </el-table>
</template>

<style scoped>
.node {
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex: 1 1 auto;
  min-width: 0;
}
.nm {
  font-weight: 550;
  color: var(--t1);
  white-space: nowrap;
  /* 节点名优先完整显示：宽度不够时先牺牲后面的来源徽标，而不是截断名字。 */
  flex: 0 0 auto;
}
.nm.kind {
  font-weight: 400;
  color: var(--t2);
  font-size: 13px;
}
.src {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--t3);
  background: var(--panel-sunken);
  border-radius: var(--r-sm);
  padding: 1px 6px;
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  height: 6px;
  border-radius: var(--r-xs);
  background: var(--panel-sunken);
  position: relative;
  overflow: hidden;
}
.bar i {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: var(--pri);
  border-radius: var(--r-xs);
}
</style>

<style>
/* 选中行需要覆盖 el-table 的 hover 背景，因此不放在 scoped 里。 */
.el-table .trace-row-sel td.el-table__cell {
  background: var(--pri-soft) !important;
}
/*
 * 树形行的「缩进占位 + 展开箭头 + 节点内容」必须排在同一行。
 * Node 那一格是块级元素，靠行内流排列时会被挤到第二行，
 * 于是箭头独占一行、节点标题掉到下一行，行高也跟着分裂成 40 / 42 / 43 三种。
 * 把这一格的 .cell 变成 flex 容器，三者才是真正的同一行。
 */
.el-table.trace-table td.el-table__cell:first-child .cell {
  display: flex;
  align-items: center;
}
/*
 * 调用树是层级时间线：节点多、靠缩进表达父子关系，一味用 48px 行高会让
 * 一屏看不下几层。这里单独收一档到 40px，其余记录表仍保持 48px。
 */
.el-table.trace-table th.el-table__cell,
.el-table.trace-table td.el-table__cell {
  height: var(--row-h-dense);
}
</style>
