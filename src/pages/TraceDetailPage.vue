<script setup lang="ts">
/*
 * 执行链路 · 详情页（/traces/:runId）。
 *
 * 这个页面是整套「事件驱动」设计的样板页：
 *   历史 REST（游标分页） → mergeContiguousEvents 合并 → 投影成树
 *   SSE 增量（断线续传、乱序缓冲） → 同一套合并逻辑 → 重算投影
 * 页面只消费投影结果，不直接读原始事件，也不自己维护「树」这份状态。
 *
 * 节点明细从右栏挪进了弹窗：384px 的固定栏里，入参 JSON 只能露出三行，
 * 读一条长入参要横向拖到底。弹窗宽 1120px（窄屏按 94vw 收），
 * 正文限高内部滚动，页面本身不动。
 */
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { queryKeys } from '@/lib/queryKeys';
import { agentDetailLink, sessionsLink } from '@/lib/links';
import { formatDuration, formatTokens } from '@/lib/format';
import { useRunEvents } from '@/features/traces/useRunEvents';
import {
  describeTraceNode,
  findTraceNode,
  flattenTrace,
  projectRunMeta,
  projectTrace,
  traceSpanMs,
} from '@/features/traces/adapters';
import { fetchRunInfo } from '@/features/traces/api';
import PageHeader from '@/components/ui/PageHeader.vue';
import PaneCard from '@/components/ui/PaneCard.vue';
import KVList from '@/components/ui/KVList.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import TraceTree from '@/components/TraceTree.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import type { BadgeVariant, KVItem } from '@/components/ui/types';
import type { Tone } from '@/api/types';
import type { TraceNode } from '@/features/traces/model';

/** 事件层的 tone 语义 → 徽标样式；页面统一在这里收口，组件不感知业务语义。 */
const toneVariant = (tone: Tone | undefined): BadgeVariant =>
  tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : tone === 'run' ? 'hosted' : 'off';

const props = defineProps<{ runId: string }>();
const router = useRouter();

const live = ref(true);
const runId = computed(() => props.runId);

/*
 * loadingMore / hasMore / loadMore 是一组：首屏只取最早一页（保证树根在），
 * 剩下的由组合式函数在后台按游标补齐到「此刻为止」；只有 run 长到一次补齐的
 * 轮数上限时 hasMore 才会为 true，页面据此给出「继续加载」的入口。
 */
const { events, loading, loadingMore, hasMore, error, streamReady, loadMore } = useRunEvents(
  runId,
  { enabled: live },
);

const { data: runInfo } = useQuery({
  queryKey: computed(() => queryKeys.traceInfo(runId.value)),
  queryFn: () => fetchRunInfo(runId.value),
});

const nodes = computed(() => projectTrace(events.value));
const spanMs = computed(() => traceSpanMs(nodes.value));

/**
 * 整棵树的节点总数（含所有层）。
 *
 * <p>顶栏必须带上它：调用树是一个「一屏只装得下十来行」的滚动窗口，
 * 链路长起来能到一万多像素（528 条事件 → 264 行 ≈ 10600px）。
 * 只盯着屏幕上的行数，分不清「已经加载完了」还是「被截断了」——
 * 这两个问题的处理方式完全相反，读数却长得一模一样。
 */
function countNodes(list: TraceNode[]): number {
  return list.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

const nodeCount = computed(() => countNodes(nodes.value));

const meta = computed(() => {
  const fallback = {
    runId: runId.value,
    agentId: runInfo.value?.agentId ?? '—',
    kind: runInfo.value?.agentKind ?? ('react' as const),
    sessionId: runInfo.value?.sessionId ?? '—',
    user: runInfo.value?.user ?? '—',
    source: runInfo.value?.source ?? '—',
    durationMs: runInfo.value?.durationMs ?? 0,
    tokens: runInfo.value?.tokens ?? 0,
    cacheHitRate: runInfo.value?.cacheHitRate ?? '—',
    // 父子关系只在 run 级元信息里有（事件流里没有），原样交给投影层透传
    parentRunId: runInfo.value?.parentRunId ?? null,
    taskId: runInfo.value?.taskId ?? null,
  };
  return projectRunMeta(events.value, fallback);
});

/**
 * 回到父链路（异步子 agent 才有）。
 *
 * <p>子 agent 在父 run 收口之后才开跑，于是自己开了一条 run —— 这条链路在列表里是孤立的，
 * 用户看不出它是被谁派发的。后端在 run 行里记了 parentRunId，这里给出一个直达入口，
 * 省得人拿着 runId 去列表里翻。
 */
const parentRunId = computed(() => meta.value.parentRunId);

/**
 * 这个 agent 的详情地址。
 *
 * <p>agentKind 缺省是 'react'（后端 run 行的默认），所以 harness 之外一律按能力型走。
 * agentId 为 '—' 时返回空串，模板据此回落成纯文本 —— 拿一个占位符去拼地址，
 * 点进去会得到"读不到 Agent「—」"。
 */
const agentLink = computed(() =>
  meta.value.agentId === '—'
    ? ''
    : agentDetailLink(meta.value.agentId, meta.value.agentKind === 'harness' ? 'HARNESS' : 'REACT'),
);

/**
 * 这次 run 里有没有「丢到后台去了」的派发。
 *
 * <p>图例只在真有这种节点时出现：它对应的是 wait 这一档状态色（灰色）。
 * 常驻的话，一次全同步的调用里会出现一个永远对不上的图例。
 */
const hasBackgroundDispatch = computed(() =>
  flattenTrace(nodes.value).some((node) => node.kind === 'subagent' && node.status === 'wait'),
);

/*
 * run 上的两个标识做成可点（见 ui/types.ts 的 KVItem.to）。
 *
 * <p>为什么在这里、而不是再加一排按钮：这两个值本身就是**定位坐标** ——
 * "这次执行属于哪一串对话、是谁在问"。看完一条链路之后的自然动作就是其中之一，
 * 把坐标变成入口比在工具栏上多摆两个按钮更省事，也更不容易被忽略。
 *
 * <p>会话带上 agentId 一起筛：同一条会话可能被多个 agent 服务过
 * （见 api/sessions.ts 的口径），不筛会落到一大串别人的会话上。
 * user / sessionId 为 '—' 时不给地址 —— 那表示 run 元信息里没有这一项
 * （projectRunMeta 的兜底值），点了也只会得到一个筛不到东西的列表。
 */
const metaItems = computed<KVItem[]>(() => [
  {
    label: '会话',
    value: meta.value.sessionId,
    mono: true,
    to:
      meta.value.sessionId === '—'
        ? undefined
        : sessionsLink({ agentId: meta.value.agentId, sessionId: meta.value.sessionId }),
  },
  {
    label: '用户',
    value: meta.value.user,
    mono: true,
    to: meta.value.user === '—' ? undefined : sessionsLink({ userId: meta.value.user }),
  },
  { label: '来源', value: meta.value.source },
  { label: '总耗时', value: `${((meta.value.durationMs ?? 0) / 1000).toFixed(1)}s · 迭代 ${meta.value.iterations}` },
  { label: 'Token', value: `${formatTokens(meta.value.tokens)}（缓存 ${meta.value.cacheHitRate}）` },
  // 后台任务号只在异步派发里有值。不显示它的话，父链路里那个 wait 状态的派发节点就没法对到这条 run 上。
  ...(meta.value.taskId
    ? [{
        label: '任务',
        value: meta.value.taskId,
        mono: true,
        note: '框架后台任务号，与父链路里派发节点的 task_id 是同一个',
      }]
    : []),
  { label: '状态', value: '', badge: { text: meta.value.status, variant: toneVariant(meta.value.tone) } },
]);

const selectedPath = ref('1');
const dialogOpen = ref(false);

watch(nodes, (list) => {
  if (list.length > 0 && !findTraceNode(list, selectedPath.value)) selectedPath.value = list[0].path;
});

/* 换 runId（比如从列表点另一条）时把选中节点与弹窗状态一起归零，别把上一条的节点留在屏幕上。 */
watch(runId, () => {
  selectedPath.value = '1';
  dialogOpen.value = false;
});

const selectedNode = computed(() => findTraceNode(nodes.value, selectedPath.value));
const detail = computed(() =>
  selectedNode.value ? describeTraceNode(selectedNode.value, events.value, spanMs.value) : null,
);

const detailItems = computed<KVItem[]>(() =>
  (detail.value?.fields ?? []).map((field) => ({
    label: field.label,
    value: field.value,
    mono: field.mono,
    badge: field.badge
      ? { text: field.badge.text, variant: toneVariant(field.badge.tone) }
      : undefined,
  })),
);

const dialogTitle = computed(() =>
  detail.value ? detail.value.node.label : '节点详情',
);

/** 点树上的行 = 选中 + 弹出明细。收起箭头是 stopPropagation 的，不会误触。 */
function onSelectNode(path: string) {
  selectedPath.value = path;
  dialogOpen.value = true;
}

function exportJson() {
  const payload = JSON.stringify({ run: meta.value, events: events.value }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${runId.value}-events.json`;
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="row breadcrumb">
    <el-button size="small" @click="router.push('/traces')">← 返回执行链路</el-button>
    <span class="hint">/</span>
    <span class="hint mono">{{ runId }}</span>
    <!-- 异步子 agent 的链路能直接跳回派发它的父链路（父 run 收口后才开跑，列表里看不出归属） -->
    <template v-if="parentRunId">
      <span class="hint">·</span>
      <el-button size="small" @click="router.push(`/traces/${parentRunId}`)">
        ← 回到父链路
      </el-button>
      <span class="hint mono">{{ parentRunId }}</span>
    </template>
    <span class="spacer" />
    <span class="hint">
      已加载 {{ events.length }} 条事件 · {{ nodeCount }} 个节点 ·
      {{ streamReady ? '增量推送中' : '加载中…' }}
    </span>
  </div>

  <PageHeader title="链路详情">
    <template #actions>
      <el-button @click="exportJson">导出 JSON</el-button>
      <el-switch v-model="live" active-text="实时刷新" />
    </template>
  </PageHeader>

  <div class="stack">
    <PaneCard>
      <div class="row head">
        <AppBadge :variant="meta.agentKind">{{ meta.agentKind }}</AppBadge>
        <!--
          agent 名做成链接：读完这条链路最常见的下一个问题就是"这个 agent 是怎么配的"
          （提示词、工具、是不是 harness）。agentKind 是 react / harness，
          这里翻成后端的大写取值交给 agentDetailLink 选入口。
        -->
        <router-link
          v-if="agentLink"
          class="head__ag"
          :to="agentLink"
        >{{ meta.agentId }}</router-link>
        <b v-else>{{ meta.agentId }}</b>
        <StatusDot :tone="meta.tone" />
        <span class="hint">runId <span class="mono">{{ meta.runId }}</span></span>
      </div>
      <KVList class="mt" :items="metaItems" />
    </PaneCard>

    <!--
      有数据就优先渲染树：实时通道（SSE）报错不该把已经拿到的历史链路一起抹掉。
      以前这里是 v-else-if="error"，结果推送一断（哪怕是后端没实现这个端点）整页只剩一行错误文案，
      看起来像"链路功能坏了"，其实历史数据是好的，只是增量那一半掉了。
    -->
    <!--
      补齐提示：首屏只画最早一页，其余由 pullForward 在后台一轮轮续拉。
      链路不长时这一行根本不出现；只有 run 长到一次补齐的轮数上限才出现 ——
      此时页面是「前 N 条已渲染、后面还有」，按钮把决定权交回给人，
      而不是继续静默地拉（旧实现既不提示也没有入口，页面就停在被截断的那一段）。
      它必须放在这一串 v-if / v-else 的外面：v-else 要求紧邻上一个分支，
      中间塞一个元素会直接把分支链打断（只在编译期报错，跑起来才发现整棵树没了）。
    -->
    <div v-if="events.length > 0 && (hasMore || loadingMore)" class="more">
      <span class="hint">
        {{
          loadingMore
            ? `正在向后加载链路事件…（已加载 ${events.length} 条）`
            : `链路尚未加载完，当前只渲染了前 ${events.length} 条事件`
        }}
      </span>
      <el-button v-if="hasMore && !loadingMore" size="small" @click="loadMore">
        继续加载
      </el-button>
    </div>
    <div v-if="loading && events.length === 0" class="loading">加载中…</div>
    <div v-else-if="events.length === 0 && error" class="loading">事件流异常：{{ error }}</div>
    <TraceTree
      v-else
      :nodes="nodes"
      :span-ms="spanMs"
      :selected-path="selectedPath"
      @select="onSelectNode"
    />
    <div v-if="error && events.length > 0" class="notice">
      实时推送中断，链路已按历史数据渲染（{{ error }}）
    </div>

    <div class="legend">
      <span><i class="lg-agent" />Agent 阶段</span>
      <span><i class="lg-reasoning" />模型调用</span>
      <span><i class="lg-tool" />工具调用</span>
      <span><i class="lg-subagent" />子 Agent 派发</span>
      <span v-if="hasBackgroundDispatch"><i class="lg-wait" />后台运行中（结果未回）</span>
    </div>
  </div>

  <el-dialog
    v-model="dialogOpen"
    class="node-dialog"
    width="min(1120px, 94vw)"
    top="4vh"
    append-to-body
  >
    <template #header>
      <div class="row dlg-hd">
        <StatusDot v-if="detail" :tone="detail.node.status" />
        <b>{{ dialogTitle }}</b>
        <span class="spacer" />
        <span class="hint">路径 <span class="mono">{{ selectedPath }}</span></span>
      </div>
    </template>

    <div v-if="detail" class="dlg">
      <KVList label-width="120px" :items="detailItems" />
      <div v-for="section in detail.sections" :key="section.title" class="sec">
        <h3>{{ section.title }}</h3>
        <pre class="j">{{ section.json }}</pre>
      </div>
      <AppNote v-if="detail.sections.length === 0" class="mt">暂无详情</AppNote>
    </div>
  </el-dialog>
</template>

<style scoped>
/* 顶栏里的 agent 名：与 KVList 的行内链接同一套长相（全局 .lk），只是字号大一档 */
.head__ag {
  color: inherit;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  border-bottom: 1px dashed var(--bd);
}
.head__ag:hover {
  color: var(--pri-ink);
  border-bottom-color: var(--pri-line);
}
.breadcrumb {
  margin-bottom: var(--s3);
}
.head {
  gap: var(--s2);
}
.notice {
  padding: 8px 12px;
  color: var(--dot-run);
  font-size: 13px;
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
}
/* 截断 / 补齐提示条：沿用 .notice 的外观，页面里不要出现第二种「提示块」长相。 */
.more {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: 8px 12px;
  font-size: 13px;
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s3);
  font-size: 12.5px;
  color: var(--t3);
  padding: 0 4px;
}
.legend i {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
}
.lg-agent {
  background: var(--pri);
}
.lg-reasoning {
  background: var(--dot-run);
}
.lg-tool {
  background: var(--dot-ok);
}
.lg-subagent {
  background: var(--pri);
}
/* wait 一档的状态色（灰）：派发已完成但子 agent 还在后台跑，结果还没回到父上下文 */
.lg-wait {
  background: var(--dot-wait);
}
.dlg-hd {
  gap: var(--s2);
  padding-right: var(--s5);
}
.dlg {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}
.sec h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--t2);
}
</style>

<style>
/*
 * 弹窗是 teleport 到 body 的，scoped 属性匹配不到 Element Plus 内部节点，
 * 所以这两条必须放在非 scoped 块里（和 TraceTree 的选中行同一个理由）。
 *
 * 正文限高 + 内部滚动：入参/出参可能有几十行，不限高弹窗会长过视口，
 * 整个页面跟着滚，标题栏滚出屏幕就找不到自己在看哪个节点了。
 */
.node-dialog .el-dialog__body {
  max-height: 74vh;
  overflow: auto;
}
/* 弹窗里能给的宽度多，JSON 不要还停在 320px 的小窗口里。 */
.node-dialog pre.j {
  max-height: 46vh;
}
</style>
