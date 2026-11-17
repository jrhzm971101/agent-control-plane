<script setup lang="ts">
/*
 * Agent 治理页：卡片墙 + 新建向导。
 *
 * 页面的两个形态决定：
 *
 * 1. 列表是卡片墙而不是表格。列表接口现在回的是「引用名清单」而不是计数（见后端
 *    AgentRow 的注释），一屏要同时表达"用了哪些能力"和"实例在不在"，横向多列的表格
 *    反而不如卡片好读。
 *
 * 2. 新建是向导而不是直接跳详情页。因为 agent 的引用项（prompt / tool / middleware /
 *    skill / mcp）都必须先存在才能引用，新建时必须按顺序确认；而工具与中间件来自扫 bean
 *    的只读目录，页面上不能新建它们 —— 只能选。
 *
 * 3. 这个入口只建 REACT（能力型）agent。HARNESS 的行结构不同（工作区 / 上下文压缩 /
 *    子 agent），作者要做的事也不同，所以走「Harness 工作台」那个入口；后端还会拒绝
 *    创建后改类型，于是"从哪个入口进来"就等于"这个 agent 是哪种形态"，不必再让用户
 *    在向导里先做一个他此刻无法判断的结构选择。
 *
 * 校验的硬约束在这里就要前置提示，否则用户会撞到后端的 400：
 *   - REACT 不能有 workspace / memory / 子 agent；
 *   - HARNESS 不能有 conflictPolicy 与三项 REACT 专有的 skill 开关（这三项现在在 runtime 表里）。
 */
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  createAgent,
  deleteAgent,
  listAgents,
  listMcpServers,
  listModels,
  listMiddlewareCatalog,
  listPrompts,
  listSkills,
  listToolCatalog,
  publishAgent,
  reloadAgent,
  reloadAllAgents,
} from '@/api/controlplane';
import type { AgentDefinitionBundle, AgentRow } from '@/api/controlplane/types';
import { notifyFailure, notifyPublish, notifySuccess } from '@/features/controlplane/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { agentLink, chatLink } from '@/lib/links';
import { modelSelectOptions, withCurrentModel } from '@/lib/modelOptions';
import { STATE_STORE_ON, STATE_STORE_OPTIONS, toStateStorePayload } from '@/lib/stateStore';
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import FilterChips from '@/components/ui/FilterChips.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppCard from '@/components/ui/AppCard.vue';
import AppBadge from '@/components/ui/AppBadge.vue';

const router = useRouter();
const queryClient = useQueryClient();

const { data: agents, isLoading, error } = useQuery({
  queryKey: queryKeys.agents,
  queryFn: listAgents,
});

/** 库里全部 agent（含 HARNESS）：只用来判断"库里到底有没有东西"，不直接渲染。 */
const all = computed(() => agents.value ?? []);

/**
 * 这一页只收 REACT（能力型）。
 *
 * <p>HARNESS 有自己的列表页（「Harness 工作台」），它的卡片点开走的是编排域，
 * 与这里的"给它什么能力"根本不是同一件事。把它混在这张列表里，除了让两个页面
 * 都能点进同一个 agent 之外没有别的作用，还顺手把「这一页到底管什么」搞模糊了。
 *
 * <p>注意别把这条筛选挪到 <b>API</b> 层去做：后端的 /api/agents 是控制面的全量清单，
 * 资源页要靠它反查引用方（"这个 prompt 被谁引用了"），少了 HARNESS 就会漏掉一半答案。
 * 「这一页显示什么」是页面的事，不是接口的事。
 */
const list = computed(() => all.value.filter((row) => row.agentType === 'REACT'));

// ==================== 筛选 ====================

const typeChip = ref('all');
const category = ref('');
const keyword = ref('');

const categoryOptions = computed(() =>
  [...new Set(list.value.map((row) => row.category).filter(Boolean))].sort() as string[],
);

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  // 没有「类型」这一维的 chip：列表里全是 REACT，留一个只会筛掉 0 条。
  { key: 'DRAFT', label: '有改动待发布', count: list.value.filter((r) => r.status === 'DRAFT').length },
  {
    key: 'UNLOADED',
    label: '未注册实例',
    count: list.value.filter((r) => !r.loaded).length,
  },
]);

const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return list.value.filter((row) => {
    if (typeChip.value === 'DRAFT' && row.status !== 'DRAFT') return false;
    if (typeChip.value === 'UNLOADED' && row.loaded) return false;
    if (category.value && row.category !== category.value) return false;
    if (!lower) return true;
    // 展示名与 agent-name 都要能被搜到：前者是页面上看到的名字，后者是别处（配置、日志、
    // 回调 URL）引用它时用的名字 —— 只按其中一个搜，另一种输入会得到"明明有这个 agent
    // 却搜不出来"的结论。
    return `${row.displayName} ${row.agentName} ${row.description ?? ''} ${(row.bizTags ?? []).join(' ')}`
      .toLowerCase()
      .includes(lower);
  });
});

const isFiltered = computed(
  () => Boolean(keyword.value || category.value) || typeChip.value !== 'all',
);

/*
 * 空态要分清两种情况：库里真的没有 agent，和「有、但都是 HARNESS」。
 * 后一种以前会说成"库里还没有 Agent"，然后让人去跑导入器 —— 而导入器并不能
 * 把 HARNESS 变出来，那是一条把人引到死路上的提示。
 */
const emptyTitle = computed(() =>
  list.value.length === 0 ? '还没有能力型（REACT）Agent' : '没有符合条件的 Agent',
);

function reset() {
  typeChip.value = 'all';
  category.value = '';
  keyword.value = '';
}

/**
 * 状态口语化：status 只说"有没有未发布改动"，loaded 才说"实例在不在"。
 * 两者合起来才是用户真正想知道的那件事 —— 线上到底跑的是不是屏幕上这份。
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
// ==================== 可选引用项（全部来自目录/库，不允许手输） ====================

/* 模型下拉的候选：库里那份 md_model 清单（见 lib/modelOptions.ts 的口径说明）。 */
const { data: models } = useQuery({ queryKey: queryKeys.models, queryFn: listModels });

const modelOptions = computed(() => modelSelectOptions(models.value));
/** 某个字段自己的候选：清单 + 该字段当前的值（存量数据可能是 Bean 名，见 lib/modelOptions.ts）。 */
function modelOptionsFor(current: string | null): ReturnType<typeof modelSelectOptions> {
  return withCurrentModel(modelOptions.value, current);
}

const { data: prompts } = useQuery({ queryKey: queryKeys.prompts, queryFn: listPrompts });
const { data: skills } = useQuery({ queryKey: queryKeys.skills, queryFn: listSkills });
const { data: mcpServers } = useQuery({ queryKey: queryKeys.mcpServers, queryFn: listMcpServers });
const { data: tools } = useQuery({ queryKey: queryKeys.toolCatalog, queryFn: listToolCatalog });
const { data: middleware } = useQuery({
  queryKey: queryKeys.middlewareCatalog,
  queryFn: listMiddlewareCatalog,
});

/* 停用的 MCP 不给出选项：后端校验会直接拒（配上去等于这个 agent 少了工具）。 */
const usableMcp = computed(() => (mcpServers.value ?? []).filter((row) => row.enabled !== false));

// ==================== 新建向导 ====================

interface WizardForm {
  agentName: string;
  displayName: string;
  description: string;
  category: string;
  bizTags: string[];
  promptKey: string;
  tools: string[];
  middleware: string[];
  skillNames: string[];
  mcpNames: string[];
  modelRef: string;
  maxIters: number | null;
  stateStore: string;
}

function blankForm(): WizardForm {
  return {
    agentName: '',
    displayName: '',
    description: '',
    category: '',
    bizTags: [],
    promptKey: '',
    tools: [],
    middleware: [],
    skillNames: [],
    mcpNames: [],
    modelRef: '',
    maxIters: null,
    // 默认开启：agent 绝大多数是拿来用的，而"没开状态存储"的表现是
    // 企微里聊两句就失忆 —— 那是需要回头查库才能发现的故障，不该是默认值。
    stateStore: STATE_STORE_ON,
  };
}

const wizardOpen = ref(false);
const form = ref<WizardForm>(blankForm());
const publishOnCreate = ref(false);

function openWizard() {
  form.value = blankForm();
  publishOnCreate.value = false;
  wizardOpen.value = true;
}

/** 前端能给出结论的必填项先在本地拦一次，省掉一次必然失败的往返。 */
const wizardProblems = computed(() => {
  const problems: string[] = [];
  if (!form.value.agentName.trim()) problems.push('agent-name 不能为空');
  else if (!/^[A-Za-z0-9_-]+$/.test(form.value.agentName.trim())) {
    // 带点、斜杠的名字会成为 URL 路径的一部分，后端路径参数会被截断
    problems.push('agent-name 只允许字母、数字、下划线、连字符');
  }
  if (list.value.some((row) => row.agentName === form.value.agentName.trim())) {
    problems.push('agent-name 已存在');
  }
  // 展示名是卡片标题的唯一来源，后端也拦（validateAgentContent）。
  // 这里先拦一次只是为了省掉一次必然失败的往返，不是唯一的防线。
  if (!form.value.displayName.trim()) problems.push('显示名不能为空');
  return problems;
});

/**
 * 组装行束。
 *
 * 这个入口只建 REACT，所以 workspace / memory / 子 agent 三张关联表一律不建行
 * （后端的第 7 条校验会拒掉"REACT 却带 workspace 行"）。这与后端校验一一对应，
 * 在页面这一层就按同一套规则建对象，而不是先建全再让后端挑错。
 */
function buildBundle(agentName: string): AgentDefinitionBundle {
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
  const name = agentName.trim();

  return {
    agent: {
      ...base,
      agentName: name,
      // 展示名只进 md_agent，不参与装配：装配层读的仍是 agentName（见后端实体注释）
      displayName: form.value.displayName.trim(),
      // 固定 REACT：类型由入口决定，不由向导里的一个下拉决定（创建后也不可变更）
      agentType: 'REACT',
      description: form.value.description || null,
      category: form.value.category || null,
      bizTags: form.value.bizTags.length ? form.value.bizTags : null,
      enabled: true,
    },
    ref: {
      agentName: name,
      promptKey: form.value.promptKey || null,
      tools: form.value.tools.length ? form.value.tools : null,
      middleware: form.value.middleware.length ? form.value.middleware : null,
      skillNames: form.value.skillNames.length ? form.value.skillNames : null,
      mcpNames: form.value.mcpNames.length ? form.value.mcpNames : null,
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
      // REACT 专有（HARNESS 配了会被校验拒）。三项技能策略留空 = 用框架默认；
      // 它们在详情页的「技能策略」里补，不在新建向导里展开 —— 新建时没人知道自己要不要它。
      conflictPolicy: 'OVERWRITE',
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
    memory: null,
    workspace: null,
    subAgents: [],
  };
}

/**
 * 卡片点击的去向。
 *
 * <p>列表里只有 REACT，所以去向是唯一的。（HARNESS 的卡片在「Harness 工作台」，
 * 那边同样硬编码跳 /harness/{name} —— 两个列表各自只管自己的语境，
 * 不需要一个按类型分叉的跳转函数。）
 */
function openAgent(row: AgentRow) {
  void router.push(agentLink(row.agentName));
}

/**
 * 从卡片直接进这个 agent 的对话页。
 *
 * <p>为什么列表上就要有这个入口：卡片墙是"我该用哪个 agent"的选人场景，
 * 而定完人之后第一个动作往往就是"试着问一句"。以前必须先点进详情、
 * 再从详情找到对话入口（那时详情上还没有），列表上的卡片只能看不能试。
 *
 * <p>stop 是必须的：卡片本身的点击是"进详情"，不拦下来会串成一个动作。
 */
function openChat(row: AgentRow) {
  void router.push(chatLink(row.agentName));
}

const createMutation = useMutation({
  mutationFn: async () => {
    const bundle = buildBundle(form.value.agentName);
    const created = await createAgent(bundle);
    if (publishOnCreate.value) {
      await publishAgent(created.agent.agentName, '新建并发布');
    }
    return created;
  },
  onSuccess: (created) => {
    wizardOpen.value = false;
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess(publishOnCreate.value ? '已创建并发布' : '已创建草稿');
    void router.push(`/agents/${created.agent.agentName}`);
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

/** 卡片上的次要操作收进「更多」，避免每张卡都平铺三四个按钮。 */
function handleCardCommand(command: unknown) {
  const { action, agentName } = command as { action: 'publish' | 'reload'; agentName: string };
  if (action === 'publish') publishMutation.mutate(agentName);
  if (action === 'reload') reloadMutation.mutate(agentName);
}

const reloadAllMutation = useMutation({
  mutationFn: () => reloadAllAgents(),
  onSuccess: (result) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess(`已重载 ${result.agentCount} 个实例`);
  },
  onError: (err) => notifyFailure(err, '全量重载失败'),
});

const removeMutation = useMutation({
  mutationFn: (name: string) => deleteAgent(name),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess('已删除');
  },
  onError: (err) => notifyFailure(err, '删除失败'),
});
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button :loading="reloadAllMutation.isPending.value" @click="reloadAllMutation.mutate()">
        全量重载实例
      </el-button>
      <el-button type="primary" @click="openWizard">+ 新建 Agent</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: visible.length, total: list.length, noun: '个能力型 Agent' }">
    <template #chips>
      <FilterChips v-model="typeChip" :items="chips" />
    </template>
    <FilterField label="关键字" width="260px">
      <el-input v-model="keyword" placeholder="agent 名 / 描述 / 标签" clearable />
    </FilterField>
    <FilterField label="能力分组" width="200px">
      <el-select v-model="category" placeholder="全部分组" clearable>
        <el-option v-for="item in categoryOptions" :key="item" :label="item" :value="item" />
      </el-select>
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <div v-if="isLoading" class="loading">加载中…</div>
  <AppCard v-else-if="error">
    <EmptyState title="读不到 Agent 清单" :hint="(error as Error).message" />
  </AppCard>
  <EmptyState
    v-else-if="visible.length === 0"
    :title="emptyTitle"
  >
    <template #action>
      <el-button v-if="list.length === 0" type="primary" @click="openWizard">+ 新建 Agent</el-button>
      <el-button v-else :disabled="!isFiltered" @click="reset">重置筛选</el-button>
    </template>
  </EmptyState>

  <div v-else class="grid-cards">
    <AppCard
      v-for="row in visible"
      :key="row.agentName"
      :title="row.displayName"
      :description="row.description || undefined"
      clickable
      @click="openAgent(row)"
    >
      <template #badge>
        <!-- 不放类型徽标：这一页只有 REACT，每张卡片都写一遍同一个词等于没写。
             页面的类型在标题「Agents（能力型）」与副标题里已经说清楚了。 -->
        <AppBadge :variant="statusTone(row)">{{ statusText(row) }}</AppBadge>
      </template>
      <template #tags>
        <!-- agent-name 降为次要索引：它与展示名分开之后，页面上只剩这一处能看到"库里
             到底叫什么"。复制去配 prompt / channel / 子 agent 引用时要用的是它，不是展示名。 -->
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

  <el-dialog v-model="wizardOpen" title="新建 Agent" width="720px" destroy-on-close>
    <el-form label-position="top">
      <el-form-item label="agent-name">
        <el-input v-model="form.agentName" class="mono" placeholder="例如 my_new_agent" />
      </el-form-item>

      <el-form-item label="显示名">
        <el-input v-model="form.displayName" placeholder="例如 企微报表助手" />
      </el-form-item>

      <el-form-item label="描述">
        <el-input v-model="form.description" placeholder="请输入说明" />
      </el-form-item>

      <div class="form-2col">
        <el-form-item label="能力分组">
          <el-input v-model="form.category" placeholder="例如 运维 / 企微" />
        </el-form-item>
        <el-form-item label="业务标签">
          <el-select
            v-model="form.bizTags"
            multiple
            filterable
            allow-create
            default-first-option
            :reserve-keyword="false"
            placeholder="回车创建一个标签"
            style="width: 100%"
          >
            <el-option v-for="tag in form.bizTags" :key="tag" :label="tag" :value="tag" />
          </el-select>
        </el-form-item>
      </div>

      <div class="wiz__sec">
        <h3>引用</h3>
        <el-form-item label="Prompt">
          <el-select v-model="form.promptKey" filterable clearable placeholder="不引用" style="width: 100%">
            <!-- 下拉里给人的是展示名，value 仍然是 prompt-key —— 后端按 key 解析 sysPrompt。
                 右侧用次要小字保留 key：从别处（库里、日志里）抄一个 key 过来对着找时要用它。 -->
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

        <el-form-item label="工具">
          <el-select v-model="form.tools" multiple filterable clearable placeholder="不挂工具" style="width: 100%">
            <el-option
              v-for="item in tools ?? []"
              :key="item.beanName"
              :label="`${item.name}（${item.beanName}）`"
              :value="item.beanName"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="Middleware">
          <el-select v-model="form.middleware" multiple filterable clearable placeholder="不挂中间件" style="width: 100%">
            <el-option
              v-for="item in middleware ?? []"
              :key="item.beanName"
              :label="`${item.simpleName}（${item.beanName}）`"
              :value="item.beanName"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="Skill">
          <el-select v-model="form.skillNames" multiple filterable clearable placeholder="不挂 skill" style="width: 100%">
            <el-option
              v-for="item in skills ?? []"
              :key="item.skillName"
              :label="item.displayName"
              :value="item.skillName"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="MCP 服务">
          <el-select v-model="form.mcpNames" multiple filterable clearable placeholder="不挂 MCP" style="width: 100%">
            <el-option
              v-for="item in usableMcp"
              :key="item.serverName"
              :label="item.displayName"
              :value="item.serverName"
            >
              <span class="row">
                <span>{{ item.displayName }}</span>
                <span class="spacer" />
                <span class="hint mono">{{ item.serverName }}</span>
              </span>
            </el-option>
          </el-select>
        </el-form-item>
      </div>

      <div class="wiz__sec">
        <h3>运行时</h3>
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
          <!--
            下拉而不是输入框：后端只判这一列"非不非空"，值的内容不参与任何逻辑，
            让手输一个字符串既没有意义、又容易让人以为填的是表名。
            表名取 state_table，为空回落 agent 名，页面上选不了。
          -->
          <el-select v-model="form.stateStore" style="width: 100%">
            <el-option
              v-for="item in STATE_STORE_OPTIONS"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>
      </div>
    </el-form>

    <ul v-if="wizardProblems.length > 0" class="wiz__problems">
      <li v-for="item in wizardProblems" :key="item">{{ item }}</li>
    </ul>

    <template #footer>
      <div class="row wiz__ft">
        <el-checkbox v-model="publishOnCreate">创建后立即发布</el-checkbox>
        <span class="spacer" />
        <el-button @click="wizardOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="createMutation.isPending.value"
          :disabled="wizardProblems.length > 0"
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
.wiz__sec {
  padding-top: var(--s4);
  margin-top: var(--s4);
  border-top: 1px solid var(--bd-soft);
}
.wiz__sec h3 {
  margin-bottom: var(--s3);
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
