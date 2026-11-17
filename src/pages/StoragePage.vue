<script setup lang="ts">
/*
 * 状态存储 · 列表页（/storage）。
 *
 * 这一页只回答一个问题：现在有哪些状态表（= 哪些 agent 的状态落进了库），
 * 各自占多少、最后一次写入是什么时候。表里有哪些会话、某个会话的上下文里
 * 到底有什么，是下两级页面的事 —— 一页回答一个问题，读者才不用在
 * 「有哪些表」与「某个会话里有什么」之间来回切换注意力。
 *
 * ===========================================================================
 * 一、为什么列表的单位是「状态表」而不是「全部会话」
 *
 * 一张状态表 = 一个 agent 的状态落点（md_agent_state 里的一张物理表）。
 * 把全平台的会话混在一张表里列，既给不出「这张表占了多少」这个运维上最常问的问题，
 * 也回答不了「这个 agent 的记忆去哪了」—— 而后者正是这一块存在的理由。
 *
 * ===========================================================================
 * 二、指标卡为什么留在列表页
 *
 * 「状态库是谁、一共几张表、多少会话、占多少」是**跨表**的汇总，详情页只有一张表，
 * 算不出这几项。放在列表页顶端，它同时也解释了这一页的数据口径
 * （MySQL 同实例、按 session_id 去重、SUM(LENGTH(state_data)) 而不是估算值）。
 *
 * ===========================================================================
 * 三、为什么还认 ?table=X 这种老链接
 *
 * 上一版把「表」放在查询串上（/storage?table=X&keyword=Y），会话记录页的「查看记忆」
 * 就是这么跳过来的。这一版把它升成路径（/storage/X）—— 表是**主体**，不是筛选条件。
 * 但书签与别处贴过的老地址不会自己跟着变，不处理的话它们会静默落在列表页上，
 * 用户只会得出「跳转坏了」。所以这里读到 table 就 replace 过去（关键字一并带上）。
 */
import { computed, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { queryKeys } from '@/lib/queryKeys';
import { formatBytes, formatCount, formatDateTime, formatRelative } from '@/lib/format';
import { fetchStateTables, type StateTableRow } from '@/api/state';
import type { BadgeVariant } from '@/components/ui/types';
import PageHeader from '@/components/ui/PageHeader.vue';
import TableCard from '@/components/ui/TableCard.vue';
import MetricCard from '@/components/ui/MetricCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';

const router = useRouter();
const route = useRoute();
const queryClient = useQueryClient();

const {
  data: tables,
  isLoading: tablesLoading,
  error: tablesError,
} = useQuery({ queryKey: queryKeys.stateTables, queryFn: fetchStateTables });

const tableList = computed<StateTableRow[]>(() => tables.value ?? []);

const totals = computed(() => ({
  tables: tableList.value.filter((item) => item.exists).length,
  declared: tableList.value.length,
  sessions: tableList.value.reduce((sum, item) => sum + item.sessions, 0),
  rows: tableList.value.reduce((sum, item) => sum + (item.exists ? item.rows : 0), 0),
  bytes: tableList.value.reduce((sum, item) => sum + (item.exists ? item.bytes : 0), 0),
}));

/** 首次取数期间指标卡显示「—」：先闪一遍 0 再跳到真实值，比慢一点显示更难读。 */
function metricValue(text: string): string {
  return tablesLoading.value ? '—' : text;
}

/*
 * 老链接（/storage?table=X&keyword=Y）→ 新路径（/storage/X?keyword=Y）。
 *
 * 只在「清单里确实有这张表」时跳：表名打错或表已不存在时跳过去只会得到 404，
 * 留在列表页至少能让人看见现在到底有哪些表。
 * replace 而不是 push —— 老地址不该在历史里留一格，否则用户点返回会回到它、
 * 又被弹回详情页，形成一步「退不出去」的循环。
 */
watch(tableList, (list) => {
  const legacy = typeof route.query.table === 'string' ? route.query.table : '';
  if (!legacy || list.length === 0) return;
  if (!list.some((item) => item.tableName === legacy)) return;
  const keyword = typeof route.query.keyword === 'string' ? route.query.keyword : '';
  void router.replace({
    path: `/storage/${encodeURIComponent(legacy)}`,
    query: keyword ? { keyword } : {},
  });
});

/** 表级状态：还没被框架建出来 / 是改名或删 agent 留下的残留 / 正常。 */
function tableState(row: StateTableRow): { text: string; variant: BadgeVariant } {
  if (!row.exists) return { text: '尚未创建', variant: 'wait' };
  if (!row.agentName) return { text: '孤儿表', variant: 'hosted' };
  return { text: '在库', variant: 'ok' };
}

/**
 * 进表详情。
 *
 * tableName 一定要编码：表名由 agent 名派生，虽然当前约定是 [a-z0-9_]，但这里
 * 不做任何假设 —— 一旦哪天出现带特殊字符的表名，未编码的路径会把整条路由切错。
 */
function openTable(row: StateTableRow): void {
  void router.push(`/storage/${encodeURIComponent(row.tableName)}`);
}

/* 整棵 state 缓存一起失效：指标卡与表清单来自两个接口，漏掉谁都会显示上一批数字。 */
function refresh(): void {
  void queryClient.invalidateQueries({ queryKey: ['state'] });
}
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button @click="refresh">刷新</el-button>
    </template>
  </PageHeader>

  <div class="grid-metrics mb">
    <MetricCard
      label="状态表"
      :value="metricValue(String(totals.tables))"
      unit=" 张"
      :footer="`${totals.declared} 个 Agent 已声明`"
    />
    <MetricCard
      label="会话"
      :value="metricValue(String(totals.sessions))"
      unit=" 个"
    />
    <MetricCard
      label="状态行"
      :value="metricValue(formatCount(totals.rows))"
      unit=" 行"
    />
    <MetricCard
      label="占用"
      :value="metricValue(formatBytes(totals.bytes))"
    />
  </div>

  <TableCard :loading="tablesLoading">
    <EmptyState
      v-if="tablesError"
      title="读不到状态表"
      :hint="(tablesError as Error).message"
    />
    <EmptyState
      v-else-if="tableList.length === 0"
      title="还没有 agent 声明状态存储"
    />
    <el-table v-else :data="tableList">
      <el-table-column label="状态表" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="mono strong">{{ row.tableName }}</span>
        </template>
      </el-table-column>
      <el-table-column label="归属 Agent" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.agentName" class="mono">{{ row.agentName }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" min-width="110">
        <template #default="{ row }">
          <AppBadge :variant="tableState(row).variant">{{ tableState(row).text }}</AppBadge>
        </template>
      </el-table-column>
      <el-table-column label="会话" min-width="90" align="right">
        <template #default="{ row }"><span class="mono">{{ row.exists ? row.sessions : '—' }}</span></template>
      </el-table-column>
      <el-table-column label="状态行" min-width="100" align="right">
        <template #default="{ row }"><span class="mono">{{ row.exists ? row.rows : '—' }}</span></template>
      </el-table-column>
      <el-table-column label="体积" min-width="110" align="right">
        <template #default="{ row }"><span class="mono">{{ row.exists ? formatBytes(row.bytes) : '—' }}</span></template>
      </el-table-column>
      <el-table-column label="最近写入" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.lastWriteAt" class="mono" :title="formatDateTime(row.lastWriteAt)">
            {{ formatRelative(row.lastWriteAt) }}
          </span>
          <span v-else class="muted">从未写入</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openTable(row)">查看</el-button>
        </template>
      </el-table-column>
    </el-table>

  </TableCard>
</template>

