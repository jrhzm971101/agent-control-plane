<script setup lang="ts">
/*
 * 工作流清单页。
 *
 * <h2>一、这一页只管"有哪些工作流"，不管图怎么画</h2>
 * 图的编辑、校验、发布、运行都在 WorkflowDesignerPage（/workflows/:key）里。
 * 分开的理由与 AgentsPage / AgentDetailPage 一致：清单页的注意力单位是
 * "有几条、各自什么状态、最近改没改"，而设计器的注意力单位是"这张图哪里不通"。
 * 混在一页里，画布要么被挤得很小，要么把清单顶到看不见的地方。
 *
 * <h2>二、为什么不显示 workflow-key 作为主列</h2>
 * 与项目里其余受治理资源同一口径：key 是业务键（出现在表达式、引用、URL 与日志里），
 * 展示一律用 displayName。key 只在副标题里以等宽字体带一眼 —— 排查时要对着日志找它。
 */
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  workflowVersions,
} from '@/api/controlplane';
import type { WorkflowRow } from '@/api/controlplane/types';
import { notifyFailure, notifySuccess } from '@/features/controlplane/feedback';
import {
  WORKFLOW_STAGE_TEXT,
  WORKFLOW_STAGE_TONE,
  workflowRunBlockedReason,
  workflowStageOf,
  type WorkflowStage,
} from '@/features/controlplane/workflowStage';
import { queryKeys } from '@/lib/queryKeys';
import { formatRelative } from '@/lib/format';
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import FilterChips from '@/components/ui/FilterChips.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';

const router = useRouter();
const queryClient = useQueryClient();

const { data: workflows, isLoading, error } = useQuery({
  queryKey: queryKeys.workflows,
  queryFn: listWorkflows,
});

const list = computed(() => workflows.value ?? []);

// ==================== 状态口径 ====================
//
// 三态的判定与文案收在 features/controlplane/workflowStage.ts —— 设计器页要上同一枚
// 徽标，两份映射必然漂移。这里只做改名别名，好让下面的模板读起来仍是本地词。
const stageOf = workflowStageOf;
const STAGE_TEXT = WORKFLOW_STAGE_TEXT;
const STAGE_TONE = WORKFLOW_STAGE_TONE;
type Stage = WorkflowStage;

const countByStage = (stage: Stage) => list.value.filter((row) => stageOf(row) === stage).length;

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  { key: 'PUBLISHED', label: '已发布', count: countByStage('PUBLISHED') },
  { key: 'CHANGED', label: '有改动待发布', count: countByStage('CHANGED') },
  { key: 'NEVER', label: '未发布过', count: countByStage('NEVER') },
]);

const stageChip = ref('all');
const keyword = ref('');

/** 是否已经画过东西：0 个节点的工作流点了「运行」不会被拦（后端有版本），但页面上要提醒。 */
const isEmptyGraph = (row: WorkflowRow) => row.nodeCount === 0;

const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return list.value.filter((row) => {
    if (stageChip.value !== 'all' && stageOf(row) !== stageChip.value) return false;
    if (!lower) return true;
    // 展示名与 key 都参与检索：一个是页面上看到的，一个是日志里出现的
    return `${row.displayName} ${row.workflowKey} ${row.description ?? ''}`
      .toLowerCase()
      .includes(lower);
  });
});

const isFiltered = computed(() => Boolean(keyword.value || stageChip.value !== 'all'));

function reset() {
  stageChip.value = 'all';
  keyword.value = '';
}

// ==================== 新建 ====================

const creating = ref(false);
const busy = ref(false);
const draft = reactive({ workflowKey: '', displayName: '', description: '' });

/*
 * key 的格式校验放在前端做一次，与后端发布时的校验同一套规则：
 * key 会被写进表达式（node.<key>.text），含连字符就引用不到。早一点拦住，
 * 比等到发布时才报"key 不合法"体验好得多。
 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const keyProblem = computed(() => {
  const value = draft.workflowKey.trim();
  if (!value) return '请填写 workflow-key';
  if (!KEY_PATTERN.test(value)) return '只能由字母、数字、下划线组成，且不能以数字开头';
  if (list.value.some((row) => row.workflowKey === value)) return '这个 key 已经被占用了';
  return '';
});

const canCreate = computed(
  () => !keyProblem.value && draft.displayName.trim().length > 0 && !busy.value,
);

function openCreate() {
  draft.workflowKey = '';
  draft.displayName = '';
  draft.description = '';
  creating.value = true;
}

const createMutation = useMutation({
  mutationFn: () =>
    createWorkflow({
      workflowKey: draft.workflowKey.trim(),
      displayName: draft.displayName.trim(),
      description: draft.description.trim() || null,
      spec: { nodes: [], edges: [] },
    }),
  onSuccess: async (created) => {
    notifySuccess('已创建工作流');
    creating.value = false;
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
    await router.push(`/workflows/${encodeURIComponent(created.workflowKey)}`);
  },
  onError: (e) => notifyFailure(e, '创建工作流失败'),
});

// ==================== 删除 ====================

const deleteMutation = useMutation({
  mutationFn: (workflowKey: string) => deleteWorkflow(workflowKey),
  onSuccess: async () => {
    notifySuccess('已删除工作流');
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
  },
  onError: (e) => notifyFailure(e, '删除失败'),
});

async function confirmDelete(row: WorkflowRow) {
  /*
   * 删之前先看一眼有没有已发布的版本。有的话要说清"线上会失去这个可执行的流程"，
   * 而"这个 key 还会被引用吗"这个问题不用问 —— 工作流是引用方，没有别的东西引用它。
   */
  let publishedNote = '';
  try {
    const versions = await workflowVersions(row.workflowKey);
    if (versions.length > 0) {
      publishedNote = `它有过 ${versions.length} 个版本快照，删除后这些快照会一起消失（历史运行记录会保留）。`;
    }
  } catch {
    // 版本列表读失败不该挡住删除：这只是提示文案，不是删除的前提条件
    publishedNote = '';
  }

  try {
    await ElMessageBox.confirm(
      `确定删除「${row.displayName}」吗？${publishedNote}`,
      '删除工作流',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  deleteMutation.mutate(row.workflowKey);
}

function openDesigner(row: WorkflowRow) {
  router.push(`/workflows/${encodeURIComponent(row.workflowKey)}`);
}

/**
 * 从清单页去运行：把人送到设计器的运行记录 tab，并让那边把对话框弹开。
 *
 * <p>为什么这里不直接发一次 POST、也不在本页摆一套输入框：
 * <ul>
 *   <li>接口需要一个输入 JSON，替用户决定用空对象跑，是在他不知道的情况下替他做了选择；</li>
 *   <li>在本页再实现一遍输入框与提交，就等于把"运行"实现两遍 —— 两份实现漂移的表现是
 *       "清单页跑出来的结果和设计器里跑出来的不一样"，属于最难查的一类问题。</li>
 * </ul>
 * 所以这里只负责带路，真正的运行 UI 只有设计器那一处（见 WorkflowDesignerPage 的 pendingRun）。
 */
function openRun(row: WorkflowRow) {
  router.push({
    path: `/workflows/${encodeURIComponent(row.workflowKey)}`,
    query: { tab: 'runs', run: '1' },
  });
}

/*
 * 能不能运行由 features/controlplane/workflowStage.ts 统一判定，与设计器共用同一份 ——
 * 各写一遍必然出现"清单页亮着、点进去设计器灰着"这种没法解释的不一致。
 * 这一页没有本地草稿，所以只传 publishedVersion。
 */
const runBlockedReasonOf = (row: WorkflowRow) =>
  workflowRunBlockedReason({ publishedVersion: row.publishedVersion });
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button type="primary" @click="openCreate">+ 新建工作流</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: visible.length, total: list.length, noun: '个工作流' }">
    <template #chips>
      <FilterChips v-model="stageChip" :items="chips" />
    </template>
    <FilterField label="关键字" width="260px">
      <el-input v-model="keyword" placeholder="名称 / workflow-key / 描述" clearable />
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <el-alert
    v-if="error"
    type="error"
    :closable="false"
    show-icon
    title="工作流清单加载失败"
    :description="(error as Error).message"
  />

  <TableCard
    v-else
    :loading="isLoading"
  >
    <EmptyState
      v-if="visible.length === 0"
      title="还没有工作流"
    />
    <el-table
      v-else
      :data="visible"
      row-key="workflowKey"
      highlight-current-row
      @row-click="openDesigner"
    >
      <el-table-column label="工作流" min-width="240">
        <template #default="{ row }">
          <div class="cell-main">{{ row.displayName }}</div>
          <div class="cell-sub mono">{{ row.workflowKey }}</div>
        </template>
      </el-table-column>
      <el-table-column label="说明" min-width="300" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ muted: !row.description }">{{ row.description?.trim() || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" min-width="124">
        <template #default="{ row }">
          <AppBadge :variant="STAGE_TONE[stageOf(row)]">{{ STAGE_TEXT[stageOf(row)] }}</AppBadge>
          <div v-if="isEmptyGraph(row)" class="cell-sub">空图</div>
        </template>
      </el-table-column>
      <el-table-column label="节点 / 连线" min-width="110" align="right">
        <template #default="{ row }">
          <span class="mono">{{ row.nodeCount }} / {{ row.edgeCount }}</span>
        </template>
      </el-table-column>
      <el-table-column label="版本" min-width="90" align="right">
        <template #default="{ row }">
          <span class="mono">{{ row.version === null ? '—' : `v${row.version}` }}</span>
        </template>
      </el-table-column>
      <el-table-column label="最近改动" min-width="110">
        <template #default="{ row }">
          <span class="muted">{{ formatRelative(row.updatedAtMs) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" align="right">
        <template #default="{ row }">
          <!--
            「运行」放在清单页而不是只放在设计器里：这一页才是进工作流模块第一眼看到的地方，
            只在设计器给入口的结果是"我建好了工作流，但找不到运行的地方"（实测反馈）。
            tooltip 外面包一层 span：button 一旦 disabled 就不再派发 mouseenter，
            不包的话鼠标移上去什么都不弹，等于没有解释。
          -->
          <el-tooltip
            :disabled="runBlockedReasonOf(row) === ''"
            :content="runBlockedReasonOf(row)"
            placement="bottom"
          >
            <span>
              <el-button
                size="small"
                type="primary"
                :disabled="runBlockedReasonOf(row) !== ''"
                @click.stop="openRun(row)"
              >
                运行
              </el-button>
            </span>
          </el-tooltip>
          <el-button size="small" @click.stop="openDesigner(row)">设计</el-button>
          <el-button
            size="small"
            type="danger"
            plain
            :loading="deleteMutation.isPending.value"
            @click.stop="confirmDelete(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </TableCard>

  <el-drawer v-model="creating" title="新建工作流" size="480px">
    <el-form label-position="top">
      <el-form-item label="workflow-key">
        <el-input
          v-model="draft.workflowKey"
          class="mono"
          placeholder="例如 timesheet_audit"
          @input="draft.workflowKey = draft.workflowKey.trim().replace(/\s+/g, '_')"
        />
        <!-- 空着的时候只说「怎么填」，不预先报红：刚打开抽屉就飘一条错误提示是噪声 -->
        <div v-if="draft.workflowKey.trim() && keyProblem" class="hint warn mt">{{ keyProblem }}</div>
      </el-form-item>

      <el-form-item label="展示名">
        <el-input v-model="draft.displayName" placeholder="例如 月度工时填报核对" />
      </el-form-item>

      <el-form-item label="说明">
        <el-input
          v-model="draft.description"
          type="textarea"
          :rows="3"
          placeholder="请输入说明"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="creating = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!canCreate"
        :loading="busy || createMutation.isPending.value"
        @click="createMutation.mutate()"
      >
        创建并进入设计器
      </el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.cell-main {
  font-weight: 550;
  color: var(--t1);
}
.cell-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--t3);
}
.hint.warn {
  color: var(--err, #c45656);
}
</style>
