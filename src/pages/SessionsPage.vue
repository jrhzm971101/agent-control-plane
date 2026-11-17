<script setup lang="ts">
/*
 * 会话记录 · 控制台的第三层。
 *
 * 这一页回答的问题与前两页不同，所以它值得单独存在：
 *   · 执行链路页（/traces）回答「这一次是怎么走的」—— 一棵调用树、几百条事件；
 *   · 状态存储页（/storage）回答「agent 现在还记得什么」—— 一张表、一段上下文；
 *   · 本页回答「这是谁、聊过几轮、被哪几个 agent 服务过、还记得多少」，
 *     并把上面两个视角按会话聚合起来。
 *
 * ===========================================================================
 * 一、会话不是一个实体，是 md_agent_run 按 (user_id, session_id) 的聚合
 *
 * 之所以能这么定，是因为 run 表里已经有两列把这件事说清楚了：
 * 一次调用 = 一行 run（= 一棵调用树的根），同一串 run 的 (user_id, session_id) 相同。
 * 于是「会话」不需要新表、也不需要新的写入方，它就是这两列的 GROUP BY。
 * 反过来，如果为它单开一张表，就多了一个必须与 run 保持同步的地方 ——
 * 而同步不上的表现是「链路里明明有一次执行，会话列表里却没有」，
 * 那比没有这一页更糟：一个安静的假象比一个明显的缺口更难查。
 *
 * 由此推出这一页的两个性质：
 *   1. 只读。改一条会话等于改它底下的一批 run，而 run 是历史事实、只增不改。
 *      要清记忆去状态存储页（那里删的是状态，不是链路）；清链路用链路页的动作。
 *   2. agent 是筛选维度，不是归属维度。实测：企微里同一条会话先交给
 *      workwx_batch_agent 又交给 deployment_agent，sessionId 没变 ——
 *      因为 sessionId 由入口方自己算，里面不含 agent。所以「服务过的 agent」
 *      是一列数组，而按 agent 筛的含义是「凡是被这个 agent 服务过的会话」。
 *
 * ===========================================================================
 * 二、五个筛选维度全部在服务端
 *
 * agent / 来源 / 时间窗 / 关键字 / 有没有记忆，都由后端在聚合结果上过一遍
 * （见后端 AgentSessionAdminService）。页面一个都不自己筛 ——
 * 因为列表是分页的：在当页那 20 行上筛，用户看到「共 57 个会话、筛出 3 条」时
 * 无法判断那 3 条是全部符合的，还是只是第一页里符合的。
 * 分页与服务端筛选是同一个决定的两半，拆开会立刻出现上面那种自相矛盾。
 *
 * 唯一交给前端算的是每页的合计（执行次数 / token）—— 那本来就是「这一屏加起来多少」，
 * 天然是页内口径，在页脚写清楚即可。
 */
import { computed, ref, watch } from 'vue';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useDebounce } from '@/lib/useDebounce';
import { useRoute, useRouter } from 'vue-router';
import { queryKeys } from '@/lib/queryKeys';
import {
  agentDetailLink,
  queryString,
  sessionsLink,
  stateSlotId,
  storageSessionLink,
  storageTableLink,
  traceLink,
} from '@/lib/links';
import { agentDisplayName } from '@/lib/agentDisplay';
import {
  ellipsizeMiddle,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
} from '@/lib/format';
import { listAgents } from '@/api/controlplane';
import { fetchSessionDetail, fetchSessions, type SessionRow } from '@/api/sessions';
import type { BadgeVariant, KVItem } from '@/components/ui/types';
import type { Tone } from '@/api/types';
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterChips from '@/components/ui/FilterChips.vue';
import FilterField from '@/components/ui/FilterField.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import KVList from '@/components/ui/KVList.vue';

const router = useRouter();
/*
 * 读一次地址上的筛选（agent / keyword / source / hasState），把它当作初始值。
 *
 * <p>为什么只读、不写回：这一页的筛选是**服务端**的，也是分页的；
 * 每次改动都 router.replace 一次会与关键字防抖叠在一起（改一个字母写一次历史），
 * 而且把一个"正在打字"的中间值写进了地址。只读一侧就够用：
 * 从别处跳过来时（对话页、链路详情、agent 详情）能直接落在筛好的列表上，
 * 从详情页按浏览器返回时，URL 还是当初那个带参数的地址，筛选也就自动还原了。
 *
 * <p>agent 参数的键名与 links.ts 的 sessionsLink 一致 —— 两边是同一份约定的两端，
 * 改一处要同时改另一处（这也是把它们写在一个文件里互相引用注释的原因）。
 */
const route = useRoute();
const queryClient = useQueryClient();

// ==================== 筛选 ====================

/*
 * 「有没有记忆」是三态，不是两个开关。
 *
 * null = 全部、true = 只看还有记忆的、false = 只看已经没有记忆的。
 * 用 null 而不是空串表达「全部」：这一维刚好会取到 false，而 false 在 buildUrl 里
 * 是"有值"不会被丢掉 —— 一旦用可空字符串表达，第二个和第三个取值就会撞在一起。
 */
/*
 * hasState 的地址表示是字符串 'true' / 'false'：URLSearchParams 只能写字面量，
 * 而这里必须区分「没给」（三态里的 null）与「明确是 false」——
 * 直接 `Boolean(raw)` 会把 'false' 判成 true，于是"只看无记忆的"变成"只看有记忆的"。
 */
const seededHasState = queryString(route.query, 'hasState');
const hasState = ref<boolean | null>(
  seededHasState === 'true' ? true : seededHasState === 'false' ? false : null,
);

/* chips 只驱动上面那个三态，本身不持有状态：两份状态必然会出现不同步的那一天。 */
const chipValue = computed<string>({
  get: () => (hasState.value === null ? 'all' : hasState.value ? 'has' : 'none'),
  set: (key) => {
    hasState.value = key === 'all' ? null : key === 'has';
  },
});

/*
 * chips 上不带条数。
 *
 * 另外两页的 chips 带条数，是因为它们的数据全在前端（一次拉回、本地筛）。
 * 这里列表是分页的，从当页算出来的条数会与右上角的「共 N 个会话」互相矛盾，
 * 而那种矛盾没法用一句文案说圆 —— 索性只给状态、不给数字。
 */
const chips = [
  { key: 'all', label: '全部' },
  { key: 'has', label: '有记忆' },
  { key: 'none', label: '无记忆' },
];

const agentId = ref(queryString(route.query, 'agent'));
const source = ref(queryString(route.query, 'source'));
const range = ref<[Date, Date] | null>(null);
const keywordInput = ref(queryString(route.query, 'keyword'));

/* 关键字要防抖：每敲一个字母发一次请求时，后到的旧响应会把新结果盖掉，列表在眼前自己跳。 */
const keyword = useDebounce(keywordInput, 300);

/* 选日期时两端补成当天 00:00:00 / 23:59:59，否则「选今天」会漏掉 00:00 之后的所有执行。 */
const defaultTime: [Date, Date] = [new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59)];
const shortcuts = [
  { text: '近 1 小时', value: () => [new Date(Date.now() - 3_600_000), new Date()] },
  { text: '近 24 小时', value: () => [new Date(Date.now() - 24 * 3_600_000), new Date()] },
  { text: '近 7 天', value: () => [new Date(Date.now() - 7 * 24 * 3_600_000), new Date()] },
  { text: '近 30 天', value: () => [new Date(Date.now() - 30 * 24 * 3_600_000), new Date()] },
];

const page = ref(1);
const pageSize = ref(20);
const offset = computed(() => (page.value - 1) * pageSize.value);

/* 任何筛选变化都回到第一页：停在原页码很容易落到一页空数据上，用户会以为还没加载。 */
watch([hasState, agentId, source, range, keyword], () => {
  page.value = 1;
});

const dirty = computed(
  () =>
    hasState.value !== null ||
    Boolean(agentId.value) ||
    Boolean(source.value) ||
    range.value !== null ||
    keywordInput.value !== '',
);

/*
 * 同一个对象，既喂 queryKey 也喂 queryFn。
 *
 * 拆成两份的写法迟早会出现「键变了但请求没变」，而那种 bug 的表现是
 * 「点了筛选，结果没动」—— 没人会先怀疑缓存。
 * 时间窗在这里就转成 epoch millis：后端与 run 表同口径，不必再解析日期字符串，
 * 也就不会有「这个时间按谁的时区算」的争议。
 */
const query = computed(() => ({
  agentId: agentId.value ?? '',
  source: source.value ?? '',
  from: range.value?.[0]?.getTime() ?? null,
  to: range.value?.[1]?.getTime() ?? null,
  keyword: keyword.value ?? '',
  hasState: hasState.value,
  limit: pageSize.value,
  offset: offset.value,
}));

const {
  data: pageData,
  isLoading,
  error: loadError,
} = useQuery({
  queryKey: computed(() => queryKeys.sessions(query.value)),
  queryFn: () => fetchSessions(query.value),
  /* 翻页或改筛选时保留上一批数据，否则表格每动一次都要闪一遍「加载中」。 */
  placeholderData: keepPreviousData,
});

const rows = computed<SessionRow[]>(() => pageData.value?.items ?? []);

// ==================== agent 下拉与展示名 ====================

/*
 * 下拉候选取全部 agent，而不是「当前这批会话里出现过的」。
 *
 * 与执行链路页的取舍不同：那里整张列表都在前端，所以能反推出用过的 agent；
 * 这里列表是分页的，用它推出来的候选会随翻页变化 —— 一个「选过就消失」的下拉
 * 比一个固定的下拉更难理解。展示名一律走 agentDisplayName，
 * 回落规则只有一处，同一个 agent 不会在不同的页面上叫不同的名字。
 */
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });
const displayNameOf = computed(() => agentDisplayName(agents.value));

/*
 * agent 名 → 类型。用来决定「点这个名字去能力域还是编排域」（见 links.ts 的 agentDetailLink）。
 *
 * 取自同一份 agent 清单，不额外发请求。查不到时给 null，由 agentDetailLink 回落到 /agents
 * —— 详情页读的是接口里的 agentType，落错入口也不会显示错内容，只是 tab 少几个。
 */
const agentTypeOf = computed(() => {
  const byName = new Map((agents.value ?? []).map((row) => [row.agentName, row.agentType]));
  return (name: string): string | null => byName.get(name) ?? null;
});

/** 会话 / run 里出现的 agent 标识 → 详情地址。模板里到处要用，收成一个函数。 */
function agentLinkOf(name: string): string {
  return agentDetailLink(name, agentTypeOf.value(name));
}
const agentOptions = computed(() =>
  [...(agents.value ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh')),
);

// ==================== 来源词表 ====================

/*
 * 来源是闭集（后端 AgentTraceRun.SOURCE_*），所以页面用固定词表翻成中文，
 * 而不是把库里的英文原样显示 —— wecom 是给机器看的键，不是给人看的名。
 *
 * 「未标注」（列为 NULL）不进下拉：后端是按精确匹配筛的，一个必然查不到任何结果的
 * 选项比没有这个选项更浪费人的时间。存量数据没有来源这件事，在表格里照样看得见。
 */
const SOURCE_LABELS: Record<string, string> = {
  console: '控制台',
  wecom: '企业微信',
  feishu: '飞书',
  schedule: '定时任务',
};
const sourceOptions = Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label }));

function sourceLabel(value: string | null): string {
  if (!value) return '未标注';
  return SOURCE_LABELS[value] ?? value;
}

// ==================== 状态 → 视觉 ====================

const statusText: Record<string, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
};

/* 后端给的 tone 语义 → 徽标样式；与链路详情页同一个映射，页面统一在这里收口。 */
const toneVariant = (tone: Tone | undefined): BadgeVariant =>
  tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : tone === 'run' ? 'hosted' : 'off';

/** 成功率。一次都没跑过时给 0 而不是 NaN —— NaN 在页面上会显示成 "NaN%"。 */
function successRate(row: SessionRow): number {
  if (row.runs <= 0) return 0;
  return Math.round(((row.runs - row.failed) / row.runs) * 100);
}

// ==================== 详情抽屉 ====================

const drawerOpen = ref(false);
const detailTarget = ref<{ userId: string | null; sessionId: string } | null>(null);

/*
 * 详情按 (userId, sessionId) 取。
 *
 * userId 允许为 null：库里有 user_id 为 NULL 的会话，而 sessionId 本身不保证全局唯一
 * （各入口自己算，群聊用 chatId、单聊用 userId、页面对话用随机短 id）。只按 sessionId
 * 取会让两条不同用户的同名会话互相串门。
 */
const {
  data: detail,
  isLoading: detailLoading,
  error: detailError,
} = useQuery({
  queryKey: computed(() =>
    queryKeys.sessionDetail(detailTarget.value?.userId ?? null, detailTarget.value?.sessionId ?? ''),
  ),
  queryFn: () => fetchSessionDetail(detailTarget.value!.userId, detailTarget.value!.sessionId),
  enabled: () => drawerOpen.value && detailTarget.value !== null,
});

const runs = computed(() => detail.value?.runs ?? []);
const stateTables = computed(() => detail.value?.states ?? []);

const detailKv = computed<KVItem[]>(() => {
  const d = detail.value;
  if (!d) return [];
  return [
    {
      label: '用户',
      // 点它 = 看这个人名下的全部会话。会话列表接口只有 keyword 子串匹配（见 links.ts），
      // 所以这里传的是 userId —— 后端同时匹配 user_id 与 session_id，语义刚好是"这个人的"。
      value: d.userId || '（未分区）',
      mono: true,
      to: d.userId ? sessionsLink({ userId: d.userId }) : undefined,
    },
    { label: '会话', value: d.sessionId, mono: true },
    { label: '执行次数', value: String(d.runs.length) + ' 次' },
    {
      label: '记忆',
      value: '',
      badge: {
        text: d.states.length > 0 ? '有记忆' : '无记忆',
        variant: d.states.length > 0 ? 'ok' : 'off',
      },
    },
  ];
});

/* 关抽屉时把目标一起清掉，下次打开不会先闪出上一条会话的内容。 */
watch(drawerOpen, (open) => {
  if (!open) detailTarget.value = null;
});

function openDetail(row: SessionRow) {
  detailTarget.value = { userId: row.userId, sessionId: row.sessionId };
  drawerOpen.value = true;
}

function gotoRun(runId: string) {
  void router.push(traceLink(runId));
}

/**
 * 进某张状态表的某个会话的上下文。
 *
 * <p>抽屉里能同时列出多张表（同一条会话被多个 agent 服务过，各写各的状态表），
 * 所以跳转必须带上**这一行**的表名，不能用「第一张表」——
 * 那正是 openStorage 顶部那个「查看记忆」按钮的行为，两者用途不同：
 * 那个是"最可能有记忆的那张"，这个是"你点的这一张"。
 */
function openStateContext(row: { tableName: string }) {
  const target = detailTarget.value;
  if (!target || !row.tableName) return;
  void router.push(storageSessionLink(row.tableName, stateSlotId(target.userId, target.sessionId)));
}

/*
 * 跳到状态存储页看这个会话的上下文。
 *
 * 表名进路径（/storage/<table>）：状态存储已经从「一页两栏」拆成「列表 → 表详情 → 会话详情」，
 * 表是主体而不是筛选条件，所以它该是一个地址 —— 从这一页跳过去之后，用户还能刷新、还能贴给别人。
 * 带上 keyword：表详情里的会话列表也是服务端分页的，一条会话可能落在第二页，
 * 用会话 ID 当关键字能直接把它筛出来。
 */
function openStorage() {
  const target = detailTarget.value;
  const first = stateTables.value[0];
  if (!target || !first) return;
  void router.push(storageTableLink(first.tableName, target.sessionId));
}

function resetFilters() {
  hasState.value = null;
  agentId.value = '';
  source.value = '';
  range.value = null;
  keywordInput.value = '';
}

function refresh() {
  void queryClient.invalidateQueries({ queryKey: ['sessions'] });
}
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button @click="refresh">刷新</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: pageData?.total ?? 0, total: pageData?.allTotal ?? 0, noun: '个会话' }">
    <FilterField label="关键字" width="240px">
      <el-input v-model="keywordInput" placeholder="用户或会话 ID 的子串" clearable />
    </FilterField>
    <FilterField label="Agent" width="200px">
      <el-select v-model="agentId" placeholder="全部 Agent" clearable filterable>
        <el-option
          v-for="item in agentOptions"
          :key="item.agentName"
          :label="item.displayName"
          :value="item.agentName"
        />
      </el-select>
    </FilterField>
    <FilterField label="来源" width="150px">
      <el-select v-model="source" placeholder="全部来源" clearable>
        <el-option v-for="item in sourceOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
    </FilterField>
    <FilterField label="最近活动" width="380px">
      <el-date-picker
        v-model="range"
        type="datetimerange"
        :default-time="defaultTime"
        :shortcuts="shortcuts"
        range-separator="至"
        start-placeholder="开始时间"
        end-placeholder="结束时间"
        unlink-panels
      />
    </FilterField>
    <template #chips>
      <FilterChips v-model="chipValue" :items="chips" />
    </template>
    <template #actions>
      <el-button :disabled="!dirty" @click="resetFilters">重置</el-button>
    </template>
  </FilterBar>

  <TableCard :loading="isLoading && rows.length === 0">
    <!--
      取数失败与「就是没有会话」要分开说：后者是正常的（还没被调用过），
      前者是后端的问题。混成一句会让人对着空表怀疑自己的 agent 从没跑起来。
    -->
    <EmptyState
      v-if="loadError"
      title="读不到会话列表"
      :hint="(loadError as Error).message"
    />
    <EmptyState
      v-else-if="rows.length === 0"
      title="没有匹配的会话"
    />

    <template v-else>
      <el-table :data="rows">
        <el-table-column label="用户" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="mono">{{ row.userId || '（未分区）' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="会话" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="mono">{{ row.sessionId }}</span>
          </template>
        </el-table-column>
        <el-table-column label="服务过的 agent" min-width="300">
          <template #default="{ row }">
            <div class="row wrap tight">
              <!--
                标签本身就是资源的引用，做成链接而不是纯文本：
                这里最常发生的动作是"这个会话是哪个 agent 在处理"，点进去看它的编排。
              -->
              <router-link
                v-for="name in row.agents"
                :key="name"
                class="tag-chip"
                :to="agentLinkOf(name)"
              >
                {{ displayNameOf(name) }}
              </router-link>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="最近活动" min-width="140">
          <template #default="{ row }">
            <span>{{ formatRelative(row.lastMs) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="76" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pgbar">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="pageData?.total ?? 0"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
        />
      </div>
    </template>

  </TableCard>

  <el-drawer v-model="drawerOpen" :with-header="false" destroy-on-close size="min(880px, 92vw)">
    <div class="dw">
      <div class="dw__hd">
        <div class="dw__ttl">
          <h2>会话详情</h2>
          <AppBadge v-if="detail" :variant="stateTables.length > 0 ? 'ok' : 'off'">
            {{ stateTables.length > 0 ? '有记忆' : '无记忆' }}
          </AppBadge>
        </div>
        <el-button :disabled="stateTables.length === 0" @click="openStorage">查看记忆</el-button>
        <el-button @click="drawerOpen = false">关闭</el-button>
      </div>

      <div class="dw__bd">
        <div v-if="detailLoading" class="loading">加载中…</div>
        <AppNote v-else-if="detailError" tone="warn">{{ (detailError as Error).message }}</AppNote>

        <template v-else-if="detail">
          <section>
            <h3 class="sec__t">这条会话</h3>
            <KVList :items="detailKv" />
          </section>

          <section class="sec">
            <h3 class="sec__t">执行时间线</h3>
            <el-table :data="runs" size="small" class="mt">
              <el-table-column label="开始时刻" width="140">
                <template #default="{ row }">
                  <span class="mono">{{ formatDateTime(row.startedAtMs) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="运行 ID" width="140">
                <template #default="{ row }">
                  <el-button link type="primary" @click="gotoRun(row.runId)">
                    {{ ellipsizeMiddle(row.runId) }}
                  </el-button>
                </template>
              </el-table-column>
              <el-table-column label="Agent" width="140" show-overflow-tooltip>
                <template #default="{ row }">
                  <router-link class="lk" :to="agentLinkOf(row.agentId)">
                    {{ displayNameOf(row.agentId) }}
                  </router-link>
                </template>
              </el-table-column>
              <el-table-column label="来源" width="88">
                <template #default="{ row }">
                  <span>{{ sourceLabel(row.source) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="状态" min-width="120">
                <template #default="{ row }">
                  <AppBadge :variant="toneVariant(row.tone)">
                    {{ statusText[row.status] ?? row.status }}
                  </AppBadge>
                  <!-- 错误只在这一行失败时才占位置；成功态的 run 不该为它留白 -->
                  <div v-if="row.error" class="err-tx" :title="row.error">{{ row.error }}</div>
                </template>
              </el-table-column>
              <el-table-column label="耗时" width="80" align="right">
                <template #default="{ row }">
                  <span class="mono">{{ formatDuration(row.durationMs) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="Token" width="80" align="right">
                <template #default="{ row }"><span class="mono">{{ formatTokens(row.tokens) }}</span></template>
              </el-table-column>
            </el-table>
          </section>

          <section class="sec">
            <h3 class="sec__t">记忆（状态存储）</h3>
            <p v-if="stateTables.length === 0" class="mt">没有记忆</p>
            <el-table v-else :data="stateTables" size="small" class="mt">
              <el-table-column label="状态表" min-width="200" show-overflow-tooltip>
                <template #default="{ row }">
                  <router-link class="lk mono" :to="storageTableLink(row.tableName)">
                    {{ row.tableName }}
                  </router-link>
                </template>
              </el-table-column>
              <el-table-column label="归属 agent" width="150" show-overflow-tooltip>
                <template #default="{ row }">
                  <!-- 孤儿表（agentName 为空）没有可跳的目标，保持纯文本 -->
                  <router-link v-if="row.agentName" class="lk mono" :to="agentLinkOf(row.agentName)">
                    {{ displayNameOf(row.agentName) }}
                  </router-link>
                  <span v-else class="mono">（孤儿表）</span>
                </template>
              </el-table-column>
              <el-table-column label="行数" width="72" align="right">
                <template #default="{ row }"><span class="mono">{{ row.rows }}</span></template>
              </el-table-column>
              <el-table-column label="最近写入" width="150">
                <template #default="{ row }">
                  <span class="mono">{{ formatDateTime(row.updatedAt) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="96" align="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openStateContext(row)">看上下文</el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </template>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
/* ---------- 表格下方：说明 + 分页 ---------- */
.pgbar {
  display: flex;
  align-items: center;
  gap: var(--s4);
  padding: 12px var(--s5);
  border-top: 1px solid var(--bd-soft);
  background: var(--panel);
}
.pgbar :deep(.el-pagination) {
  margin-left: auto;
}

/* ---------- 详情抽屉 ---------- */
.dw {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.dw__hd {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex: 0 0 auto;
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--bd);
}
.dw__ttl {
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-width: 0;
  margin-right: auto;
}
.dw__bd {
  flex: 1;
  min-height: 0;
  padding-top: var(--s4);
  overflow: auto;
}
.sec {
  padding-top: var(--s4);
  margin-top: var(--s4);
  border-top: 1px solid var(--bd-soft);
}
.sec__t {
  margin: 0 0 var(--s2);
  font-size: 13.5px;
  font-weight: 600;
  color: var(--t1);
}
/* 失败原因可能很长：截断显示，完整内容走 title 悬浮——表格里不换行才不会把行高撑乱 */
.err-tx {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--red);
  font-size: 12px;
  line-height: 1.5;
}
</style>
