<script setup lang="ts">
/*
 * 模型治理页：卡片网格 + 编辑抽屉。
 *
 * 三件事必须在这一页讲清楚，否则会被当成"改完没生效"的 bug：
 *
 * 1. 「保存」不改变任何连接。连接是在装配期建的（DbModelFactory 按 model_ref 解析），
 *    改完端点必须<b>发布</b>才生效 —— 发布时会落快照，并重建所有引用它的 agent。
 *    这里不提供"保存即生效"的捷径：那会让"我改了个备注"和"我换了端点"变成同一个动作。
 *
 * 2. <b>没声明 model-ref 的 agent 用的是"默认模型"</b>。所以把某个模型设为默认
 *    （或者取消默认）本身就是一次影响面很大的操作 —— 页面上用徽标把当前默认模型标出来，
 *    并在发布时提示重建范围。
 *
 * 3. 「连通性测试」打的是<b>库里那份</b>、不是表单里未保存的改动。所以点它之前会先保存
 *    当前草稿（顺序反过来的话，用户会对着一个"看起来通"的旧配置下结论）。
 *
 * 另：model-key 是 agent 的 model-ref 引用的值，改一次等于所有引用它的 agent 集体失效，
 * 所以它在编辑态是冻结的（要换 key 就新建一个）。
 */
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  createModel,
  deleteModel,
  getModel,
  listAgents,
  listModels,
  modelDefaults,
  modelVersions,
  publishModel,
  rollbackModel,
  saveModel,
  testModelConnection,
} from '@/api/controlplane';
import type { ConnectionTest, ModelEntity, ModelRow } from '@/api/controlplane/types';
import { notifyFailure, notifyPublish, notifySuccess } from '@/features/controlplane/feedback';
import { ApiError } from '@/lib/apiClient';
import { agentDisplayName } from '@/lib/agentDisplay';
import { queryKeys } from '@/lib/queryKeys';
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import FilterChips from '@/components/ui/FilterChips.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppCard from '@/components/ui/AppCard.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import KVList from '@/components/ui/KVList.vue';
import VersionsPanel from '@/components/controlplane/VersionsPanel.vue';

const queryClient = useQueryClient();

const { data: models, isLoading, error } = useQuery({
  queryKey: queryKeys.models,
  queryFn: listModels,
});
const { data: defaults } = useQuery({ queryKey: queryKeys.modelDefaults, queryFn: modelDefaults });
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

/** agent 标识 → 展示名：引用方清单里给人看的该是名字，不是注册键。 */
const displayNameOf = computed(() => agentDisplayName(agents.value));

const list = computed(() => models.value ?? []);

// ==================== 筛选 ====================

const stateChip = ref('all');
const defaultOpen = ref(false);
const keyword = ref('');
const purposeFilter = ref('');
const statusFilter = ref('');

/** 用途下拉的候选来自现有数据：它是分组标签，不是受管资源，所以允许在编辑框里新建。 */
const purposes = computed(() =>
  [...new Set(list.value.map((row) => row.purpose).filter(Boolean) as string[])].sort(),
);

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  { key: 'on', label: '启用', count: list.value.filter((r) => r.enabled).length },
  { key: 'off', label: '已停用', count: list.value.filter((r) => !r.enabled).length },
  { key: 'default', label: '默认模型', count: list.value.filter((r) => r.isDefault).length },
]);

const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return list.value.filter((row) => {
    if (stateChip.value === 'on' && !row.enabled) return false;
    if (stateChip.value === 'off' && row.enabled) return false;
    if (stateChip.value === 'default' && !row.isDefault) return false;
    if (purposeFilter.value && row.purpose !== purposeFilter.value) return false;
    if (statusFilter.value && row.status !== statusFilter.value) return false;
    if (!lower) return true;
    // 展示名、model-key、模型名、端点都参与检索：前两个是页面上看得到的名字，
    // 后两个是排查"连错端点"时手里唯一的线索。
    return `${row.displayName} ${row.modelKey} ${row.modelName ?? ''} ${row.baseUrl ?? ''} ${row.provider ?? ''}`
      .toLowerCase()
      .includes(lower);
  });
});

const isFiltered = computed(
  () =>
    Boolean(keyword.value || purposeFilter.value || statusFilter.value) || stateChip.value !== 'all',
);

function reset() {
  stateChip.value = 'all';
  keyword.value = '';
  purposeFilter.value = '';
  statusFilter.value = '';
}

// ==================== 编辑抽屉 ====================

const drawerOpen = ref(false);
const creating = ref(false);
/** 正在编辑的 model-key；空串 = 新建（此时不发详情请求）。 */
const selectedKey = ref('');
const changeNote = ref('');
const draft = ref<ModelEntity | null>(null);
/** 上一次连通性探测的结果；每次打开抽屉清空，避免看的是别的模型的结论。 */
const testResult = ref<ConnectionTest | null>(null);
const testing = ref(false);

/*
 * 详情查询（含明文密钥）。
 *
 * 只在"要编辑某个已存在的模型"时有意义，所以用 selectedKey 是否为空来开关 ——
 * 而不是用抽屉开合：新建时抽屉开着但没有 key 可查，查了也是 404。
 *
 * 注意这里不靠 watch(data) 去填草稿：详情可能早已在缓存里（第二次打开同一个模型），
 * 那时 data 不会变化，watch 永远不触发，抽屉就空着。所以由 openEdit 主动 await refetch 后填。
 */
const detailQuery = useQuery({
  queryKey: computed(() => queryKeys.model(selectedKey.value)),
  queryFn: () => getModel(selectedKey.value),
  enabled: computed(() => selectedKey.value !== ''),
});

const {
  data: versions,
  isLoading: versionsLoading,
  refetch: refetchVersions,
} = useQuery({
  queryKey: computed(() => queryKeys.resourceVersions('model', selectedKey.value)),
  queryFn: () => modelVersions(selectedKey.value),
  enabled: computed(() => selectedKey.value !== ''),
});

function blankModel(): ModelEntity {
  return {
    modelKey: '',
    displayName: '',
    purpose: '',
    provider: '',
    baseUrl: '',
    apiKey: '',
    modelName: '',
    endpointPath: '',
    // 默认给 default：它是"不下发厂商特化的回填格式"，绝大多数模型都用它。
    formatter: 'default',
    reasoningEffort: '',
    // 五个生成参数一律留空 = 不下发。不要填 0：0 是一个真实存在的采样策略（贪心）。
    temperature: null,
    topP: null,
    maxTokens: null,
    contextWindowSize: null,
    description: '',
    bizTags: [],
    isDefault: false,
    enabled: true,
    status: 'DRAFT',
    version: null,
    publishedVersion: null,
    publishedAtMs: null,
    createdAtMs: null,
    updatedAtMs: null,
    createdBy: null,
    updatedBy: null,
  };
}

function openCreate() {
  creating.value = true;
  selectedKey.value = '';
  changeNote.value = '';
  testResult.value = null;
  draft.value = blankModel();
  drawerOpen.value = true;
}

function openEdit(row: ModelRow) {
  creating.value = false;
  selectedKey.value = row.modelKey;
  changeNote.value = '';
  testResult.value = null;
  // 先用列表里那份顶上，抽屉立刻有内容。注意列表的密钥是打码的，所以它只是占位，
  // 真值由 fillFromDetail 覆盖 —— 用户在这几百毫秒内不会去编辑密钥那一格。
  draft.value = {
    modelKey: row.modelKey,
    displayName: row.displayName,
    purpose: row.purpose ?? '',
    provider: row.provider ?? '',
    baseUrl: row.baseUrl ?? '',
    apiKey: row.apiKeyMask,
    modelName: row.modelName ?? '',
    endpointPath: row.endpointPath ?? '',
    formatter: row.formatter ?? 'default',
    reasoningEffort: row.reasoningEffort ?? '',
    temperature: row.temperature,
    topP: row.topP,
    maxTokens: row.maxTokens,
    contextWindowSize: row.contextWindowSize,
    description: row.description ?? '',
    bizTags: row.bizTags ? [...row.bizTags] : [],
    isDefault: row.isDefault,
    enabled: row.enabled,
    status: row.status,
    version: row.version,
    publishedVersion: row.publishedVersion,
    publishedAtMs: row.publishedAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
  drawerOpen.value = true;
  void fillFromDetail();
}

/**
 * 取详情（明文密钥）并覆盖草稿。
 *
 * <p>显式 refetch 而不是等 watch：详情可能已在缓存里，那时 data 不会变化。
 * 取回前先记住 key，取回后比对一次 —— 用户可能在请求飞行期间就切到了另一个模型，
 * 那时把旧响应写进草稿会让"编辑 A 却看到 B 的密钥"。
 */
async function fillFromDetail() {
  const key = selectedKey.value;
  const result = await detailQuery.refetch();
  if (creating.value || selectedKey.value !== key || !result.data) return;
  const model = result.data.model;
  draft.value = {
    ...model,
    purpose: model.purpose ?? '',
    provider: model.provider ?? '',
    endpointPath: model.endpointPath ?? '',
    formatter: model.formatter ?? 'default',
    reasoningEffort: model.reasoningEffort ?? '',
    description: model.description ?? '',
    bizTags: model.bizTags ? [...model.bizTags] : [],
  };
}

/** 必填项与后端 validate 同一套规则：model-key / 展示名 / 端点 / 密钥 / 模型名。 */
const canSave = computed(() => {
  const row = draft.value;
  if (!row) return false;
  return (
    Boolean(row.modelKey.trim()) &&
    Boolean(row.displayName.trim()) &&
    row.baseUrl.trim().startsWith('http') &&
    Boolean(row.apiKey.trim()) &&
    Boolean(row.modelName.trim())
  );
});

// ==================== 写操作 ====================

/** 空串与 null 是两件事：这里的可空文本列统一按 null 提交，避免库里出现一堆 ''。 */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function payload(): ModelEntity {
  const row = draft.value!;
  return {
    ...row,
    modelKey: row.modelKey.trim(),
    displayName: row.displayName.trim(),
    baseUrl: row.baseUrl.trim(),
    apiKey: row.apiKey.trim(),
    modelName: row.modelName.trim(),
    purpose: blankToNull(row.purpose),
    provider: blankToNull(row.provider),
    endpointPath: blankToNull(row.endpointPath),
    formatter: blankToNull(row.formatter),
    reasoningEffort: blankToNull(row.reasoningEffort),
    description: blankToNull(row.description),
    bizTags: row.bizTags?.length ? row.bizTags : null,
  };
}

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: queryKeys.models });
  void queryClient.invalidateQueries({ queryKey: ['versions'] });
  // 改了默认模型会影响概览上的模型卡与「需要关注」，顺手让它重取。
  void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
}

const saveMutation = useMutation({
  mutationFn: async () => {
    const body = payload();
    return creating.value ? createModel(body) : saveModel(body.modelKey, body);
  },
  onSuccess: (saved) => {
    creating.value = false;
    selectedKey.value = saved.modelKey;
    invalidate();
    // 把列表里那份打码值换成刚提交的真值：否则用户接着点"发布"会以为密钥还是星号。
    if (draft.value) draft.value.apiKey = saved.apiKey;
    notifySuccess('已保存为草稿');
  },
  onError: (err) => notifyFailure(err, '保存失败'),
});

const publishMutation = useMutation({
  mutationFn: async () => {
    const saved = await saveMutation.mutateAsync();
    return publishModel(saved.modelKey, changeNote.value || undefined);
  },
  onSuccess: (result) => {
    changeNote.value = '';
    invalidate();
    void refetchVersions();
    notifyPublish(result);
  },
  onError: (err) => notifyFailure(err, '发布失败'),
});

const deleteMutation = useMutation({
  mutationFn: (key: string) => deleteModel(key),
  onSuccess: () => {
    drawerOpen.value = false;
    invalidate();
    notifySuccess('已删除');
  },
  onError: (err) => notifyFailure(err, '删除失败'),
});

const rollbackMutation = useMutation({
  mutationFn: (version: number) => rollbackModel(selectedKey.value, version),
  onSuccess: async (_result, version) => {
    invalidate();
    // 回滚改的是库里的内容（连默认标记的取值规则都单独处理过），所以要重取详情覆盖草稿 ——
    // 否则表单里留着回滚前的值，用户会以为「回滚没生效」。
    await fillFromDetail();
    await refetchVersions();
    notifySuccess(
      `已回滚到 v${version}`,
      '回滚只写库、不热装配，也不会改动默认模型的标记 —— 要让线上生效还需要再发布一次。',
    );
  },
  onError: (err) => notifyFailure(err, '回滚失败'),
});

/**
 * 连通性探测：先保存，再打。
 *
 * <p>顺序不能反：后端探测读的是库里那份配置，表单里未保存的改动对它不可见。
 * 先保存的话，用户看到的结论就一定对应他刚刚填的那份。
 */
async function runConnectionTest() {
  testing.value = true;
  testResult.value = null;
  try {
    const saved = await saveMutation.mutateAsync();
    testResult.value = await testModelConnection(saved.modelKey);
  } catch (err) {
    notifyFailure(err, '连通性测试失败');
  } finally {
    testing.value = false;
  }
}

const busy = computed(
  () =>
    saveMutation.isPending.value ||
    publishMutation.isPending.value ||
    deleteMutation.isPending.value ||
    rollbackMutation.isPending.value ||
    testing.value,
);

/** 引用它的 agent：详情里有权威清单，没取到时退回列表里的计数。 */
const usedByAgents = computed(() => detailQuery.data.value?.usedByAgents ?? []);

async function confirmDelete() {
  const key = draft.value?.modelKey;
  if (!key) return;
  // 引用方非空时直接给出可执行的一步（先去哪个 agent 上解绑），而不是等后端回 409。
  if (usedByAgents.value.length > 0) {
    notifyFailure(
      new ApiError(`被 ${usedByAgents.value.length} 个 agent 引用，先改掉它们的 model-ref`, 409, {
        referencingAgents: usedByAgents.value,
      }),
      '不能删除',
    );
    return;
  }
  try {
    await ElMessageBox.confirm(
      `删除「${key}」后不可恢复，版本快照也会一并消失。引用它的 agent 下次装配会失败。`,
      '删除模型',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  deleteMutation.mutate(key);
}

async function confirmRollback(version: number) {
  try {
    await ElMessageBox.confirm(
      `把连接配置回滚到 v${version}？会生成一个新版本，线上实例要再发布一次才会变。`,
      '回滚版本',
      { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  rollbackMutation.mutate(version);
}

watch(drawerOpen, (open) => {
  if (!open) {
    creating.value = false;
    selectedKey.value = '';
    changeNote.value = '';
    draft.value = null;
    testResult.value = null;
  }
});

/** 「调用参数默认值」卡：后端已把每一行的口径写成人话，这里只负责排版。 */
const defaultItems = computed(() =>
  (defaults.value?.items ?? []).map((item) => ({
    label: item.label,
    value: item.value,
    note: item.note ?? undefined,
    mono: true,
  })),
);
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button @click="defaultOpen = true">默认参数</el-button>
      <el-button :disabled="busy" @click="invalidate">刷新</el-button>
      <el-button type="primary" @click="openCreate">+ 接入模型</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: visible.length, total: list.length, noun: '个模型' }">
    <template #chips>
      <FilterChips v-model="stateChip" :items="chips" />
    </template>
    <FilterField label="关键字" width="260px">
      <el-input v-model="keyword" placeholder="展示名 / model-key / 模型名 / 端点" clearable />
    </FilterField>
    <FilterField label="用途" width="180px">
      <el-select v-model="purposeFilter" placeholder="全部用途" clearable>
        <el-option v-for="item in purposes" :key="item" :label="item" :value="item" />
      </el-select>
    </FilterField>
    <FilterField label="状态" width="150px">
      <el-select v-model="statusFilter" placeholder="全部状态" clearable>
        <el-option label="草稿" value="DRAFT" />
        <el-option label="已发布" value="PUBLISHED" />
      </el-select>
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="loading">加载中…</div>
  <AppCard v-else-if="error">
    <EmptyState title="读不到模型清单" :hint="(error as Error).message" />
  </AppCard>
  <EmptyState
    v-else-if="visible.length === 0"
    :title="list.length === 0 ? '库里还没有模型' : '没有符合条件的模型'"
  >
    <template #action>
      <el-button v-if="list.length === 0" type="primary" @click="openCreate">+ 接入模型</el-button>
      <el-button v-else :disabled="!isFiltered" @click="reset">重置筛选</el-button>
    </template>
  </EmptyState>

  <div v-else class="grid-cards">
    <AppCard
      v-for="row in visible"
      :key="row.modelKey"
      :title="row.displayName"
      :description="row.description || undefined"
      clickable
      @click="openEdit(row)"
    >
      <template #badge>
        <!-- 默认模型排在最前：它决定"没声明 model-ref 的 agent 用哪个模型"，比状态更重要 -->
        <AppBadge v-if="row.isDefault" variant="managed">默认</AppBadge>
        <AppBadge v-else-if="!row.enabled" variant="off">已停用</AppBadge>
        <AppBadge v-else-if="row.status === 'PUBLISHED'" variant="ok">已发布</AppBadge>
        <AppBadge v-else variant="wait">草稿</AppBadge>
      </template>
      <template #tags>
        <!-- model-key 降为次要索引：agent 的 model-ref 引用它时填的是这个值 -->
        <span class="tag-chip mono" :title="row.modelKey">{{ row.modelKey }}</span>
        <span v-for="tag in row.bizTags ?? []" :key="tag" class="tag-chip">{{ tag }}</span>
      </template>
    </AppCard>
  </div>

  <el-dialog v-model="defaultOpen" title="调用参数默认值" width="720px">
    <KVList v-if="defaultItems.length > 0" label-width="132px" :items="defaultItems" />
    <div v-else class="hint">读不到默认值。</div>
  </el-dialog>

  <el-drawer v-model="drawerOpen" size="820px" :with-header="false" destroy-on-close>
    <div v-if="draft" class="dw">
      <header class="dw__hd">
        <div class="dw__ttl">
          <span class="strong">{{ creating ? '接入模型' : draft.displayName || draft.modelKey }}</span>
          <AppBadge v-if="!creating && draft.isDefault" variant="managed">默认</AppBadge>
          <AppBadge v-if="!creating" :variant="draft.enabled ? 'ok' : 'off'">
            {{ draft.enabled ? '启用' : '已停用' }}
          </AppBadge>
        </div>
        <div class="row">
          <el-button :loading="busy" :disabled="!canSave" @click="runConnectionTest">
            测试连通性
          </el-button>
          <el-button :loading="busy" :disabled="!canSave" @click="saveMutation.mutate()">
            保存草稿
          </el-button>
          <el-button
            type="primary"
            :loading="busy"
            :disabled="!canSave"
            @click="publishMutation.mutate()"
          >
            发布
          </el-button>
          <el-dropdown
            v-if="!creating"
            trigger="click"
            popper-class="agent-more-menu"
            @command="confirmDelete"
          >
            <el-button :disabled="busy">
              更多
              <el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="delete" class="is-danger">删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <div class="dw__bd">
        <AppNote v-if="!canSave" tone="warn" class="mb">
          必填项还没填完：model-key / 展示名 / 端点（须以 http 开头）/ 密钥 / 模型名。
        </AppNote>

        <el-form label-position="top">
          <div class="form-2col">
            <el-form-item label="model-key">
              <el-input
                v-model="draft.modelKey"
                :disabled="!creating"
                class="mono"
                placeholder="例如 ds-flash"
              />
            </el-form-item>
            <el-form-item label="展示名">
              <el-input v-model="draft.displayName" placeholder="例如 DeepSeek V4 Flash" />
            </el-form-item>
          </div>

          <div class="form-2col">
            <el-form-item label="用途">
              <el-select
                v-model="draft.purpose"
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                placeholder="对话 / 记忆归并 / 向量化…"
                style="width: 100%"
              >
                <el-option v-for="item in purposes" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item label="厂商">
              <el-select
                v-model="draft.provider"
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                placeholder="deepseek / ark / openai…"
                style="width: 100%"
              >
                <el-option
                  v-for="item in [...new Set(list.map((row) => row.provider).filter(Boolean) as string[])]"
                  :key="item"
                  :label="item"
                  :value="item"
                />
              </el-select>
            </el-form-item>
          </div>
        </el-form>

        <div class="sec">
          <div class="sec__hd"><h3>连接</h3></div>
          <el-form label-position="top">
            <el-form-item label="端点（base-url）">
              <el-input v-model="draft.baseUrl" class="mono" placeholder="https://api.deepseek.com" />
            </el-form-item>
            <div class="form-2col">
              <el-form-item label="密钥（api-key）">
                <el-input
                  v-model="draft.apiKey"
                  type="password"
                  show-password
                  class="mono"
                  placeholder="sk-…"
                />
              </el-form-item>
              <el-form-item label="模型名（model-name）">
                <el-input v-model="draft.modelName" class="mono" placeholder="deepseek-v4-flash" />
              </el-form-item>
            </div>
            <el-form-item label="补全路径（endpoint-path）">
              <el-input
                v-model="draft.endpointPath"
                class="mono"
                placeholder="/v1/chat/completions"
              />
            </el-form-item>
          </el-form>

          <div v-if="testResult" class="mt">
            <AppNote :tone="testResult.ok ? 'default' : 'warn'">
              <b>{{ testResult.ok ? '连通' : '不通' }}</b>
              <span class="mono"> {{ testResult.detail }}</span>
            </AppNote>
          </div>
        </div>

        <div class="sec">
          <div class="sec__hd"><h3>生成参数</h3></div>
          <el-form label-position="top">
            <div class="form-2col">
              <el-form-item label="回填格式化器（formatter）">
                <el-select v-model="draft.formatter" style="width: 100%">
                  <el-option label="default（标准 OpenAI 兼容）" value="default" />
                  <el-option label="deepseek-reasoning（回传 reasoning_content）" value="deepseek-reasoning" />
                </el-select>
              </el-form-item>
              <el-form-item label="思考强度（reasoning-effort）">
                <el-select v-model="draft.reasoningEffort" placeholder="未设置" clearable style="width: 100%">
                  <el-option label="low" value="low" />
                  <el-option label="medium" value="medium" />
                  <el-option label="high" value="high" />
                </el-select>
              </el-form-item>
            </div>

            <div class="form-2col">
              <el-form-item label="temperature">
                <el-input-number
                  v-model="draft.temperature"
                  :min="0"
                  :max="2"
                  :step="0.1"
                  :precision="2"
                  :value-on-clear="null"
                  placeholder="未设置"
                  style="width: 100%"
                />
              </el-form-item>
              <el-form-item label="top-p">
                <el-input-number
                  v-model="draft.topP"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  :precision="2"
                  :value-on-clear="null"
                  placeholder="未设置"
                  style="width: 100%"
                />
              </el-form-item>
            </div>

            <div class="form-2col">
              <el-form-item label="max-tokens">
                <el-input-number
                  v-model="draft.maxTokens"
                  :min="1"
                  :step="1024"
                  :value-on-clear="null"
                  placeholder="未设置"
                  style="width: 100%"
                />
              </el-form-item>
              <el-form-item label="context-window-size">
                <el-input-number
                  v-model="draft.contextWindowSize"
                  :min="1"
                  :step="4096"
                  :value-on-clear="null"
                  placeholder="未设置"
                  style="width: 100%"
                />
              </el-form-item>
            </div>
          </el-form>

        </div>

        <div class="sec">
          <div class="sec__hd"><h3>状态与备注</h3></div>
          <el-form label-position="top">
            <div class="form-2col">
              <el-form-item label="默认模型">
                <el-switch v-model="draft.isDefault" active-text="是" inactive-text="否" />
              </el-form-item>
              <el-form-item label="启用">
                <el-switch v-model="draft.enabled" active-text="启用" inactive-text="停用" />
              </el-form-item>
            </div>
            <el-form-item label="备注">
              <el-input v-model="draft.description" placeholder="这个模型用在哪" />
            </el-form-item>
            <el-form-item label="业务标签">
              <el-select
                v-model="draft.bizTags"
                multiple
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                placeholder="回车创建一个标签"
                style="width: 100%"
              >
                <el-option v-for="tag in draft.bizTags ?? []" :key="tag" :label="tag" :value="tag" />
              </el-select>
            </el-form-item>
          </el-form>
        </div>

        <div v-if="usedByAgents.length > 0" class="sec">
          <div class="sec__hd"><h3>引用它的 Agent</h3></div>
          <div class="row wrap">
            <span v-for="item in usedByAgents" :key="item" class="tag-chip" :title="item">
              {{ displayNameOf(item) }}
            </span>
          </div>
        </div>

        <div v-if="!creating" class="sec">
          <div class="sec__hd"><h3>版本历史</h3></div>
          <el-input v-model="changeNote" placeholder="变更说明" class="mb" />
          <VersionsPanel
            :versions="versions ?? []"
            :loading="versionsLoading"
            :published-version="draft.publishedVersion"
            @rollback="confirmRollback"
          />
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
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
  gap: var(--s2);
  min-width: 0;
  margin-right: auto;
}
.dw__bd {
  flex: 1;
  min-height: 0;
  padding-top: var(--s4);
  overflow: auto;
}
.form-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 var(--s4);
}
.sec {
  padding-top: var(--s4);
  margin-top: var(--s4);
  border-top: 1px solid var(--bd-soft);
}
.sec__hd {
  display: flex;
  align-items: baseline;
  gap: var(--s3);
  margin-bottom: var(--s3);
}
.sec__hd h3 {
  margin: 0;
}
</style>
