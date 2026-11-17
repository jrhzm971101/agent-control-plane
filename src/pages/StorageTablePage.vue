<script setup lang="ts">
/*
 * 状态存储 · 表详情（/storage/:table）。
 *
 * 这一页只回答一个问题：这张表里有哪些会话，各自占了多少、最后一次写入是什么时候。
 * 上下文里「到底有什么」是再下一级（/storage/:table/:slotId）的事 —— 那一段是
 * MB 级的 JSON 摘要，跟列表放在一起会把这一页的取数拖成秒级。
 *
 * ===========================================================================
 * 一、表名从路径来（props.table），不从这个页面的查询结果来
 *
 * 页面上的会话清单是**服务端分页**的，它不携带表的存在性；而表清单接口回答的是
 * 「有哪些表」。两者是两件事：一张已经没有任何会话的表依然存在于表清单里，
 * 而一个打错的表名在会话接口上会直接报错。所以：
 *   - 会话清单用 props.table（地址栏里那个，用户的真实意图）；
 *   - 顶部那张「表信息」卡才需要去表清单里查，查不到就说明这个地址写错了 ——
 *     这时显式提示，而不是渲染一张空表让人以为"这张表是空的"。
 *
 * ===========================================================================
 * 二、关键字走查询串、不进路径
 *
 * 表是主体（换了就是换了一页，该有独立的地址）；关键字是一次检索，
 * 把它写进路径会让「搜过什么」变成地址的一部分，用户点返回时会一格格退回
 * 之前的每一次输入。所以关键字留在 ?keyword= 上，由页面自己维护。
 */
import { computed, ref, watch } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { useDebounce } from '@/lib/useDebounce';
import { queryKeys } from '@/lib/queryKeys';
import { agentDetailLink } from '@/lib/links';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import { fetchStateSessions, fetchStateTables } from '@/api/state';
import type { BadgeVariant, KVItem } from '@/components/ui/types';
import PageHeader from '@/components/ui/PageHeader.vue';
import PaneCard from '@/components/ui/PaneCard.vue';
import KVList from '@/components/ui/KVList.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';

const props = defineProps<{ table: string }>();

const router = useRouter();
const route = useRoute();

const { data: tables } = useQuery({ queryKey: queryKeys.stateTables, queryFn: fetchStateTables });

/** 当前这张表在清单里的那一行；地址写错时为 undefined。 */
const tableRow = computed(() =>
  (tables.value ?? []).find((item) => item.tableName === props.table),
);

const tableKv = computed<KVItem[]>(() => {
  const row = tableRow.value;
  if (!row) return [];
  return [
    { label: '状态表', value: row.tableName, mono: true },
    {
      label: '所属 Agent',
      // 点它去这个 agent 的详情："这张表的记忆是谁在用"是这一页最常见的下一个问题。
      // 孤儿表（没有 agent 声明）没有可跳的目标，保持纯文本。
      value: row.agentName ?? '（没有 agent 声明它：孤儿表）',
      mono: true,
      to: row.agentName ? agentDetailLink(row.agentName) : undefined,
    },
    { label: '会话', value: `${row.sessions} 个`, mono: true },
    { label: '状态行', value: `${row.rows} 行`, mono: true },
    { label: '体积', value: formatBytes(row.bytes), mono: true },
    {
      label: '最近写入',
      value: row.lastWriteAt ? `${formatDateTime(row.lastWriteAt)} · ${formatRelative(row.lastWriteAt)}` : '从未写入',
    },
  ];
});

/*
 * 关键字要防抖。
 *
 * 后端是在内存里对整张表做匹配的（表名是动态的，拼 LIKE 反而更麻烦），请求本身很快；
 * 真正的问题是每敲一个字母发一次请求时，后到的旧响应会把新结果盖掉，列表在眼前自己跳。
 *
 * 深链带过来的关键字要当作**初值**，所以必须写在 useDebounce 之前 ——
 * refDebounced 是用源 ref 的当前值初始化输出的，写在后面的话输出先是空串、
 * 300ms 后才补上关键字，那期间页面会先发一次不带关键字的请求。
 */
const keywordInput = ref(typeof route.query.keyword === 'string' ? route.query.keyword : '');
const keyword = useDebounce(keywordInput, 300);

const page = ref(1);
const pageSize = ref(20);
const offset = computed(() => (page.value - 1) * pageSize.value);

/* 换表或改关键字后停在原页码，很容易落到一页空数据上，一律回到第一页。 */
watch([() => props.table, keyword], () => {
  page.value = 1;
});

const {
  data: sessions,
  isLoading: sessionsLoading,
  error: sessionsError,
} = useQuery({
  queryKey: computed(() =>
    queryKeys.stateSessions(props.table, keyword.value ?? '', offset.value),
  ),
  queryFn: () =>
    fetchStateSessions({
      table: props.table,
      keyword: keyword.value,
      limit: pageSize.value,
      offset: offset.value,
    }),
  /* 翻页与搜索时保留上一页数据，否则表格每翻一页都要闪一次「加载中」。 */
  placeholderData: keepPreviousData,
});

const sessionRows = computed(() => sessions.value?.items ?? []);

/*
 * 表级状态：这张表有没有被框架建出来、是不是残留。
 *
 * 「读不到这张表」不等于「这张表是空的」：前者是地址写错了（清单里没有它），
 * 后者是表在库里只是还没写过数据。两者必须分开说 —— 混成一句会让人对着
 * 一张空表怀疑自己的 agent 没在跑。所以模板里分三态：清单还没到（加载中）/
 * 清单里没有它（地址错了）/ 有它（正常渲染表信息）。
 */
const stateBadge = computed<{ text: string; variant: BadgeVariant }>(() => {
  const row = tableRow.value;
  if (!row) return { text: '清单里没有这张表', variant: 'err' };
  if (!row.exists) return { text: '尚未创建', variant: 'wait' };
  if (!row.agentName) return { text: '孤儿表', variant: 'hosted' };
  return { text: '在库', variant: 'ok' };
});

/*
 * 整行可点。
 *
 * 处理函数写在 script 里而不是模板里的内联箭头：模板里的内联箭头带 TS 类型标注
 * （(row: { slotId: string }) => ...）编译不过 —— 模板表达式不是 TS 函数的声明位置。
 */
function onRowClick(row: { slotId: string }): void {
  openSession(row.slotId);
}

/** 进会话详情：表名与 slotId 都必须编码，slotId 里含冒号（<userId>:<sessionId>）。 */
function openSession(slotId: string): void {
  void router.push(
    `/storage/${encodeURIComponent(props.table)}/${encodeURIComponent(slotId)}`,
  );
}

function refresh(): void {
  void router.push('/storage');
}
</script>

<template>
  <PageHeader
    :title="`状态表 ${table}`"
  >
    <template #actions>
      <el-button @click="router.push('/storage')">← 返回状态存储</el-button>
    </template>
  </PageHeader>

  <div class="stack">
    <!--
      三态：清单还没到 → 加载中；清单里没有这张表 → 地址写错了；
      有它 → 渲染表信息。中间那一档不能和第一档合并，否则加载期间会先闪一句
      「这张表不在清单里」，看起来像地址真的错了。
    -->
    <PaneCard v-if="tables === undefined" title="表信息">
      <div class="loading">加载中…</div>
    </PaneCard>

    <PaneCard v-else-if="!tableRow" title="这张表不在清单里">
      <EmptyState
        title="地址里的表名对不上任何一张状态表"
      >
        <template #action>
          <el-button size="small" @click="refresh">返回状态存储</el-button>
        </template>
      </EmptyState>
    </PaneCard>

    <PaneCard v-else title="表信息" :right="tableRow.exists ? undefined : '尚未创建'">
      <div class="row mb">
        <AppBadge :variant="stateBadge.variant">{{ stateBadge.text }}</AppBadge>
      </div>
      <KVList :items="tableKv" label-width="112px" />
    </PaneCard>

    <FilterBar :result="{ count: sessions?.total ?? 0, total: sessions?.tableTotal ?? 0, noun: '个会话' }">
      <FilterField label="关键字" width="260px">
        <el-input v-model="keywordInput" placeholder="用户或会话 ID 的子串" clearable />
      </FilterField>
      <template #actions>
        <el-button :disabled="!keywordInput" @click="keywordInput = ''">重置</el-button>
      </template>
    </FilterBar>

    <TableCard :loading="sessionsLoading && sessionRows.length === 0">
      <!--
        取数失败和「这个表就是空的」要分开说：后者是正常的（新 agent 还没对话过），
        前者是后端的问题。混成一句会让人对着空表怀疑自己的 agent 没在跑。
      -->
      <EmptyState
        v-if="sessionsError"
        title="读不到会话列表"
        :hint="(sessionsError as Error).message"
      />
      <EmptyState
        v-else-if="sessionRows.length === 0"
        :title="keywordInput ? '没有匹配的会话' : '这张表还没有会话'"
      />
      <template v-else>
        <el-table :data="sessionRows" @row-click="onRowClick">
          <el-table-column label="用户" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="['mono', { muted: !row.userId }]">{{ row.userId || '（未分区）' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="会话" min-width="220" show-overflow-tooltip>
            <template #default="{ row }"><span class="mono">{{ row.sessionId || row.slotId }}</span></template>
          </el-table-column>
          <el-table-column label="状态行" width="90" align="right">
            <template #default="{ row }"><span class="mono">{{ row.rows ?? '—' }}</span></template>
          </el-table-column>
          <el-table-column label="大小" width="100" align="right">
            <template #default="{ row }"><span class="mono">{{ formatBytes(row.bytes) }}</span></template>
          </el-table-column>
          <el-table-column label="最近写入" width="200">
            <template #default="{ row }">
              <span class="mono">{{ formatDateTime(row.updatedAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" align="right">
            <template #default="{ row }">
              <el-button link type="primary" @click.stop="openSession(row.slotId)">查看上下文</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pgbar">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="sessions?.total ?? 0"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
          />
        </div>
      </template>

    </TableCard>
  </div>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}
/* 表格整行可点：鼠标形状必须跟着变，否则「点一行能进详情」这件事没人会发现。 */
:deep(.el-table__row) {
  cursor: pointer;
}
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
</style>
