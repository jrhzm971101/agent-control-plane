<script setup lang="ts">
/*
 * 执行链路 · 列表页。
 *
 * 这一层只回答「找到那一次执行」：上面筛选，下面平铺列表，点行进详情。
 * 调用树以前挤在同一个页面的中栏（右侧还要再塞一个 384px 的节点详情），
 * 三层信息叠在一屏里，谁都不够宽 —— 所以拆成两层：
 * 列表页负责定位，详情页 /traces/:runId 独占整屏画调用树。
 */
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { queryKeys } from '@/lib/queryKeys';
import { agentDetailLink, queryString, sessionsLink, traceLink } from '@/lib/links';
import { formatDateTime, formatDuration, formatTokens } from '@/lib/format';
import { agentDisplayName } from '@/lib/agentDisplay';
import { listAgents } from '@/api/controlplane';
import { fetchTraceRuns } from '@/features/traces/api';
import type { RunSummary } from '@/api/types';
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterChips from '@/components/ui/FilterChips.vue';
import FilterField from '@/components/ui/FilterField.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import StatusDot from '@/components/ui/StatusDot.vue';

const router = useRouter();
const live = ref(true);

const statusText: Record<string, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  pending: '等待',
};

/*
 * 列表用轮询而不是 SSE。
 *
 * SSE 推的是「某一个 run 的事件」，不是「有哪些 run」，所以列表只能轮询：
 * 列表回答「最近发生了什么」，事件流回答「这一条正在怎么跑」，两者职责不同。
 * 关掉实时刷新后连轮询一起停 —— 否则读数在眼前自己变，会以为是页面在抖。
 */
const { data: runs, isLoading, error: loadError } = useQuery({
  queryKey: queryKeys.traceRuns,
  queryFn: fetchTraceRuns,
  refetchInterval: () => (live.value ? 3_000 : false),
});

const list = computed(() => runs.value ?? []);

/**
 * agent 列表，只用来把 run 上的 agentId 翻成展示名。
 *
 * <p>为什么不改后端：run 表记的 agentId 是"这一条执行归属于谁"的业务事实，
 * 它就该是标识（对得上库里、日志里、配置里的东西）。要给人看的是同一个 agent 的
 * 展示名，那是控制面的事，用已经缓存的 agent 列表做一次本地 join 即可。
 */
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });
const displayNameOf = computed(() => agentDisplayName(agents.value));

/*
 * agent 名 → 类型，用来决定点名字落在能力域还是编排域（见 links.ts 的 agentDetailLink）。
 * 同 SessionsPage：数据来自已缓存的 agent 清单，查不到就回落 /agents。
 */
const agentTypeOf = computed(() => {
  const byName = new Map((agents.value ?? []).map((row) => [row.agentName, row.agentType]));
  return (name: string): string | null => byName.get(name) ?? null;
});

function agentLinkOf(name: string): string {
  return agentDetailLink(name, agentTypeOf.value(name));
}

/*
 * 初始筛选读一次地址（/traces?agent=X&keyword=Y&status=Z）。
 *
 * <p>为什么是只读、不回写：这一页的列表来自一次 limit=200 的拉取，筛选全在前端做，
 * 把筛选写回地址等于每次敲一个字母都改一次历史记录（还与"实时刷新"的轮询叠在一起）。
 * 只读一侧就够支撑互跳与返回：
 *   · 从 agent 详情 / 会话记录点「执行链路」过来，直接落在筛好的列表上；
 *   · 从链路详情按浏览器返回，地址上那三个参数还在，筛选自动还原。
 * 参数名与 links.ts 的 tracesLink 是同一份约定的两端，改要一起改。
 */
const route = useRoute();
const statusValue = ref(queryString(route.query, 'status') || 'all');
const agentId = ref(queryString(route.query, 'agent'));
const keyword = ref(queryString(route.query, 'keyword'));
const range = ref<[Date, Date] | null>(null);

/* 选日期时两端补成当天 00:00:00 / 23:59:59，否则「选今天」会漏掉 00:00 之后的所有执行。 */
const defaultTime: [Date, Date] = [new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59)];

const shortcuts = [
  { text: '近 1 小时', value: () => [new Date(Date.now() - 3_600_000), new Date()] },
  { text: '近 24 小时', value: () => [new Date(Date.now() - 24 * 3_600_000), new Date()] },
  { text: '近 7 天', value: () => [new Date(Date.now() - 7 * 24 * 3_600_000), new Date()] },
  { text: '近 30 天', value: () => [new Date(Date.now() - 30 * 24 * 3_600_000), new Date()] },
];

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  { key: 'running', label: '运行中', count: countBy('running'), tone: 'run' as const },
  { key: 'success', label: '成功', count: countBy('success'), tone: 'ok' as const },
  { key: 'failed', label: '失败', count: countBy('failed'), tone: 'err' as const },
]);

function countBy(status: string): number {
  return list.value.filter((run) => run.status === status).length;
}

/*
 * 筛选项只列「当前这批 run 里真的出现过的」agent —— 而不是全部 agent：
 * 选一个最近没跑过的 agent 只会得到空表。value 保持 agentId，筛选比的也是它。
 */
const agentOptions = computed(() => [...new Set(list.value.map((run) => run.agentId))].sort());

const visible = computed(() => {
  const key = keyword.value.trim().toLowerCase();
  const from = range.value?.[0]?.getTime() ?? null;
  const to = range.value?.[1]?.getTime() ?? null;

  return list.value.filter((run) => {
    if (statusValue.value !== 'all' && run.status !== statusValue.value) return false;
    if (agentId.value && run.agentId !== agentId.value) return false;
    if (from !== null || to !== null) {
      const started = Date.parse(run.startedAt);
      if (Number.isNaN(started)) return false;
      if (from !== null && started < from) return false;
      if (to !== null && started > to) return false;
    }
    if (!key) return true;
    return `${run.runId} ${run.agentId} ${run.sessionId}`.toLowerCase().includes(key);
  });
});

/* 契约只说「新的在前」，前端还是自己排一遍 —— 排序是这页的基本承诺，不该依赖上游。 */
const rows = computed(() =>
  [...visible.value].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
);

const isFiltered = computed(
  () => Boolean(keyword.value || agentId.value || range.value || statusValue.value !== 'all'),
);

function reset() {
  statusValue.value = 'all';
  agentId.value = '';
  keyword.value = '';
  range.value = null;
}

function openRun(run: RunSummary) {
  router.push(traceLink(run.runId));
}
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-switch v-model="live" active-text="实时刷新" />
    </template>
  </PageHeader>

  <FilterBar :result="{ count: rows.length, total: list.length, noun: '次执行' }">
    <template #chips>
      <FilterChips v-model="statusValue" :items="chips" />
    </template>
    <FilterField label="关键字" width="260px">
      <el-input v-model="keyword" placeholder="runId / Agent / 会话" clearable />
    </FilterField>
    <FilterField label="Agent" width="200px">
      <el-select v-model="agentId" placeholder="全部 Agent" clearable filterable>
        <el-option v-for="item in agentOptions" :key="item" :label="displayNameOf(item)" :value="item" />
      </el-select>
    </FilterField>
    <FilterField label="时间范围" width="360px">
      <el-date-picker
        v-model="range"
        type="datetimerange"
        start-placeholder="开始时间"
        end-placeholder="结束时间"
        :default-time="defaultTime"
        :shortcuts="shortcuts"
        unlink-panels
      />
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <TableCard :loading="isLoading">
    <!--
      取数失败和「筛没了」要分开说：后端没起来时列表是空的，
      但提示「清空筛选条件」会让人对着筛选条折腾半天，而问题根本不在筛选。
    -->
    <EmptyState
      v-if="loadError"
      title="读不到执行记录"
      :hint="(loadError as Error).message"
    />
    <EmptyState
      v-else-if="rows.length === 0"
      title="没有符合条件的执行记录"
    />
    <el-table v-else :data="rows" @row-click="openRun">
      <el-table-column label="状态" min-width="110">
        <template #default="{ row }">
          <span class="row inline">
            <StatusDot :tone="row.tone" />{{ statusText[row.status] ?? row.status }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="Agent" min-width="210" show-overflow-tooltip>
        <template #default="{ row }">
          <!-- agentId 是业务事实（这一条 run 归属于谁），但它是标识不是名字：
               首读信息给展示名，标识跟在后面保留对账能力（日志、库、别的 agent 的引用值）。
               两个都做成链接（同一目标），因为用户想点的可能就是看见的那一个 ——
               @click.stop 是必须的：整行点击会进链路详情，不拦下来会串成一个
               "点 agent 名却打开了 run" 的动作。 -->
          <router-link class="strong lk" :to="agentLinkOf(row.agentId)" @click.stop>
            {{ displayNameOf(row.agentId) }}
          </router-link>
        </template>
      </el-table-column>
      <!--
        真后端的会话 ID 是 51 字符的完整 ID（mock 里是 single-wo7U1…-2026-09-20 这种短式），
        不截断就会折成两行、把整张表的行高带歪。这里保持单行，全量值放到悬浮提示里。
      -->
      <!--
        会话做成链接：这条 run 属于哪一串对话、那个人总共问过几次，答案在会话记录页。
        带上 agent 一起筛 —— 同一条会话可能被多个 agent 服务过（见 api/sessions.ts 的口径），
        不筛的话落点是一大串别人的会话。
      -->
      <el-table-column label="会话" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <router-link
            class="mono lk"
            :to="sessionsLink({ agentId: row.agentId, sessionId: row.sessionId })"
            @click.stop
          >
            {{ row.sessionId }}
          </router-link>
        </template>
      </el-table-column>
      <el-table-column label="运行 ID" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="mono">{{ row.runId }}</span>
        </template>
      </el-table-column>
      <el-table-column label="开始时间" min-width="170">
        <template #default="{ row }">
          <span class="mono">{{ formatDateTime(row.startedAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="耗时" min-width="90" align="right">
        <template #default="{ row }">
          <span class="mono">{{ formatDuration(row.durationMs) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="Token" min-width="90" align="right">
        <template #default="{ row }">
          <span class="mono">{{ formatTokens(row.tokens) }}</span>
        </template>
      </el-table-column>
    </el-table>
  </TableCard>
</template>
