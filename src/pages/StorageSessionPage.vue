<script setup lang="ts">
/*
 * 状态存储 · 会话详情（/storage/:table/:slotId）。
 *
 * 这一页回答的是这一块最核心的问题：某个会话的上下文里到底有什么 ——
 * 那是 agent 下一次对话真正会「看到」的东西。上一版这是一个抽屉，
 * 现在是一页：内容本身有四五段（状态行 / 上下文摘要 / 任务清单 / 消息预览 / 原文），
 * 抽屉的高度只够把其中一段露出来，读第二段就要在里面滚很久；
 * 而且一页一地址意味着「把这个会话的上下文发给别人看」是可行的。
 *
 * ===========================================================================
 * 一、为什么这一页只有删除，没有编辑与新建
 *
 * state_data 是框架内部对象（ReActAgent 的 AgentState）的序列化结果，字段随框架版本演进
 * （实测已含 context / tasks_context / plan_mode_context / tool_context 四套子结构）。
 * 页面写回一份「看起来对」的 JSON，风险是让框架反序列化出一个半损坏的状态，
 * 而且失败要等到下一次对话才暴露 —— 那时谁也联系不到「那天在页面上改过一次」。
 * 删除是幂等的、可解释的；编辑不是。后端 AgentStateAdminService 的类注释是同一个结论。
 *
 * ===========================================================================
 * 二、删完为什么不用重启服务
 *
 * 框架在每次 call 的开头都会从 store 重新加载该会话的状态
 * （ReActAgent.activateSlotForContext 的注释原文：state is always reloaded from the
 * store at the beginning of each call）。所以这里删掉，下一次对话就是全新上下文。
 * 这条必须写在页面上 —— 否则没人敢点删除：怕删完要重启才生效，或者怕删了不生效。
 *
 * ===========================================================================
 * 三、为什么删除不碰调用链路
 *
 * 这里只 DELETE 状态表的行，不动 md_agent_run / md_agent_run_event。
 * 两者的用途正好相反：状态是「agent 下一步要用的东西」，链路是「当时到底发生了什么」。
 * 上下文被清空之后，恰恰更需要链路还在，才能回看那次对话是怎么走完的。
 *
 * ===========================================================================
 * 四、为什么详情不直接给原文
 *
 * 实测单个会话的 agent_state 最大到 MB 级（样本 5.4 MB）。进来就传一份完整上下文，
 * 页面会卡、流量也白花。所以本页主力是「后端解析好的摘要」，原文是单独的、
 * 带体积上限的动作：超过 4 MB 后端直接 413 而不是截断 —— 截断后的 JSON 不是合法文档，
 * 前端再解析会报一个更难懂的错误。
 */
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { queryKeys } from '@/lib/queryKeys';
import { sessionsLink, storageTableLink } from '@/lib/links';
import { formatBytes, formatDateTime } from '@/lib/format';
import {
  deleteStateSession,
  fetchStateRaw,
  fetchStateSessionDetail,
} from '@/api/state';
import { notifyFailure, notifySuccess } from '@/features/controlplane/feedback';
import type { BadgeVariant, KVItem } from '@/components/ui/types';
import PageHeader from '@/components/ui/PageHeader.vue';
import PaneCard from '@/components/ui/PaneCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import KVList from '@/components/ui/KVList.vue';
import JsonBlock from '@/components/ui/JsonBlock.vue';

const props = defineProps<{ table: string; slotId: string }>();

const router = useRouter();
const queryClient = useQueryClient();

const {
  data: detail,
  isLoading: detailLoading,
  error: detailError,
} = useQuery({
  queryKey: computed(() => queryKeys.stateSessionDetail(props.table, props.slotId)),
  queryFn: () => fetchStateSessionDetail(props.table, props.slotId),
});

/*
 * 原文单独一次查询，由按钮触发。
 *
 * 不跟详情一起拉，两个原因：原文是 MB 级的大字段，多数时候没人看；
 * 而且它可能因为超限而失败，那个失败不该把整个详情面板变成错误态。
 */
const rawWanted = ref(false);
const {
  data: rawText,
  isLoading: rawLoading,
  error: rawError,
} = useQuery({
  queryKey: computed(() => queryKeys.stateRaw(props.table, props.slotId)),
  queryFn: () => fetchStateRaw(props.table, props.slotId),
  enabled: () => rawWanted.value,
});

/* 换了会话就把「已请求原文」复位，否则下一次进来会直接闪出上一份原文。 */
watch(() => props.slotId, () => {
  rawWanted.value = false;
});

const snapshot = computed(() => detail.value?.snapshot ?? null);
const slots = computed(() => detail.value?.slots ?? []);
const parseError = computed(() => detail.value?.parseError ?? null);

/* 详情里的标量字段先取出来，模板里就不用再对 detail 做判空。 */
const detailKv = computed<KVItem[]>(() => {
  const d = detail.value;
  if (!d) return [];
  return [
    {
      label: '状态表',
      value: props.table,
      mono: true,
      // 回上一层（这张表里还有哪些会话）
      to: storageTableLink(props.table),
    },
    {
      label: '用户',
      value: d.userId || '（未分区）',
      mono: true,
      // 会话记录页按 (user_id, session_id) 聚合；这一列的取值语义与它完全一致
      to: d.userId ? sessionsLink({ userId: d.userId, sessionId: d.sessionId }) : undefined,
    },
    {
      label: '会话',
      value: d.sessionId || '—',
      mono: true,
      /*
       * 这条会话的执行记录（换了视角看同一条会话：这里看的是"上下文还剩什么"，
       * 会话记录页看的是"它被调用过几次、谁在问"）。
       * sessionId 为空表示这一槽位没有会话标识（槽位是按 state_key 切的），
       * 那种情况下不给地址 —— 只按 userId 筛会落到这个人的全部会话上，答非所问。
       */
      to: d.sessionId ? sessionsLink({ sessionId: d.sessionId }) : undefined,
    },
    { label: '状态行', value: `${d.slots.length} 行`, mono: true },
    { label: '总体积', value: formatBytes(d.totalBytes), mono: true },
  ];
});

/*
 * 摘要区：只放「读一眼就知道这个会话处在什么状态」的字段。
 * 空值不省略也不编造 —— 例如「压缩摘要：压缩从未触发」比留白有用得多，
 * 它是判断「这个会话是不是已经长到需要压缩」的唯一线索。
 */
const snapshotKv = computed<KVItem[]>(() => {
  const s = snapshot.value;
  if (!s) return [];
  return [
    { label: '上下文消息', value: `${s.messages} 条`, mono: true },
    { label: '当前轮次', value: String(s.curIter), mono: true },
    { label: '权限模式', value: s.permissionMode || '（未记录）' },
    {
      label: '计划模式',
      value: s.planActive ? `进行中${s.planFile ? ` · ${s.planFile}` : ''}` : '未启用',
    },
    {
      label: '激活工具组',
      value: s.activatedToolGroups.length > 0 ? s.activatedToolGroups.join('、') : '无',
    },
    { label: '中断标记', value: s.shutdownInterrupted ? '上一次调用被中断' : '正常' },
    { label: '压缩摘要', value: s.summary || '压缩从未触发' },
  ];
});

const roleText: Record<string, string> = {
  USER: '用户',
  ASSISTANT: '助手',
  TOOL: '工具',
  SYSTEM: '系统',
};

const kindText: Record<string, string> = {
  text: '正文',
  thinking: '思考',
  tool_use: '调用',
  tool_result: '返回',
  mixed: '混合',
  unknown: '未知',
};

/*
 * 块类型 → 徽标配色。
 *
 * 借用的语义族：思考=等待（灰）、调用=外部（主色）、返回=托管（绿）、混合=驻场（琥珀）。
 * 视觉上要的是「四种类型一眼可分」，颜色本身没有额外含义。
 */
function kindVariant(kind: string): BadgeVariant {
  switch (kind) {
    case 'thinking':
      return 'wait';
    case 'tool_use':
      return 'external';
    case 'tool_result':
      return 'managed';
    case 'mixed':
      return 'hosted';
    default:
      return 'react';
  }
}

const backTo = computed(() => `/storage/${encodeURIComponent(props.table)}`);

const deleteMutation = useMutation({
  mutationFn: () => deleteStateSession(props.table, props.slotId),
  onSuccess: (result) => {
    /* 表清单要重算体积与会话数；会话列表按前缀失效，一次覆盖所有 table/keyword/page 组合。 */
    void queryClient.invalidateQueries({ queryKey: queryKeys.stateTables });
    void queryClient.invalidateQueries({ queryKey: ['state', 'sessions'] });
    notifySuccess(
      `已删除 ${result.deleted} 行状态`,
      '下一次对话会以全新上下文开始，不需要重启服务；调用链路不受影响。',
    );
    /*
     * 删完必须离开本页：这一页的地址指的就是那个已经不存在的 slotId，
     * 留在原地只会立刻重新取数、报一个「读不到这个会话」—— 看起来像删除失败。
     */
    void router.replace(backTo.value);
  },
  onError: (err) => notifyFailure(err, '删除失败'),
});

/*
 * 删除前的二次确认必须把「删的是什么、影响是什么」写清楚。
 * 只问一句「确认删除吗」的弹窗，用户会条件反射点确定 —— 而这里删掉的是 agent 的记忆。
 */
async function confirmDelete(): Promise<void> {
  const label = detail.value?.sessionId || props.slotId;
  const size = detail.value ? formatBytes(detail.value.totalBytes) : '';
  try {
    await ElMessageBox.confirm(
      `删除「${label}」的全部状态${size ? `（${size}）` : ''}？该会话的记忆会被清空，下一次对话从头开始；执行链路记录不受影响。`,
      '删除会话状态',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  deleteMutation.mutate();
}
</script>

<template>
  <PageHeader
    :title="`会话 ${detail?.sessionId || slotId}`"
  >
    <template #actions>
      <el-button :disabled="deleteMutation.isPending.value" @click="confirmDelete">删除该会话状态</el-button>
      <el-button @click="router.push(backTo)">← 返回会话清单</el-button>
    </template>
  </PageHeader>

  <div v-if="detailLoading" class="loading">加载中…</div>

  <PaneCard v-else-if="detailError" title="读不到这个会话">
    <EmptyState
      title="这个会话的状态读不出来"
      :hint="(detailError as Error).message"
    >
      <template #action>
        <el-button size="small" @click="router.push(backTo)">返回会话清单</el-button>
      </template>
    </EmptyState>
  </PaneCard>

  <div v-else class="stack">
    <PaneCard title="概况">
      <KVList class="mt2" :items="detailKv" label-width="112px" />
    </PaneCard>

    <PaneCard title="状态行" :right="`${slots.length} 行`">
      <el-table :data="slots" size="small">
        <el-table-column label="状态键" min-width="220">
          <template #default="{ row }"><span class="mono">{{ row.stateKey }}</span></template>
        </el-table-column>
        <el-table-column label="槽位" width="90" align="right">
          <template #default="{ row }"><span class="mono">{{ row.itemIndex }}</span></template>
        </el-table-column>
        <el-table-column label="大小" width="110" align="right">
          <template #default="{ row }"><span class="mono">{{ formatBytes(row.bytes) }}</span></template>
        </el-table-column>
        <el-table-column label="版本" width="90" align="right">
          <template #default="{ row }"><span class="mono">{{ row.version ?? '—' }}</span></template>
        </el-table-column>
        <el-table-column label="创建时间" min-width="200">
          <template #default="{ row }">
            <span class="mono">{{ row.createdAt ? formatDateTime(row.createdAt) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近写入" min-width="200">
          <template #default="{ row }">
            <span class="mono">{{ row.updatedAt ? formatDateTime(row.updatedAt) : '—' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </PaneCard>

    <PaneCard v-if="snapshot" title="上下文摘要">
      <KVList :items="snapshotKv" label-width="112px" />

      <template v-if="snapshot.tasksTotal > 0">
        <h4 class="sub">任务清单（{{ snapshot.tasksTotal }}）</h4>
        <el-table :data="snapshot.tasks" size="small">
          <el-table-column label="ID" width="90">
            <template #default="{ row }"><span class="mono">{{ row.id ?? '—' }}</span></template>
          </el-table-column>
          <el-table-column label="事项" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ row.subject ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }"><span class="mono">{{ row.state ?? '—' }}</span></template>
          </el-table-column>
          <el-table-column label="归属" width="130" show-overflow-tooltip>
            <template #default="{ row }"><span class="mono">{{ row.owner ?? '—' }}</span></template>
          </el-table-column>
        </el-table>
      </template>

      <h4 class="sub">
        消息预览（最后 {{ snapshot.preview.length }} 条 / 共 {{ snapshot.messages }} 条）
      </h4>
      <div class="msgs">
        <article v-for="(item, index) in snapshot.preview" :key="index" class="msg">
          <header class="msg__hd">
            <span class="strong">{{ roleText[item.role] ?? item.role }}</span>
            <AppBadge :variant="kindVariant(item.kind)">
              {{ kindText[item.kind] ?? item.kind }}
            </AppBadge>
            <span class="hint mono">{{ item.timestamp }}</span>
          </header>
          <p class="msg__tx">{{ item.text || '（空内容）' }}</p>
        </article>
      </div>
    </PaneCard>

    <PaneCard v-else-if="parseError" title="上下文摘要">
      <AppNote tone="warn">摘要读不出来：{{ parseError }}。会话本身还在，可以直接删除。</AppNote>
    </PaneCard>

    <PaneCard title="原始 state_data">
      <div v-if="rawLoading" class="loading">拉取中…</div>
      <AppNote v-else-if="rawError" tone="warn" class="mt">
        {{ (rawError as Error).message }}
      </AppNote>
      <JsonBlock v-else-if="rawText" class="mt" :content="rawText" />
      <div v-else class="mt">
        <el-button @click="rawWanted = true">读取原文</el-button>
      </div>
    </PaneCard>

  </div>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}
.mt2 {
  margin-top: var(--s3);
}
.sub {
  margin: var(--s4) 0 var(--s2);
  font-size: 13px;
  font-weight: 600;
  color: var(--t2);
}
.msgs {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}
.msg {
  padding: 10px 12px;
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  background: var(--panel-soft);
}
.msg__hd {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-bottom: 4px;
}
.msg__tx {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--t2);
  /* 预览段落可能很长：折行保留换行，但绝不撑出横向滚动条 */
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
