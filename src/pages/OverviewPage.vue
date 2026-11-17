<script setup lang="ts">
/*
 * 概览页 —— 一屏看清"平台现在怎么样"。
 *
 * 三条贯穿全页的口径，写在这里免得每次改动都重新推一遍：
 *
 * 1. <b>只读</b>。这一页没有任何写操作：需要动手的事都去对应的资源页做。
 *    也正因为如此，「需要关注」里每一条都写明去处（去链路页 / 去渠道页 / 发布一次）。
 *
 * 2. <b>数字不在这里算</b>。除了一处例外（今日 vs 昨日的增量），所有数字都由
 *    GET /api/overview 一次给全 —— 拆成多个请求就做不到"这一屏是同一时刻的平台"，
 *    会出现「Agent 14 个、已发布 15 个」这种自相矛盾。
 *    唯一的例外是增量：后端给的是 today.total 与 yesterdayTotal 两个原始数字，
 *    页面自己算涨跌，这样"涨了多少"的分子分母都摆在明面上（见 deltaBadge）。
 *
 * 3. <b>没有数据时的显示要像"没有数据"，不能像 0</b>。窗口内一次执行都没有时，
 *    平均耗时显示「—」而不是「0s」—— 后者会被读成"每次都秒回"。
 *
 * 「最近执行」这一块与指标卡的口径不同，是有意的：指标卡打在 run 表上（要统计口径），
 * 而最近执行取内存注册表（要能点进去看链路）。用表里的历史行也能拼出同样形状，
 * 但那些 run 的事件可能已被保留期清掉，点进去会是一个空壳 —— 那比少显示几条更糟。
 */
import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { fetchOverview, type ChangeItem } from '@/api/overview';
import { queryKeys } from '@/lib/queryKeys';
import { formatDateTime, formatDuration, formatRelative, formatTokens } from '@/lib/format';
import PageHeader from '@/components/ui/PageHeader.vue';
import MetricCard from '@/components/ui/MetricCard.vue';
import PaneCard from '@/components/ui/PaneCard.vue';
import TableCard from '@/components/ui/TableCard.vue';
import RunItemList from '@/components/ui/RunItemList.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import AppCard from '@/components/ui/AppCard.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import type { BadgeVariant, RunItem } from '@/components/ui/types';

const router = useRouter();
const queryClient = useQueryClient();

const { data, isLoading, error } = useQuery({
  queryKey: queryKeys.overview,
  queryFn: fetchOverview,
});

/** 后端的状态词表 → 中文。翻译只在这一处发生，页面别处不再写 if/else。 */
const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  pending: '等待',
};

/** 资源类型 → 中文名；用于「最近变更」里说明改的是哪一类资源。 */
const TYPE_TEXT: Record<string, string> = {
  AGENT: 'Agent',
  PROMPT: 'Prompt',
  SKILL: 'Skill',
  MCP: 'MCP',
  CHANNEL: '渠道',
  MODEL: '模型',
};

/**
 * 今日 vs 昨日的增量徽标。
 *
 * 为什么不显示 "+12%" 就完事：昨日为 0 时百分比没有定义（要么是"昨日起步"、
 * 要么是"昨天彻底没跑"），硬算会得到一个 ±∞ 或 0% 的假象。所以这两种情况
 * 单独给文字，不编数字。
 */
const deltaBadge = computed<{ text: string; variant: BadgeVariant } | undefined>(() => {
  const stats = data.value?.metrics.executionsToday;
  if (!stats) return undefined;
  if (stats.yesterdayTotal === 0) {
    return stats.total === 0
      ? { text: '与昨日持平', variant: 'off' }
      : { text: '昨日无执行', variant: 'wait' };
  }
  const diff = stats.total - stats.yesterdayTotal;
  if (diff === 0) return { text: '与昨日持平', variant: 'off' };
  const percent = Math.round((diff / stats.yesterdayTotal) * 100);
  return diff > 0
    ? { text: `较昨日 +${percent}%`, variant: 'ok' }
    : { text: `较昨日 ${percent}%`, variant: 'wait' };
});

/** 今日一次执行都没有时，耗时与最慢 agent 都没有意义，显示「—」。 */
const averageText = computed(() => {
  const metrics = data.value?.metrics;
  if (!metrics || metrics.executionsToday.total === 0) return '—';
  return formatDuration(metrics.latency.averageMs);
});

/** 「需要关注」直接喂给 RunItemList（tone 已经是组件认识的那两个值，不做二次映射）。 */
const attention = computed<RunItem[]>(() =>
  (data.value?.attention ?? []).map((item, index) => ({
    id: `attention-${index}`,
    title: item.title,
    meta: item.meta,
    note: item.detail,
    tone: item.tone,
  })),
);

/** 「最近变更」的时间是相对时间：审计流水里"多久以前"比绝对时刻更有信息量。 */
function changeLine(change: ChangeItem): string {
  const type = TYPE_TEXT[change.resourceType] ?? change.resourceType;
  return `${type} ${change.action}`;
}

function openRun(runId: string): void {
  void router.push(`/traces/${runId}`);
}
</script>

<template>
  <div v-if="isLoading" class="loading">加载中…</div>

  <AppCard v-else-if="error">
    <EmptyState title="读不到概览" :hint="(error as Error).message" />
  </AppCard>

  <template v-else-if="data">
    <PageHeader>
      <template #actions>
        <el-button @click="queryClient.invalidateQueries({ queryKey: queryKeys.overview })">
          刷新
        </el-button>
        <el-button @click="router.push('/traces')">查看执行链路</el-button>
        <el-button type="primary" @click="router.push('/agents')">+ 新建 Agent</el-button>
      </template>
    </PageHeader>

    <div class="grid-metrics mb">
      <MetricCard
        label="Agents"
        :value="String(data.metrics.agents.total)"
        :badge="{ text: `${data.metrics.agents.harness} Harness`, variant: 'harness' }"
      />
      <MetricCard
        label="本地工具"
        :value="String(data.metrics.tools.local)"
      />
      <MetricCard
        label="MCP 服务"
        :value="String(data.metrics.tools.mcpServers)"
        :badge="{ text: `启用 ${data.metrics.tools.mcpEnabled}`, variant: 'external' }"
      />
      <MetricCard
        label="模型"
        :value="String(data.metrics.models.total)"
        :badge="{ text: data.metrics.models.defaultKey ?? 'yml 兜底', variant: 'managed' }"
      />
      <MetricCard
        label="今日执行"
        :value="String(data.metrics.executionsToday.total)"
        :badge="deltaBadge"
      />
      <MetricCard
        label="今日平均耗时"
        :value="averageText"
      />
      <MetricCard
        label="今日 Token"
        :value="formatTokens(data.metrics.tokens.today)"
      />
      <MetricCard
        label="缓存命中率"
        :value="data.metrics.tokens.cacheHitRate"
      />
    </div>

    <div class="split">
      <div class="stack">
        <TableCard>
          <EmptyState
            v-if="data.runs.length === 0"
            title="运行时注册表里还没有执行记录"
          />
          <el-table v-else :data="data.runs" @row-click="(row: Record<string, any>) => openRun(row.runId)">
            <el-table-column label="Agent" min-width="160">
              <template #default="{ row }"><span class="strong">{{ row.agentId }}</span></template>
            </el-table-column>
            <el-table-column label="状态" min-width="100">
              <template #default="{ row }">
                <span class="row inline">
                  <StatusDot :tone="row.tone" />{{ STATUS_TEXT[row.status] ?? row.status }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="会话" min-width="160" show-overflow-tooltip>
              <template #default="{ row }"><span class="mono">{{ row.sessionId }}</span></template>
            </el-table-column>
            <el-table-column label="开始时间" min-width="130">
              <template #default="{ row }"><span class="mono">{{ formatDateTime(row.startedAt) }}</span></template>
            </el-table-column>
            <el-table-column label="耗时" min-width="80" align="right">
              <template #default="{ row }"><span class="mono">{{ formatDuration(row.durationMs) }}</span></template>
            </el-table-column>
          </el-table>
        </TableCard>

        <PaneCard title="能力资源健康度">
          <div v-for="bar in data.health" :key="bar.label" class="hbar">
            <div class="hlbl">{{ bar.label }}</div>
            <div class="hbar-track"><i :style="{ width: `${Math.round(bar.ratio * 100)}%` }" /></div>
            <div class="hval">{{ bar.value }}</div>
          </div>
        </PaneCard>

      </div>

      <div class="stack">
        <PaneCard title="需要关注" :right="String(attention.length)">
          <RunItemList v-if="attention.length > 0" :items="attention" />
          <EmptyState
            v-else
            title="没有需要关注的事"
          />
        </PaneCard>
        <PaneCard title="最近变更">
          <div v-if="data.changes.length === 0" class="hint">还没有发布或回滚记录。</div>
          <div v-for="change in data.changes" :key="`${change.resourceType}-${change.subject}-${change.atMs}`" class="change">
            <div class="change__r1">
              <b>{{ change.subject }}</b>
              <span class="spacer" />
              <span class="change__t">{{ formatRelative(change.atMs) }}</span>
            </div>
            <div class="change__r2">
              {{ changeLine(change) }}
              <AppBadge variant="managed">{{ change.actor || 'console' }}</AppBadge>
            </div>
            <div v-if="change.note" class="change__note" :title="change.note">{{ change.note }}</div>
          </div>
        </PaneCard>
      </div>
    </div>
  </template>
</template>

<style scoped>
.hbar {
  display: flex;
  align-items: center;
  gap: var(--s3);
  margin-bottom: 11px;
}
.hbar:last-of-type {
  margin-bottom: 0;
}
.hlbl {
  width: 116px;
  font-size: 13.5px;
  color: var(--t2);
}
.hbar-track {
  flex: 1;
  height: 6px;
  background: var(--panel-sunken);
  border-radius: var(--r-xs);
  position: relative;
  overflow: hidden;
}
.hbar-track i {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--pri);
  border-radius: var(--r-xs);
}
.hval {
  width: 56px;
  text-align: right;
  color: var(--t3);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.facts {
  margin: 0;
  padding-left: 18px;
  color: var(--t2);
  font-size: 13px;
  line-height: 1.8;
}
.facts b {
  color: var(--t1);
}
.facts i {
  font-style: normal;
  font-weight: 600;
}
.change {
  padding: 9px 0;
  border-bottom: 1px solid var(--bd-soft);
}
.change:last-child {
  border-bottom: none;
}
.change__r1 {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.change__r1 b {
  color: var(--t1);
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.change__t {
  color: var(--t3);
  font-size: 12.5px;
  white-space: nowrap;
}
.change__r2 {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-top: 3px;
  color: var(--t3);
  font-size: 12.5px;
}
.change__note {
  margin-top: 3px;
  color: var(--t3);
  font-size: 12.5px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
