<script setup lang="ts">
/*
 * MCP 治理页：卡片网格 + 编辑抽屉。
 *
 * 两件事必须在这一页讲清楚，否则会被当成"改完没生效"的 bug：
 *
 * 1. 「保存」不改变任何连接。MCP 的连接是在装配期建的（DbMcpClientFactory），
 *    改完端点必须发布 —— 而且发布时后端会先失效这个 MCP 的客户端缓存再重建 agent，
 *    否则端点换了、会话还连着旧的。
 *
 * 2. 工具白/黑名单是 MCP 级而不是 agent 级（设计文档 D10）。含义是"这个 MCP 在本平台
 *    对外提供哪些工具"。所以一个 MCP 被多个 agent 引用时，名单是共享的。
 *
 * stdio 三件套（command / args / env）在库里留着，但页面不开放：装配层显式拒绝 stdio，
 * 放出来只会让人配完才发现不生效。将来放开时改的是装配逻辑与这一块，不是 DDL。
 */
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  createMcpServer,
  deleteMcpServer,
  listAgents,
  listMcpServers,
  mcpServerVersions,
  publishMcpServer,
  rollbackMcpServer,
  saveMcpServer,
} from '@/api/controlplane';
import type { McpServerEntity } from '@/api/controlplane/types';
import { notifyFailure, notifyPublish, notifySuccess } from '@/features/controlplane/feedback';
import { ApiError } from '@/lib/apiClient';
import { fromRecord, toRecord, type KVRow } from '@/lib/kvRows';
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
import KeyValueEditor from '@/components/ui/KeyValueEditor.vue';
import VersionsPanel from '@/components/controlplane/VersionsPanel.vue';

const queryClient = useQueryClient();

const { data: servers, isLoading, error } = useQuery({
  queryKey: queryKeys.mcpServers,
  queryFn: listMcpServers,
});
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

/** agent 标识 → 展示名；挂载方列表与筛选下拉都展示 agent，给人看的该是名字。 */
const displayNameOf = computed(() => agentDisplayName(agents.value));

const list = computed(() => servers.value ?? []);

/** 反向引用表：mcp 名 -> 挂载它的 agent 名。 */
const mountedBy = computed(() => {
  const map = new Map<string, string[]>();
  for (const row of agents.value ?? []) {
    for (const name of row.mcpNames ?? []) {
      const owners = map.get(name) ?? [];
      owners.push(row.agentName);
      map.set(name, owners);
    }
  }
  return map;
});

const mountedOf = (name: string) => mountedBy.value.get(name) ?? [];
const agentOptions = computed(() =>
  [...(agents.value ?? [])].map((row) => row.agentName).sort((a, b) => a.localeCompare(b)),
);

// ==================== 筛选 ====================

const stateChip = ref('all');
const transportFilter = ref('');
const keyword = ref('');
const mountedFilter = ref('');

const transports = computed(() =>
  [...new Set(list.value.map((row) => row.transport).filter(Boolean))].sort() as string[],
);

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  { key: 'on', label: '启用', count: list.value.filter((r) => r.enabled !== false).length },
  { key: 'off', label: '已停用', count: list.value.filter((r) => r.enabled === false).length },
]);

const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return list.value.filter((row) => {
    if (stateChip.value === 'on' && row.enabled === false) return false;
    if (stateChip.value === 'off' && row.enabled !== false) return false;
    if (transportFilter.value && row.transport !== transportFilter.value) return false;
    if (mountedFilter.value && !mountedOf(row.serverName).includes(mountedFilter.value)) return false;
    if (!lower) return true;
    // 展示名与 server-name 都参与检索：一个是页面上看到的名字，一个是 agent 引用它时填的值
    return `${row.displayName} ${row.serverName} ${row.description ?? ''} ${row.url ?? ''}`
      .toLowerCase()
      .includes(lower);
  });
});

const isFiltered = computed(
  () =>
    Boolean(keyword.value || transportFilter.value || mountedFilter.value) ||
    stateChip.value !== 'all',
);

function reset() {
  stateChip.value = 'all';
  transportFilter.value = '';
  keyword.value = '';
  mountedFilter.value = '';
}

// ==================== 编辑抽屉 ====================

const drawerOpen = ref(false);
const creating = ref(false);
const selectedName = ref('');
const changeNote = ref('');

const draft = ref<McpServerEntity | null>(null);
/** headers / query-params 在编辑态是行数组，提交时转回对象（见 lib/kvRows.ts）。 */
const headerRows = ref<KVRow[]>([]);
const queryRows = ref<KVRow[]>([]);

const { data: versions, isLoading: versionsLoading } = useQuery({
  queryKey: computed(() => queryKeys.resourceVersions('mcp', selectedName.value)),
  queryFn: () => mcpServerVersions(selectedName.value),
  enabled: computed(() => drawerOpen.value && !creating.value && Boolean(selectedName.value)),
});

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
  void queryClient.invalidateQueries({ queryKey: ['versions'] });
}

/** 新建的默认值：transport 选 streamable，enabled 打开 —— 这两个是绝大多数情况。 */
function blankServer(serverName: string): McpServerEntity {
  return {
    serverName,
    displayName: '',
    description: '',
    bizTags: [],
    transport: 'streamable',
    url: '',
    headers: null,
    queryParams: null,
    enableTools: [],
    disableTools: [],
    timeoutMs: null,
    initTimeoutMs: null,
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
  draft.value = blankServer('');
  headerRows.value = [];
  queryRows.value = [];
  drawerOpen.value = true;
}

function openEdit(row: McpServerEntity) {
  creating.value = false;
  selectedName.value = row.serverName;
  changeNote.value = '';
  draft.value = { ...row, bizTags: row.bizTags ? [...row.bizTags] : [] };
  headerRows.value = fromRecord(row.headers);
  queryRows.value = fromRecord(row.queryParams);
  drawerOpen.value = true;
}

const canSave = computed(() => {
  const row = draft.value;
  // 三个都必填：server-name / 显示名 / 端点 URL。后端的 validateMcp 是同一套规则
  // （没有 url 就没有可连的端点，没有显示名卡片标题就是空白）。
  return Boolean(row?.serverName?.trim()) && Boolean(row?.displayName?.trim()) && Boolean(row?.url?.trim());
});
// ==================== 写操作 ====================

function payload(): McpServerEntity {
  return {
    ...draft.value!,
    headers: toRecord(headerRows.value),
    queryParams: toRecord(queryRows.value),
    // 空名单与 null 是两件事：null 表示"不设限"，空数组在装配层会被归一成 null，
    // 这里统一成 null 让库里的语义与页面上的"没配"一致。
    enableTools: draft.value!.enableTools?.length ? draft.value!.enableTools : null,
    disableTools: draft.value!.disableTools?.length ? draft.value!.disableTools : null,
  };
}

const saveMutation = useMutation({
  mutationFn: async () => {
    const body = payload();
    return creating.value ? createMcpServer(body) : saveMcpServer(body.serverName, body);
  },
  onSuccess: (saved) => {
    creating.value = false;
    selectedName.value = saved.serverName;
    invalidate();
    notifySuccess('已保存为草稿');
  },
  onError: (err) => notifyFailure(err, '保存失败'),
});

const publishMutation = useMutation({
  mutationFn: async () => {
    const saved = await saveMutation.mutateAsync();
    return publishMcpServer(saved.serverName, changeNote.value || undefined);
  },
  onSuccess: (result) => {
    changeNote.value = '';
    invalidate();
    notifyPublish(result);
  },
  onError: (err) => notifyFailure(err, '发布失败'),
});

const deleteMutation = useMutation({
  mutationFn: (name: string) => deleteMcpServer(name),
  onSuccess: () => {
    drawerOpen.value = false;
    invalidate();
    notifySuccess('已删除');
  },
  onError: (err) => notifyFailure(err, '删除失败'),
});

const rollbackMutation = useMutation({
  mutationFn: (version: number) => rollbackMcpServer(selectedName.value, version),
  onSuccess: (_r, version) => {
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
  const name = draft.value?.serverName;
  if (!name) return;
  const owners = mountedOf(name);
  if (owners.length > 0) {
    notifyFailure(
      new ApiError(`被 ${owners.length} 个 agent 挂载，先解绑再删除`, 409, {
        referencingAgents: owners,
      }),
      '不能删除',
    );
    return;
  }
  try {
    await ElMessageBox.confirm(`删除「${name}」后不可恢复，版本快照也会一并消失。`, '删除 MCP 服务', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  deleteMutation.mutate(name);
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
    selectedName.value = '';
    changeNote.value = '';
    draft.value = null;
    headerRows.value = [];
    queryRows.value = [];
  }
});
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button @click="invalidate">刷新</el-button>
      <el-button type="primary" @click="openCreate">+ 接入 MCP</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: visible.length, total: list.length, noun: '个服务' }">
    <template #chips>
      <FilterChips v-model="stateChip" :items="chips" />
    </template>
    <FilterField label="关键字" width="260px">
      <el-input v-model="keyword" placeholder="服务名 / 端点 / 描述" clearable />
    </FilterField>
    <FilterField label="传输方式" width="180px">
      <el-select v-model="transportFilter" placeholder="全部方式" clearable>
        <el-option v-for="item in transports" :key="item" :label="item" :value="item" />
      </el-select>
    </FilterField>
    <FilterField label="被谁挂载" width="200px">
      <el-select v-model="mountedFilter" placeholder="全部 Agent" clearable filterable>
        <!-- label 是展示名，value 仍是 agent-name（筛选比的是挂载清单里的标识） -->
        <el-option v-for="item in agentOptions" :key="item" :label="displayNameOf(item)" :value="item" />
      </el-select>
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="loading">加载中…</div>
  <AppCard v-else-if="error">
    <EmptyState title="读不到 MCP 清单" :hint="(error as Error).message" />
  </AppCard>
  <EmptyState
    v-else-if="visible.length === 0"
    :title="list.length === 0 ? '库里还没有 MCP 服务' : '没有符合条件的 MCP 服务'"
  >
    <template #action>
      <el-button v-if="list.length === 0" type="primary" @click="openCreate">+ 接入 MCP</el-button>
      <el-button v-else :disabled="!isFiltered" @click="reset">重置筛选</el-button>
    </template>
  </EmptyState>

  <div v-else class="grid-cards">
    <AppCard
      v-for="row in visible"
      :key="row.serverName"
      :title="row.displayName"
      :description="row.description || undefined"
      clickable
      @click="openEdit(row)"
    >
      <template #badge>
        <AppBadge :variant="row.enabled === false ? 'off' : 'ok'">
          {{ row.enabled === false ? '已停用' : (row.transport ?? 'streamable') }}
        </AppBadge>
      </template>
      <template #tags>
        <!-- server-name 降为次要索引：agent 的 mcp-names 引用它时填的是这个值 -->
        <span class="tag-chip mono">{{ row.serverName }}</span>
        <span v-for="tag in row.bizTags ?? []" :key="tag" class="tag-chip">{{ tag }}</span>
      </template>
    </AppCard>
  </div>

  <el-drawer v-model="drawerOpen" size="780px" :with-header="false" destroy-on-close>
    <div v-if="draft" class="dw">
      <header class="dw__hd">
        <div class="dw__ttl">
          <span class="strong">{{ creating ? '接入 MCP' : draft.displayName }}</span>
          <AppBadge v-if="!creating" :variant="draft.enabled === false ? 'off' : 'ok'">
            {{ draft.enabled === false ? '已停用' : '启用' }}
          </AppBadge>
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
        <AppNote v-if="!canSave" tone="warn" class="mb">
          必填项还没填完：server-name / 显示名 / 端点 URL。
        </AppNote>
        <el-form label-position="top">
          <div class="form-2col">
            <el-form-item label="server-name">
              <el-input
                v-model="draft.serverName"
                :disabled="!creating"
                class="mono"
                placeholder="例如 workwx-doc-mcp"
              />
            </el-form-item>
            <el-form-item label="传输方式">
              <el-select v-model="draft.transport" style="width: 100%">
                <el-option label="streamable-http" value="streamable" />
                <el-option label="sse" value="sse" />
              </el-select>
            </el-form-item>
          </div>

          <el-form-item label="显示名">
            <el-input v-model="draft.displayName" placeholder="例如 企微文档 MCP" />
          </el-form-item>

          <el-form-item label="端点 URL">
            <el-input v-model="draft.url" class="mono" placeholder="https://…/mcp" />
          </el-form-item>

          <el-form-item label="描述">
            <el-input v-model="draft.description" placeholder="这个 MCP 提供什么能力" />
          </el-form-item>

          <div class="form-2col">
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
            <el-form-item label="启用">
              <el-switch v-model="draft.enabled" active-text="启用" inactive-text="停用" />
            </el-form-item>
          </div>
        </el-form>

        <div class="sec">
          <div class="sec__hd"><h3>工具范围</h3></div>
          <el-form label-position="top">
            <el-form-item label="工具白名单（enable-tools）">
              <el-select
                v-model="draft.enableTools"
                multiple
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                placeholder="输入工具名后回车"
                style="width: 100%"
              >
                <el-option v-for="tool in draft.enableTools ?? []" :key="tool" :label="tool" :value="tool" />
              </el-select>
            </el-form-item>
            <el-form-item label="工具黑名单（disable-tools）">
              <el-select
                v-model="draft.disableTools"
                multiple
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                placeholder="输入工具名后回车"
                style="width: 100%"
              >
                <el-option v-for="tool in draft.disableTools ?? []" :key="tool" :label="tool" :value="tool" />
              </el-select>
            </el-form-item>
          </el-form>
        </div>

        <div class="sec">
          <div class="sec__hd"><h3>请求头</h3></div>
          <KeyValueEditor
            v-model="headerRows"
            key-placeholder="Header 名"
            value-placeholder="值"
            add-label="+ 添加 Header"
          />
        </div>

        <div class="sec">
          <div class="sec__hd"><h3>查询参数</h3></div>
          <KeyValueEditor
            v-model="queryRows"
            key-placeholder="参数名"
            value-placeholder="值"
            add-label="+ 添加参数"
          />
        </div>

        <div class="sec">
          <div class="sec__hd"><h3>超时</h3></div>
          <el-form label-position="top">
            <div class="form-2col">
              <el-form-item label="单次调用超时（毫秒）">
                <el-input-number v-model="draft.timeoutMs" :min="0" :step="1000" style="width: 100%" />
              </el-form-item>
              <el-form-item label="握手 / 初始化超时（毫秒）">
                <el-input-number v-model="draft.initTimeoutMs" :min="0" :step="1000" style="width: 100%" />
              </el-form-item>
            </div>
          </el-form>
        </div>

        <div v-if="mountedOf(draft.serverName).length > 0" class="sec">
          <div class="sec__hd"><h3>挂载方</h3></div>
          <div class="row wrap">
            <span
              v-for="item in mountedOf(draft.serverName)"
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
