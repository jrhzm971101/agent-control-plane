<script setup lang="ts">
/*
 * Prompt 治理页：卡片网格 + 编辑抽屉。
 *
 * 为什么是卡片而不是表格：这一页的注意力单位是「一条 prompt 的正文，以及它被谁用」，
 * 不是「多列数值的横向比较」。卡片能把 key、状态、版本、引用方、描述挤进一屏，
 * 而正文 —— 这一页真正要看的东西 —— 点开就进抽屉。
 *
 * 生命周期三层职责必须分清（页面上也据此给按钮）：
 *   保存 = 只落库（草稿），agent 行为不变；
 *   发布 = 把库里的内容装配进实例，并写一份版本快照；
 *   回滚 = 把某一版快照写回库，但不动实例 —— 要生效得再发布一次。
 *
 * 「被谁引用」是本地算的：agent 列表接口已经把每个 agent 的 prompt-key 带回来了，
 * 一次 O(agents) 遍历生成反向表，避免按卡片逐条回查后端。
 */
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  createPrompt,
  deletePrompt,
  listAgents,
  listPrompts,
  promptVersions,
  publishPrompt,
  rollbackPrompt,
  savePrompt,
} from '@/api/controlplane';
import { ApiError } from '@/lib/apiClient';
import type { PromptEntity, ResourceStatus } from '@/api/controlplane/types';
import { notifyFailure, notifyPublish, notifySuccess } from '@/features/controlplane/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { agentDisplayName } from '@/lib/agentDisplay';
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import FilterChips from '@/components/ui/FilterChips.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppCard from '@/components/ui/AppCard.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import VersionsPanel from '@/components/controlplane/VersionsPanel.vue';

const queryClient = useQueryClient();

const { data: prompts, isLoading, error } = useQuery({
  queryKey: queryKeys.prompts,
  queryFn: listPrompts,
});

/* agent 列表同时是「引用方」的数据源，见文件头。 */
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

/** agent 标识 → 展示名；引用方列表与筛选下拉都展示 agent，给人看的该是名字。 */
const displayNameOf = computed(() => agentDisplayName(agents.value));

const list = computed(() => prompts.value ?? []);

/** 反向引用表：prompt-key -> 引用它的 agent 名。 */
const ownersByKey = computed(() => {
  const map = new Map<string, string[]>();
  for (const row of agents.value ?? []) {
    if (!row.promptKey) continue;
    const owners = map.get(row.promptKey) ?? [];
    owners.push(row.agentName);
    map.set(row.promptKey, owners);
  }
  return map;
});

const ownersOf = (key: string) => ownersByKey.value.get(key) ?? [];

/** 引用方的下拉选项：只列出真的引用了至少一条 prompt 的 agent。 */
const ownerOptions = computed(() =>
  [...ownersByKey.value.keys()].sort((a, b) => a.localeCompare(b)),
);

// ==================== 筛选 ====================

const statusChip = ref('all');
const keyword = ref('');
const ownerFilter = ref('');

/**
 * 状态口语化。
 *
 * status 只区分 DRAFT / PUBLISHED，但用户真正想知道的是「线上是不是这一版」：
 * publishedVersion 为 null 说明从来没发布过，与「改过还没发」是两件事。
 */
function statusText(row: PromptEntity): string {
  if (row.status === 'PUBLISHED') return '已发布';
  return row.publishedVersion === null ? '未发布过' : '有改动待发布';
}

function statusTone(row: PromptEntity): 'ok' | 'rw' | 'off' {
  if (row.status === 'PUBLISHED') return 'ok';
  return row.publishedVersion === null ? 'off' : 'rw';
}

const countByStatus = (status: ResourceStatus) =>
  list.value.filter((row) => row.status === status).length;

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  { key: 'PUBLISHED', label: '已发布', count: countByStatus('PUBLISHED') },
  { key: 'DRAFT', label: '有改动待发布', count: countByStatus('DRAFT') },
]);

const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return list.value.filter((row) => {
    if (statusChip.value !== 'all' && row.status !== statusChip.value) return false;
    if (ownerFilter.value && !ownersOf(row.promptKey).includes(ownerFilter.value)) return false;
    if (!lower) return true;
    // 展示名与 prompt-key 都参与检索：一个是页面上看到的名字，一个是 agent 引用它时填的值
    return `${row.displayName} ${row.promptKey} ${row.description ?? ''} ${(row.bizTags ?? []).join(' ')}`
      .toLowerCase()
      .includes(lower);
  });
});

const isFiltered = computed(
  () => Boolean(keyword.value || ownerFilter.value || statusChip.value !== 'all'),
);

function reset() {
  statusChip.value = 'all';
  keyword.value = '';
  ownerFilter.value = '';
}

// ==================== 编辑抽屉 ====================

const drawerOpen = ref(false);
/** 抽屉里的本地草稿：关闭或保存前都不写回 query 缓存，避免列表在编辑中途跟着变。 */
const draft = ref<PromptEntity | null>(null);
/** 新建时为 true：保存走 POST，且 prompt-key 可编辑（存量条目 key 是主键，不允许改）。 */
const creating = ref(false);
const changeNote = ref('');

const { data: versions, isLoading: versionsLoading } = useQuery({
  queryKey: computed(() =>
    queryKeys.resourceVersions('prompt', draft.value?.promptKey ?? ''),
  ),
  queryFn: () => promptVersions(draft.value!.promptKey),
  enabled: computed(() => drawerOpen.value && !creating.value && Boolean(draft.value?.promptKey)),
});

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: queryKeys.prompts });
  void queryClient.invalidateQueries({ queryKey: ['versions'] });
}

function openCreate() {
  creating.value = true;
  changeNote.value = '';
  draft.value = {
    promptKey: '',
    displayName: '',
    description: '',
    bizTags: [],
    body: '',
    status: 'DRAFT',
    version: null,
    publishedVersion: null,
    publishedAtMs: null,
    createdAtMs: null,
    updatedAtMs: null,
    createdBy: null,
    updatedBy: null,
  };
  drawerOpen.value = true;
}

function openEdit(row: PromptEntity) {
  creating.value = false;
  changeNote.value = '';
  // 深拷贝：抽屉里改的是副本，取消就丢掉，不必做「恢复原值」的逻辑
  draft.value = { ...row, bizTags: row.bizTags ? [...row.bizTags] : [] };
  drawerOpen.value = true;
}

/**
 * 抽屉里能给出结论的必填项。
 *
 * <p>原来这里只算了一个 {@code canSave}，而它<b>没有任何调用点</b> —— 于是"必填"
 * 实际上一条都没拦，用户点保存只会拿到后端的 400。现在把结论接到按钮上，
 * 并补上 displayName。后端也有同一套校验（validatePrompt），这里只是省掉一次白点的往返。
 */
const drawerProblems = computed(() => {
  const problems: string[] = [];
  if (!draft.value?.promptKey?.trim()) problems.push('prompt-key 不能为空');
  if (!draft.value?.displayName?.trim()) problems.push('显示名不能为空');
  if (draft.value?.body === null) problems.push('正文不能是 null（清空正文请留空串）');
  return problems;
});
const canSave = computed(() => drawerProblems.value.length === 0);

// ==================== 写操作 ====================

const saveMutation = useMutation({
  mutationFn: async () => {
    const payload = draft.value!;
    return creating.value
      ? createPrompt(payload)
      : savePrompt(payload.promptKey, payload);
  },
  onSuccess: (saved) => {
    // 新建成功后转入编辑态：key 已落库，后续保存必须走 PUT
    creating.value = false;
    draft.value = { ...saved, bizTags: saved.bizTags ? [...saved.bizTags] : [] };
    invalidate();
    notifySuccess('已保存为草稿');
  },
  onError: (err) => notifyFailure(err, '保存失败'),
});
const publishMutation = useMutation({
  mutationFn: async () => {
    const saved = await saveMutation.mutateAsync();
    return publishPrompt(saved.promptKey, changeNote.value || undefined);
  },
  onSuccess: (result) => {
    changeNote.value = '';
    invalidate();
    notifyPublish(result);
  },
  onError: (err) => notifyFailure(err, '发布失败'),
});

const deleteMutation = useMutation({
  mutationFn: (key: string) => deletePrompt(key),
  onSuccess: () => {
    drawerOpen.value = false;
    draft.value = null;
    invalidate();
    notifySuccess('已删除');
  },
  onError: (err) => notifyFailure(err, '删除失败'),
});

const rollbackMutation = useMutation({
  mutationFn: (version: number) => rollbackPrompt(draft.value!.promptKey, version),
  onSuccess: (_result, version) => {
    invalidate();
    notifySuccess(`已回滚到 v${version}`);
  },
  onError: (err) => notifyFailure(err, '回滚失败'),
});

const busy = computed(
  () =>
    saveMutation.isPending.value ||
    publishMutation.isPending.value ||
    deleteMutation.isPending.value,
);

async function confirmDelete() {
  const key = draft.value?.promptKey;
  if (!key) return;
  const owners = ownersOf(key);
  /*
   * 先在前端拦一次「被引用」的删除，省掉一次必然失败的往返；后端的 409 仍是最终裁决。
   * 这里构造一个和 409 同形状的 ApiError 而不是另写一套提示：反馈路径只有一条，
   * 页面上的呈现也就不会出现两种样子（一个带引用清单、一个只有一句话）。
   */
  if (owners.length > 0) {
    notifyFailure(
      new ApiError(`被 ${owners.length} 个 agent 引用，先解绑再删除`, 409, {
        referencingAgents: owners,
      }),
      '不能删除',
    );
    return;
  }
  try {
    await ElMessageBox.confirm(
      `删除「${key}」后不可恢复，版本快照也会一并消失。`,
      '删除 Prompt',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  deleteMutation.mutate(key);
}

async function confirmRollback(version: number) {
  try {
    await ElMessageBox.confirm(
      `把内容回滚到 v${version}？回滚会生成一个新版本（内容为旧版），线上实例要再发布一次才会变。`,
      '回滚版本',
      { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  rollbackMutation.mutate(version);
}

/* 抽屉关掉时清空草稿：下次打开一定是新数据，不会残留上一次的编辑。 */
watch(drawerOpen, (open) => {
  if (!open) {
    creating.value = false;
    changeNote.value = '';
    draft.value = null;
  }
});

const bodyChars = computed(() => draft.value?.body?.length ?? 0);
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button @click="invalidate">刷新</el-button>
      <el-button type="primary" @click="openCreate">+ 新建 Prompt</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: visible.length, total: list.length, noun: '条 Prompt' }">
    <template #chips>
      <FilterChips v-model="statusChip" :items="chips" />
    </template>
    <FilterField label="关键字" width="260px">
      <el-input v-model="keyword" placeholder="prompt-key / 描述 / 标签" clearable />
    </FilterField>
    <FilterField label="被谁引用" width="220px">
      <el-select v-model="ownerFilter" placeholder="全部 Agent" clearable filterable>
        <!-- label 是展示名，value 仍是 agent-name：筛选比的是引用清单里的标识，
             换掉 value 会让这个下拉一条都筛不出来。 -->
        <el-option v-for="item in ownerOptions" :key="item" :label="displayNameOf(item)" :value="item" />
      </el-select>
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="loading">加载中…</div>
  <AppCard v-else-if="error">
    <EmptyState title="读不到 Prompt 清单" :hint="(error as Error).message" />
  </AppCard>
  <EmptyState
    v-else-if="visible.length === 0"
    :title="list.length === 0 ? '库里还没有 Prompt' : '没有符合条件的 Prompt'"
  >
    <template #action>
      <el-button v-if="list.length === 0" type="primary" @click="openCreate">+ 新建 Prompt</el-button>
      <el-button v-else :disabled="!isFiltered" @click="reset">重置筛选</el-button>
    </template>
  </EmptyState>

  <div v-else class="grid-cards">
    <AppCard
      v-for="row in visible"
      :key="row.promptKey"
      :title="row.displayName"
      :description="row.description || undefined"
      clickable
      @click="openEdit(row)"
    >
      <template #badge>
        <AppBadge :variant="statusTone(row)">{{ statusText(row) }}</AppBadge>
      </template>
      <template #tags>
        <!-- prompt-key 降为次要索引：agent 引用它时填的是这个值，不是展示名 -->
        <span class="tag-chip mono">{{ row.promptKey }}</span>
        <span v-for="tag in row.bizTags ?? []" :key="tag" class="tag-chip">{{ tag }}</span>
      </template>
    </AppCard>
  </div>

  <el-drawer v-model="drawerOpen" size="760px" :with-header="false" destroy-on-close>
    <div v-if="draft" class="dw">
      <header class="dw__hd">
        <div class="dw__ttl">
          <span class="strong">{{ creating ? '新建 Prompt' : draft.displayName }}</span>
          <AppBadge v-if="!creating" :variant="statusTone(draft)">{{ statusText(draft) }}</AppBadge>
        </div>
        <div class="row">
          <el-button :loading="busy" :disabled="!canSave" @click="saveMutation.mutate()">保存草稿</el-button>
          <el-button type="primary" :loading="busy" :disabled="!canSave" @click="publishMutation.mutate()">
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
        <AppNote v-if="!canSave" tone="warn" class="mb">{{ drawerProblems.join('；') }}</AppNote>
        <el-form label-position="top">
          <el-form-item label="prompt-key">
            <el-input
              v-model="draft.promptKey"
              :disabled="!creating"
              placeholder="例如 workwx_doc_agent"
              class="mono"
            />
          </el-form-item>

          <el-form-item label="显示名">
            <el-input v-model="draft.displayName" placeholder="例如 企微报表助手提示词" />
          </el-form-item>

          <el-form-item label="描述">
            <el-input v-model="draft.description" placeholder="请输入说明" />
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

        <div class="sec">
          <div class="sec__hd">
            <h3>正文</h3>
            <span class="hint">{{ bodyChars }} 字符</span>
          </div>
          <el-input
            v-model="draft.body"
            type="textarea"
            :rows="18"
            resize="vertical"
            class="body-input"
            placeholder="纯文本 / Markdown。装配时原样进 sysPrompt，后端不做任何加工。"
          />
        </div>

        <div v-if="ownersOf(draft.promptKey).length > 0" class="sec">
          <div class="sec__hd"><h3>引用方</h3></div>
          <div class="row wrap">
            <!-- 展示名为主、标识用 title 保留：这一块回答的是"谁在用这份提示词" -->
            <span
              v-for="item in ownersOf(draft.promptKey)"
              :key="item"
              class="tag-chip"
              :title="item"
            >{{ displayNameOf(item) }}</span>
          </div>
        </div>

        <div v-if="!creating" class="sec">
          <div class="sec__hd"><h3>版本历史</h3></div>
          <el-input
            v-model="changeNote"
            placeholder="变更说明"
            class="mb"
          />
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
.body-input :deep(textarea) {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
}
</style>
