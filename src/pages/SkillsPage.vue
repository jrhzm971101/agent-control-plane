<script setup lang="ts">
/*
 * Skill 治理页：卡片网格 + 编辑抽屉。
 *
 * 这一页的形状由 skill 的存储结构决定，不是随手选的：
 *
 * - 治理元数据（展示名 / 标签 / 状态 / 版本）在 md_skill_meta；
 * - 正文与附属文件在官方 MysqlSkillRepository 的两张表。
 * 两个 schema 不能事务合并，所以保存接口收的是一个「meta + body + resources」的整体
 * （SkillUpsert），页面也必须在一次提交里把三块一起交上去 —— 拆成三个请求会出现
 * 「正文存了、meta 没存」的中间态。
 *
 * 列表接口只回 meta：正文要回查官方表，列表页不需要（几十条 skill 会白拖一份全文）。
 * 所以正文是点开抽屉时才拉的。
 *
 * 另外「被谁引用」和 Prompt 页一样是本地算的：agent 列表已经带回每个 agent 的 skillNames。
 */
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  createSkill,
  deleteSkill,
  getSkill,
  listAgents,
  listSkills,
  publishSkill,
  rollbackSkill,
  saveSkill,
  skillVersions,
} from '@/api/controlplane';
import type { SkillMetaEntity } from '@/api/controlplane/types';
import { notifyFailure, notifyPublish, notifySuccess } from '@/features/controlplane/feedback';
import { ApiError } from '@/lib/apiClient';
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

const { data: skills, isLoading, error } = useQuery({
  queryKey: queryKeys.skills,
  queryFn: listSkills,
});
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

/** agent 标识 → 展示名；引用方列表展示的是 agent，给人看的该是名字。 */
const displayNameOf = computed(() => agentDisplayName(agents.value));

const list = computed(() => skills.value ?? []);

/** 反向引用表：skill 名 -> 引用它的 agent 名。 */
const ownersByName = computed(() => {
  const map = new Map<string, string[]>();
  for (const row of agents.value ?? []) {
    for (const name of row.skillNames ?? []) {
      const owners = map.get(name) ?? [];
      owners.push(row.agentName);
      map.set(name, owners);
    }
  }
  return map;
});

const ownersOf = (name: string) => ownersByName.value.get(name) ?? [];
const ownerFilterOptions = computed(() =>
  [...(agents.value ?? [])].map((row) => row.agentName).sort((a, b) => a.localeCompare(b)),
);

// ==================== 筛选 ====================

const statusChip = ref('all');
const keyword = ref('');
const ownerFilter = ref('');

function statusText(row: SkillMetaEntity): string {
  if (row.enabled === false) return '已停用';
  if (row.status === 'PUBLISHED') return '已发布';
  return row.publishedVersion === null ? '未发布过' : '有改动待发布';
}

function statusTone(row: SkillMetaEntity): 'ok' | 'off' | 'rw' {
  if (row.enabled === false) return 'off';
  if (row.status === 'PUBLISHED') return 'ok';
  return row.publishedVersion === null ? 'off' : 'rw';
}

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  { key: 'PUBLISHED', label: '已发布', count: list.value.filter((r) => r.status === 'PUBLISHED').length },
  { key: 'DRAFT', label: '有改动待发布', count: list.value.filter((r) => r.status === 'DRAFT').length },
  { key: 'ORPHAN', label: '没人引用', count: list.value.filter((r) => ownersOf(r.skillName).length === 0).length },
]);

const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return list.value.filter((row) => {
    if (statusChip.value === 'PUBLISHED' || statusChip.value === 'DRAFT') {
      if (row.status !== statusChip.value) return false;
    }
    if (statusChip.value === 'ORPHAN' && ownersOf(row.skillName).length > 0) return false;
    if (ownerFilter.value && !ownersOf(row.skillName).includes(ownerFilter.value)) return false;
    if (!lower) return true;
    return `${row.skillName} ${row.displayName} ${row.description ?? ''}`
      .toLowerCase()
      .includes(lower);
  });
});

const isFiltered = computed(
  () => Boolean(keyword.value || ownerFilter.value) || statusChip.value !== 'all',
);

function reset() {
  statusChip.value = 'all';
  keyword.value = '';
  ownerFilter.value = '';
}

// ==================== 编辑抽屉 ====================

const drawerOpen = ref(false);
const creating = ref(false);
const selectedName = ref('');
const changeNote = ref('');

/** 抽屉里的三块内容。resources 用数组编辑、提交时转回对象（对象没法表达"正在输入的空 key"）。 */
const meta = ref<SkillMetaEntity | null>(null);
const body = ref('');
const resourceRows = ref<Array<{ path: string; content: string }>>([]);

/** 详情是按需拉的：列表接口刻意不回正文。 */
const { data: detail, isLoading: detailLoading } = useQuery({
  queryKey: computed(() => queryKeys.skillDetail(selectedName.value)),
  queryFn: () => getSkill(selectedName.value),
  enabled: computed(() => drawerOpen.value && !creating.value && Boolean(selectedName.value)),
});

/*
 * 详情到位后灌进可编辑副本；抽屉里改的是副本，取消就丢掉。
 *
 * <p>immediate: true 不是保险，是必需：watch 只在"变化"时才触发，而详情<b>可能在组件挂载时
 * 就已经在缓存里</b>（staleTime 15s，第二次打开同一个 Skill 正是这种情况），那时回调永远不跑，
 * 抽屉会空着。同一个坑 2026-09-24 在 WorkflowDesignerPage 上真实发生过（"点进详情，信息是空的"）。
 *
 * <p>这里现在还被下面 watch(drawerOpen) 的"关闭清空"顺带保着：关抽屉会把 selectedName 置空，
 * 查询键跟着变，于是再打开时 detail 必然从 undefined 变成有值，watch 又跑起来了。
 * 但那是巧合不是设计 —— 哪天关闭时不再清 selectedName，这里立刻退化成空抽屉。
 * 补 immediate 之后不必再依赖这条耦合。
 */
watch(
  detail,
  (value) => {
    if (!value) return;
    meta.value = { ...value.meta, bizTags: value.meta.bizTags ? [...value.meta.bizTags] : [] };
    body.value = value.body ?? '';
    resourceRows.value = Object.entries(value.resources ?? {}).map(([path, content]) => ({
      path,
      content,
    }));
  },
  { immediate: true },
);

const { data: versions, isLoading: versionsLoading } = useQuery({
  queryKey: computed(() => queryKeys.resourceVersions('skill', selectedName.value)),
  queryFn: () => skillVersions(selectedName.value),
  enabled: computed(() => drawerOpen.value && !creating.value && Boolean(selectedName.value)),
});

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
  void queryClient.invalidateQueries({ queryKey: ['versions'] });
}

function blankMeta(skillName: string): SkillMetaEntity {
  return {
    skillName,
    displayName: '',
    description: '',
    bizTags: [],
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
  selectedName.value = '';
  changeNote.value = '';
  meta.value = blankMeta('');
  body.value = '---\nname: \ndescription: \n---\n\n';
  resourceRows.value = [];
  drawerOpen.value = true;
}

function openEdit(row: SkillMetaEntity) {
  creating.value = false;
  selectedName.value = row.skillName;
  changeNote.value = '';
  meta.value = blankMeta(row.skillName);
  body.value = '';
  resourceRows.value = [];
  drawerOpen.value = true;
}

/**
 * 能给出结论的必填项。
 *
 * <p>四项都是后端 validateSkill 拦的硬要求（skill-name / 展示名 / 官方内容表要求非空的
 * description / 正文），这里前置一份只是为了不让用户白点一次保存 —— 拿到 400 再回头找
 * 哪个字段空着，比直接在按钮上拦住多一轮往返。校验口径的后端仍是权威。
 */
const drawerProblems = computed(() => {
  const problems: string[] = [];
  if (!meta.value?.skillName?.trim()) problems.push('skill-name 不能为空');
  if (!meta.value?.displayName?.trim()) problems.push('显示名不能为空');
  if (!meta.value?.description?.trim()) problems.push('描述不能为空（官方内容表该列 NOT NULL）');
  if (!body.value.trim()) problems.push('SKILL.md 正文不能为空');
  return problems;
});
const canSave = computed(() => drawerProblems.value.length === 0);

/** 附属文件：空路径的行直接丢弃，不要把「新建了一行但没填」存成一条空文件。 */
function collectResources(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of resourceRows.value) {
    const path = row.path.trim();
    if (path) result[path] = row.content;
  }
  return result;
}
// ==================== 写操作 ====================

const saveMutation = useMutation({
  mutationFn: async () => {
    const payload = {
      meta: meta.value!,
      body: body.value,
      resources: collectResources(),
    };
    return creating.value ? createSkill(payload) : saveSkill(payload.meta.skillName, payload);
  },
  onSuccess: (saved) => {
    creating.value = false;
    selectedName.value = saved.meta.skillName;
    invalidate();
    notifySuccess('已保存为草稿');
  },
  onError: (err) => notifyFailure(err, '保存失败'),
});

const publishMutation = useMutation({
  mutationFn: async () => {
    const saved = await saveMutation.mutateAsync();
    return publishSkill(saved.meta.skillName, changeNote.value || undefined);
  },
  onSuccess: (result) => {
    changeNote.value = '';
    invalidate();
    notifyPublish(result);
  },
  onError: (err) => notifyFailure(err, '发布失败'),
});

const deleteMutation = useMutation({
  mutationFn: (name: string) => deleteSkill(name),
  onSuccess: () => {
    drawerOpen.value = false;
    invalidate();
    notifySuccess('已删除');
  },
  onError: (err) => notifyFailure(err, '删除失败'),
});

const rollbackMutation = useMutation({
  mutationFn: (version: number) => rollbackSkill(selectedName.value, version),
  onSuccess: (_r, version) => {
    invalidate();
    void queryClient.invalidateQueries({ queryKey: queryKeys.skillDetail(selectedName.value) });
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
  const name = meta.value?.skillName;
  if (!name) return;
  const owners = ownersOf(name);
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
      `删除「${name}」会同时删掉官方内容表里的正文与附属文件，且不可恢复。`,
      '删除 Skill',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  deleteMutation.mutate(name);
}

async function confirmRollback(version: number) {
  try {
    await ElMessageBox.confirm(
      `把 meta 与正文一起回滚到 v${version}？会生成一个新版本，线上实例要再发布一次才会变。`,
      '回滚版本',
      { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  rollbackMutation.mutate(version);
}

function addResourceRow() {
  resourceRows.value.push({ path: '', content: '' });
}

watch(drawerOpen, (open) => {
  if (!open) {
    creating.value = false;
    selectedName.value = '';
    changeNote.value = '';
    meta.value = null;
    body.value = '';
    resourceRows.value = [];
  }
});
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button @click="invalidate">刷新</el-button>
      <el-button type="primary" @click="openCreate">+ 新建 Skill</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: visible.length, total: list.length, noun: '个 Skill' }">
    <template #chips>
      <FilterChips v-model="statusChip" :items="chips" />
    </template>
    <FilterField label="关键字" width="260px">
      <el-input v-model="keyword" placeholder="skill 名 / 展示名 / 描述" clearable />
    </FilterField>
    <FilterField label="被谁引用" width="220px">
      <el-select v-model="ownerFilter" placeholder="全部 Agent" clearable filterable>
        <!-- label 是展示名，value 仍是 agent-name（筛选比的是引用清单里的标识） -->
        <el-option
          v-for="item in ownerFilterOptions"
          :key="item"
          :label="displayNameOf(item)"
          :value="item"
        />
      </el-select>
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="loading">加载中…</div>
  <AppCard v-else-if="error">
    <EmptyState title="读不到 Skill 清单" :hint="(error as Error).message" />
  </AppCard>
  <EmptyState
    v-else-if="visible.length === 0"
    :title="list.length === 0 ? '库里还没有 Skill' : '没有符合条件的 Skill'"
  >
    <template #action>
      <el-button v-if="list.length === 0" type="primary" @click="openCreate">+ 新建 Skill</el-button>
      <el-button v-else :disabled="!isFiltered" @click="reset">重置筛选</el-button>
    </template>
  </EmptyState>

  <div v-else class="grid-cards">
    <AppCard
      v-for="row in visible"
      :key="row.skillName"
      :title="row.displayName"
      :description="row.description || undefined"
      clickable
      @click="openEdit(row)"
    >
      <template #badge>
        <AppBadge :variant="statusTone(row)">{{ statusText(row) }}</AppBadge>
      </template>
      <template #tags>
        <span class="tag-chip mono">{{ row.skillName }}</span>
        <span v-for="tag in row.bizTags ?? []" :key="tag" class="tag-chip">{{ tag }}</span>
      </template>
    </AppCard>
  </div>

  <el-drawer v-model="drawerOpen" size="820px" :with-header="false" destroy-on-close>
    <div class="dw">
      <header class="dw__hd">
        <div class="dw__ttl">
          <span class="strong">{{ creating ? '新建 Skill' : meta?.displayName }}</span>
          <AppBadge v-if="meta && !creating" :variant="statusTone(meta)">{{ statusText(meta) }}</AppBadge>
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
        <!-- 详情还在读的时候不提示：那时候正文一定是空的，报"正文不能为空"是假警报（按钮已经先禁用了） -->
        <AppNote v-if="!canSave && !detailLoading" tone="warn" class="mb">
          {{ drawerProblems.join('；') }}
        </AppNote>
        <div v-if="detailLoading" class="loading">读取正文…</div>
        <template v-else-if="meta">
          <el-form label-position="top">
            <div class="form-2col">
              <el-form-item label="skill-name">
                <el-input
                  v-model="meta.skillName"
                  :disabled="!creating"
                  class="mono"
                  placeholder="例如 batch-audit-and-notify"
                />
              </el-form-item>
              <el-form-item label="展示名">
                <el-input v-model="meta.displayName" placeholder="例如 批量审计并通知" />
              </el-form-item>
            </div>

            <el-form-item label="描述">
              <el-input v-model="meta.description" placeholder="请输入说明" />
            </el-form-item>

            <div class="form-2col">
              <el-form-item label="业务标签">
                <el-select
                  v-model="meta.bizTags"
                  multiple
                  filterable
                  allow-create
                  default-first-option
                  :reserve-keyword="false"
                  placeholder="回车创建一个标签"
                  style="width: 100%"
                >
                  <el-option v-for="tag in meta.bizTags ?? []" :key="tag" :label="tag" :value="tag" />
                </el-select>
              </el-form-item>
              <el-form-item label="启用">
                <el-select v-model="meta.enabled" style="width: 100%">
                  <el-option label="启用" :value="true" />
                  <el-option label="停用" :value="false" />
                </el-select>
              </el-form-item>
            </div>
          </el-form>

          <div class="sec">
            <div class="sec__hd">
              <h3>SKILL.md 正文</h3>
              <span class="hint">{{ body.length }} 字符</span>
            </div>
            <el-input v-model="body" type="textarea" :rows="20" resize="vertical" class="mono-input" />
          </div>

          <div class="sec">
            <div class="sec__hd">
              <h3>附属文件</h3>
              <span class="spacer" />
              <el-button size="small" @click="addResourceRow">+ 添加文件</el-button>
            </div>
            <p v-if="resourceRows.length === 0">没有附属文件</p>
            <div v-for="(row, index) in resourceRows" :key="index" class="res">
              <el-input v-model="row.path" class="mono" placeholder="相对路径，例如 scripts/run.sh" />
              <el-button text type="danger" @click="resourceRows.splice(index, 1)">移除</el-button>
              <el-input
                v-model="row.content"
                type="textarea"
                :rows="6"
                class="mono-input res__body"
                placeholder="文件内容（纯文本）"
              />
            </div>
          </div>

          <div v-if="ownersOf(meta.skillName).length > 0" class="sec">
            <div class="sec__hd"><h3>引用方</h3></div>
            <div class="row wrap">
              <!-- 展示名为主、标识用 title 保留：这一块回答的是"谁在用这个技能" -->
              <span
                v-for="item in ownersOf(meta.skillName)"
                :key="item"
                class="tag-chip"
                :title="item"
              >{{ displayNameOf(item) }}</span>
            </div>
          </div>

          <div v-if="!creating" class="sec">
            <div class="sec__hd"><h3>版本历史</h3></div>
            <el-input v-model="changeNote" placeholder="变更说明" class="mb" />
            <VersionsPanel
              :versions="versions ?? []"
              :loading="versionsLoading"
              :published-version="meta.publishedVersion"
              @rollback="confirmRollback"
            />
          </div>
        </template>
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
  align-items: center;
  gap: var(--s3);
  margin-bottom: var(--s3);
}
.sec__hd h3 {
  margin: 0;
}
.mono-input :deep(textarea) {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
}
.res {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px var(--s2);
  padding: var(--s3);
  margin-bottom: var(--s2);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  background: var(--panel-soft);
}
.res__body {
  grid-column: 1 / -1;
}
</style>
