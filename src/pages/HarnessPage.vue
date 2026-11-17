<script setup lang="ts">
/*
 * Harness 工作台：Harness（编排型）agent 的入口。
 *
 * <h2>一、为什么 Harness 单独做一页，而不是在 Agents 页加个类型下拉</h2>
 * 两条链要作者做的事不一样：REACT 是"给它什么能力"（提示词 / 工具 / 技能 / MCP），
 * HARNESS 是"它怎么组织别的 agent"（工作区 / 上下文压缩 / 子 agent 路由）。
 * 在同一个新建向导里先让用户选类型，等于逼他在还不知道后果的时候做一个结构选择；
 * 而后端不允许创建后改类型，选错只能删掉重建。把入口拆开之后，
 * "从哪个入口进来"本身就说明了这个 agent 是哪种形态。
 *
 * <h2>二、这里只做「列表 + 新建」，编辑走 /harness/:agentId</h2>
 * 编排三域（工作区 / 上下文压缩 / 子 agent）的编辑面与 Agent 详情页共用同一个组件：
 * 同一个 agent 在两个列表里都看得到，但只有一条编辑路径。这样既不用把 400 行表单
 * 复制第二份，也不会出现"两个页面各写一半行束"——那正是脏数据的来源。
 *
 * <h2>三、新建时能力域给最小默认值</h2>
 * 落库走的还是同一条 POST /api/agents，只是 agentType 固定 HARNESS。引用与运行时
 * 先给空值（prompt 可以现在选，工具/技能/MCP 到详情页再加），因为"一条原子接口写完整行束"
 * 比"编排页先插一半、详情页再补另一半"安全得多：后者会在两次写之间留下不成形的 agent。
 */
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  createAgent,
  listAgents,
  listModels,
  listPrompts,
  publishAgent,
  reloadAgent,
  reloadAllAgents,
} from '@/api/controlplane';
import type { AgentDefinitionBundle, AgentRow } from '@/api/controlplane/types';
import { notifyFailure, notifyPublish, notifySuccess } from '@/features/controlplane/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { chatLink, harnessLink } from '@/lib/links';
import { modelSelectOptions, withCurrentModel } from '@/lib/modelOptions';
import { STATE_STORE_ON, STATE_STORE_OPTIONS, toStateStorePayload } from '@/lib/stateStore';
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppCard from '@/components/ui/AppCard.vue';
import AppBadge from '@/components/ui/AppBadge.vue';

const router = useRouter();
const queryClient = useQueryClient();

const { data: agents, isLoading, error } = useQuery({
  queryKey: queryKeys.agents,
  queryFn: listAgents,
});

/** 这一页只管 HARNESS；REACT 在 Agents 页。 */
const harnessAgents = computed(() =>
  (agents.value ?? []).filter((row) => row.agentType === 'HARNESS'),
);

const keyword = ref('');
const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  if (!lower) return harnessAgents.value;
  // 展示名与 agent-name 都参与检索：前者是页面上看到的名字，后者是子 agent 声明、
  // channel 兜底、日志里出现的名字（见 AgentsPage 同名注释）。
  return harnessAgents.value.filter((row) =>
    `${row.displayName} ${row.agentName} ${row.description ?? ''} ${(row.bizTags ?? []).join(' ')}`
      .toLowerCase()
      .includes(lower),
  );
});

/**
 * 状态口语化：status 只说"有没有未发布改动"，loaded 才说"实例在不在"。
 * 与 Agents 页同一套说法 —— 同一个 agent 在两个页面里的状态文案必须一致，
 * 否则用户会以为看到了两个不同的东西。
 */
function statusText(row: AgentRow): string {
  if (row.enabled === false) return '已停用';
  const base = row.status === 'PUBLISHED' ? '已发布' : row.publishedVersion === null ? '未发布' : '有改动';
  return row.loaded ? base : `${base} · 未加载`;
}

function statusTone(row: AgentRow): 'ok' | 'off' | 'rw' {
  if (row.enabled === false) return 'off';
  if (!row.loaded) return 'rw';
  return row.status === 'PUBLISHED' ? 'ok' : 'rw';
}

// ==================== 新建 ====================

interface HarnessForm {
  agentName: string;
  displayName: string;
  description: string;
  category: string;
  promptKey: string;
  modelRef: string;
  maxIters: number | null;
  stateStore: string;
  workspacePath: string;
  fsBackend: string;
  harnessAgentId: string;
}

function blankForm(): HarnessForm {
  return {
    agentName: '',
    displayName: '',
    description: '',
    category: '',
    promptKey: '',
    modelRef: '',
    maxIters: null,
    // 默认开启，口径与新建 REACT agent 一致（见 lib/stateStore.ts）
    stateStore: STATE_STORE_ON,
    workspacePath: '',
    fsBackend: 'LOCAL',
    harnessAgentId: '',
  };
}

const dialogOpen = ref(false);
const form = ref<HarnessForm>(blankForm());
const publishOnCreate = ref(false);

function openDialog() {
  form.value = blankForm();
  publishOnCreate.value = false;
  dialogOpen.value = true;
}

/* 模型下拉的候选：库里那份 md_model 清单（见 lib/modelOptions.ts 的口径说明）。 */
const { data: models } = useQuery({ queryKey: queryKeys.models, queryFn: listModels });

const modelOptions = computed(() => modelSelectOptions(models.value));
/** 某个字段自己的候选：清单 + 该字段当前的值（存量数据可能是 Bean 名，见 lib/modelOptions.ts）。 */
function modelOptionsFor(current: string | null): ReturnType<typeof modelSelectOptions> {
  return withCurrentModel(modelOptions.value, current);
}

const { data: prompts } = useQuery({
  queryKey: queryKeys.prompts,
  queryFn: listPrompts,
  enabled: computed(() => dialogOpen.value),
});

/** 前端能给出结论的必填项先拦一次，省掉一次必然失败的往返。 */
const problems = computed(() => {
  const list: string[] = [];
  const name = form.value.agentName.trim();
  if (!name) list.push('agent-name 不能为空');
  else if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    // 带点、斜杠的名字会成为 URL 路径的一部分，后端路径参数会被截断
    list.push('agent-name 只允许字母、数字、下划线、连字符');
  }
  if ((agents.value ?? []).some((row) => row.agentName === name)) list.push('agent-name 已存在');
  // 展示名必填，与 Agents 页同规则（后端 validateAgentContent 也拦）。
  if (!form.value.displayName.trim()) list.push('显示名不能为空');
  if (!form.value.workspacePath.trim()) list.push('工作区路径必填（HARNESS 会读写它）');
  return list;
});

/**
 * 组装行束 —— 与 Agents 页的 buildBundle 是同一套规则，差异只在"哪张表有行"：
 *   HARNESS -> workspace 必须有；memory 允许为 null（进详情页再配）；
 *   REACT 专有的四项（conflictPolicy + 三项技能策略）一律留 null，否则校验会拒。
 */
function buildBundle(): AgentDefinitionBundle {
  const base = {
    status: 'DRAFT' as const,
    version: null,
    publishedVersion: null,
    publishedAtMs: null,
    createdAtMs: null,
    updatedAtMs: null,
    createdBy: null,
    updatedBy: null,
  };
  const name = form.value.agentName.trim();

  return {
    agent: {
      ...base,
      agentName: name,
      // 展示名只进 md_agent，不参与装配：装配层读的仍是 agentName
      displayName: form.value.displayName.trim(),
      // 固定 HARNESS：这一页的语义就是"建一个编排型 agent"
      agentType: 'HARNESS',
      description: form.value.description || null,
      category: form.value.category || null,
      bizTags: null,
      enabled: true,
    },
    ref: {
      agentName: name,
      promptKey: form.value.promptKey || null,
      // 工具 / 技能 / MCP 到详情页再补：编排型 agent 的价值在编排，不在这一屏填满
      tools: null,
      middleware: null,
      skillNames: null,
      mcpNames: null,
      knowledges: null,
    },
    runtime: {
      agentName: name,
      modelRef: form.value.modelRef || null,
      fallbackModelRef: null,
      reasoningEffort: null,
      maxIters: form.value.maxIters,
      maxRetries: null,
      maxContextTokens: null,
      checkRunning: null,
      stopOnReject: null,
      enableMetaTool: null,
      enableTaskList: null,
      enablePendingToolRecovery: null,
      // 四项 REACT 专有：HARNESS 配了会被后端校验拒
      conflictPolicy: null,
      dynamicSkillsEnabled: null,
      skillCodeExecutionEnabled: null,
      skillWorkDir: null,
      stateStore: toStateStorePayload(form.value.stateStore),
      defaultSessionId: null,
      longTermMemoryMode: null,
      longTermMemoryAsync: null,
      ragMode: null,
      generateOptions: null,
      modelExecutionConfig: null,
      toolExecutionConfig: null,
      retrieveConfig: null,
      permission: null,
    },
    // 上下文压缩允许为空：不是每个编排型 agent 都需要压缩，留空即"库里没有这行"
    memory: null,
    workspace: {
      agentName: name,
      // 留空则用 agent-name —— 与装配层的默认一致（harness/{agentName}）
      harnessAgentId: form.value.harnessAgentId.trim() || name,
      workspacePath: form.value.workspacePath.trim(),
      fsBackend: form.value.fsBackend,
      environment: null,
      environmentMemory: null,
      projectGlobalSkillsDir: null,
      planFileDirectory: null,
      additionalContextFiles: null,
      filesystem: null,
      useLegacyXmlWorkspaceContext: null,
      agentTracingLogEnabled: null,
      enablePlanMode: null,
      planModeAllowShell: null,
      // 默认开技能：编排型 agent 的流程与口径通常写在技能里
      skillsEnabled: true,
      enableSkills: null,
      disableSkills: null,
      skillManageToolEnabled: null,
      skillManageConfig: null,
      disableFilesystemTools: null,
      disableShellTool: null,
      disableMemoryTools: null,
      disableMemoryHooks: null,
      disableTranscript: null,
      disableSessionPersistence: null,
      disableWorkspaceContext: null,
      disableAtPathExpansion: null,
      disableSubagents: null,
      disableDynamicSubagents: null,
      disableDynamicSkills: null,
      disableDefaultWorkspaceSkills: null,
      disableToolsConfig: null,
      // 新建时留空 = 跟随框架默认（由模型自己填 timeout_seconds 决定同步/后台）
      subagentForceSync: null,
      subagentSyncTimeoutSeconds: null,
    },
    // 子 agent 声明在详情页里加：建的时候还不知道要派发给谁
    subAgents: [],
  };
}

const createMutation = useMutation({
  mutationFn: async () => {
    const created = await createAgent(buildBundle());
    if (publishOnCreate.value) {
      await publishAgent(created.agent.agentName, '新建并发布');
    }
    return created;
  },
  onSuccess: (created) => {
    dialogOpen.value = false;
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess(publishOnCreate.value ? '已创建并发布' : '已创建草稿');
    // 建完直接进编辑面：新 harness 的子 agent 与上下文压缩都还没配，留在列表页没有意义
    void router.push(`/harness/${created.agent.agentName}`);
  },
  onError: (err) => notifyFailure(err, '创建失败'),
});

// ==================== 列表上的快捷动作 ====================

const publishMutation = useMutation({
  mutationFn: (name: string) => publishAgent(name, undefined),
  onSuccess: (result) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifyPublish(result);
  },
  onError: (err) => notifyFailure(err, '发布失败'),
});

const reloadMutation = useMutation({
  mutationFn: (name: string) => reloadAgent(name),
  onSuccess: (result) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess(`已重建实例 ${result.reloaded}`);
  },
  onError: (err) => notifyFailure(err, '重建失败'),
});

/**
 * 从卡片直接进这个 harness 的对话页。
 *
 * <p>理由同 AgentsPage：卡片墙是"我该用哪个 agent"的选人场景，
 * 定完人的第一个动作常常是试一句。harness 也能对话 —— 后端按 agentId 受理，
 * 类型不参与判断（见 features/chat/api.ts 的 fetchChatAgents）。
 */
function openChat(row: AgentRow) {
  void router.push(chatLink(row.agentName));
}

const reloadAllMutation = useMutation({
  mutationFn: () => reloadAllAgents(),
  onSuccess: (result) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess(`已重载 ${result.agentCount} 个实例`);
  },
  onError: (err) => notifyFailure(err, '全量重载失败'),
});

/** 卡片上的次要操作收进「更多」，与 Agents 页保持同一套交互。 */
function handleCardCommand(command: unknown) {
  const { action, agentName } = command as { action: 'publish' | 'reload'; agentName: string };
  if (action === 'publish') publishMutation.mutate(agentName);
  if (action === 'reload') reloadMutation.mutate(agentName);
}
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button :loading="reloadAllMutation.isPending.value" @click="reloadAllMutation.mutate()">
        全量重载实例
      </el-button>
      <el-button type="primary" @click="openDialog">+ 新建 Harness Agent</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: visible.length, total: harnessAgents.length, noun: '个 Harness Agent' }">
    <FilterField label="关键字" width="260px">
      <el-input v-model="keyword" placeholder="agent 名 / 描述" clearable />
    </FilterField>
    <template #actions>
      <el-button :disabled="!keyword" @click="keyword = ''">重置</el-button>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="loading">加载中…</div>
  <AppCard v-else-if="error">
    <EmptyState title="读不到 Agent 清单" :hint="(error as Error).message" />
  </AppCard>
  <EmptyState
    v-else-if="visible.length === 0"
    :title="harnessAgents.length === 0 ? '库里还没有 Harness Agent' : '没有符合条件的 Harness Agent'"
  >
    <template #action>
      <el-button v-if="harnessAgents.length === 0" type="primary" @click="openDialog">
        + 新建 Harness Agent
      </el-button>
      <el-button v-else @click="keyword = ''">重置筛选</el-button>
    </template>
  </EmptyState>

  <div v-else class="grid-cards">
    <AppCard
      v-for="row in visible"
      :key="row.agentName"
      :title="row.displayName"
      :description="row.description || undefined"
      clickable
      @click="router.push(harnessLink(row.agentName))"
    >
      <template #badge>
        <!-- 与 Agents 页同一条理由：这一页只有 HARNESS，类型徽标是常量，写它等于没写。 -->
        <AppBadge :variant="statusTone(row)">{{ statusText(row) }}</AppBadge>
      </template>
      <template #tags>
        <!-- agent-name 降为次要索引：子 agent / channel 兜底 / 日志里引用的都是它 -->
        <span class="tag-chip mono">{{ row.agentName }}</span>
        <span v-if="row.category" class="tag-chip">{{ row.category }}</span>
        <span v-for="tag in row.bizTags ?? []" :key="tag" class="tag-chip">{{ tag }}</span>
      </template>
      <template #footer>
        <span class="spacer" />
        <span class="card-actions" @click.stop>
          <el-button size="small" text @click.stop="openChat(row)">对话</el-button>
          <el-dropdown trigger="click" @command="handleCardCommand">
            <el-button size="small" text>
              更多
              <el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item :command="{ action: 'publish', agentName: row.agentName }">
                  发布
                </el-dropdown-item>
                <el-dropdown-item :command="{ action: 'reload', agentName: row.agentName }">
                  重载
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </span>
      </template>
    </AppCard>
  </div>

  <el-dialog v-model="dialogOpen" title="新建 Harness Agent" width="720px" destroy-on-close>
    <el-form label-position="top">
      <el-form-item label="agent-name">
        <el-input v-model="form.agentName" class="mono" placeholder="例如 workwx_batch_agent" />
      </el-form-item>

      <el-form-item label="显示名">
        <el-input v-model="form.displayName" placeholder="例如 企微批量作业编排" />
      </el-form-item>

      <el-form-item label="描述">
        <el-input v-model="form.description" placeholder="请输入说明" />
      </el-form-item>

      <div class="form-2col">
        <el-form-item label="能力分组">
          <el-input v-model="form.category" placeholder="例如 运维 / 企微" />
        </el-form-item>
        <el-form-item label="系统提示词（prompt-key）">
          <el-select v-model="form.promptKey" clearable filterable placeholder="不引用" style="width: 100%">
            <el-option
              v-for="item in prompts ?? []"
              :key="item.promptKey"
              :label="item.displayName"
              :value="item.promptKey"
            >
              <span class="row">
                <span>{{ item.displayName }}</span>
                <span class="spacer" />
                <span class="hint mono">{{ item.promptKey }}</span>
              </span>
            </el-option>
          </el-select>
        </el-form-item>
      </div>

      <div class="form-2col">
        <el-form-item label="工作区路径（workspace-root 下）">
          <el-input v-model="form.workspacePath" class="mono" placeholder="例如 workwx_batch_agent" />
        </el-form-item>
        <el-form-item label="harness-agent-id">
          <el-input v-model="form.harnessAgentId" class="mono" placeholder="agent-name" />
        </el-form-item>
      </div>

      <el-form-item label="工作区文件后端">
        <el-select v-model="form.fsBackend" style="width: 100%">
          <el-option label="本地磁盘 LOCAL" value="LOCAL" />
          <el-option label="MySQL KV REMOTE" value="REMOTE" />
        </el-select>
      </el-form-item>

      <div class="form-2col">
        <el-form-item label="模型（model-ref）">
          <el-select
            v-model="form.modelRef"
            filterable
            clearable
            placeholder="默认模型"
            style="width: 100%"
          >
            <el-option
              v-for="item in modelOptionsFor(form.modelRef)"
              :key="item.value"
              :label="item.label"
              :value="item.value"
              :disabled="item.disabled"
            >
              <span>{{ item.label }}</span>
              <span class="hint mono" style="float: right">{{ item.note }}</span>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="最大迭代轮数">
          <el-input-number v-model="form.maxIters" :min="1" style="width: 100%" />
        </el-form-item>
      </div>

      <el-form-item label="状态存储标记">
        <!-- 见 AgentsPage 同名字段的说明：这一列只判非空，手输字符串没有意义 -->
        <el-select v-model="form.stateStore" style="width: 100%">
          <el-option
            v-for="item in STATE_STORE_OPTIONS"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <ul v-if="problems.length > 0" class="wiz__problems">
      <li v-for="item in problems" :key="item">{{ item }}</li>
    </ul>

    <template #footer>
      <div class="row wiz__ft">
        <el-checkbox v-model="publishOnCreate">创建后立即发布</el-checkbox>
        <span class="spacer" />
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="createMutation.isPending.value"
          :disabled="problems.length > 0"
          @click="createMutation.mutate()"
        >
          创建
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 var(--s4);
}
.wiz__problems {
  margin: var(--s3) 0 0;
  padding-left: 18px;
  color: var(--red);
  font-size: 13px;
  line-height: 1.8;
}
.wiz__ft {
  width: 100%;
}
</style>
