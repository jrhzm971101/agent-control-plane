<script setup lang="ts">
/*
 * Agent 详情：按域分区编辑一束行（身份 / 引用 / 运行时 / 记忆 / 工作区 / 子 Agent）。
 *
 * <h2>一、为什么是「表单」而不是「配置清单 + 只读说明」</h2>
 * 这一页是 agent 的唯一编辑入口：库里那 6 张表的每一列都要能在这里改到，
 * 否则就得回去写 SQL，而写 SQL 的路径不经过校验（引用完整性、类型与字段匹配都在
 * 保存接口里）。所以页面的完整度直接等于治理的完整度。
 *
 * <h2>二、三态开关必须渲染成三选</h2>
 * 「未设置 / 开启 / 关闭」在装配期是三种不同结果：未设置不下发 setter（框架改默认值
 * 平台跟着变），关闭则把当前默认值钉死。用复选框渲染会把 null 一保存写成 false ——
 * 那一刻框架的默认值就永久失效了，而且没有任何地方会提示。见 TriStateSelect。
 *
 * <h2>三、REACT 与 HARNESS 不是两套页面</h2>
 * 同一份行束，只是哪些域有内容不同：REACT 没有 memory 与 workspace，也没有子 agent。
 * 页面按类型隐藏这些域，同时在后端校验之外把"配了也不生效"的字段直接藏起来 ——
 * 例如 HARNESS 上的 conflict-policy、REACT 上的 13 个 disable-* 开关。
 * 隐藏的域保存时一律提交 null，而不是提交一堆空对象（空对象在库里是"有行"）。
 *
 * <h2>四、保存 / 发布 / 回滚的分工</h2>
 * 保存 = 落库（草稿），agent 行为不变；
 * 发布 = 装配实例（引用它的其它 agent 也会被重建）+ 写版本快照；
 * 回滚 = 写库、不装配，要生效得再发布一次。
 */
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  agentVersions,
  deleteAgent,
  getAgent,
  listAgents,
  listMcpServers,
  listModels,
  listMiddlewareCatalog,
  listPrompts,
  listSkills,
  listToolCatalog,
  publishAgent,
  reloadAgent,
  rollbackAgent,
  saveAgent,
} from '@/api/controlplane';
import type {
  AgentDefinitionBundle,
  AgentMemoryEntity,
  AgentRuntimeEntity,
  AgentSubAgentEntity,
  AgentWorkspaceEntity,
  TriState,
} from '@/api/controlplane/types';
import { notifyFailure, notifyPublish, notifySuccess } from '@/features/controlplane/feedback';
import { editableCopy } from '@/lib/clone';
import { STATE_STORE_OPTIONS, normalizeStateStore } from '@/lib/stateStore';
import { queryKeys } from '@/lib/queryKeys';
import {
  chatLink,
  mcpLink,
  middlewareLink,
  promptsLink,
  sessionsLink,
  skillsLink,
  storageLink,
  toolsLink,
  tracesLink,
  workspaceLink,
} from '@/lib/links';
import { modelSelectOptions, withCurrentModel } from '@/lib/modelOptions';
import PageHeader from '@/components/ui/PageHeader.vue';
import PaneCard from '@/components/ui/PaneCard.vue';
import AppCard from '@/components/ui/AppCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import TriStateSelect from '@/components/ui/TriStateSelect.vue';
import JsonField from '@/components/ui/JsonField.vue';
import VersionsPanel from '@/components/controlplane/VersionsPanel.vue';

const props = defineProps<{ agentId: string }>();
const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();

const { data: bundle, isLoading, error } = useQuery({
  queryKey: computed(() => queryKeys.agent(props.agentId)),
  queryFn: () => getAgent(props.agentId),
});

/** 编辑副本：抽屉外的一切只读，改动都在这里累积，保存时整束提交。 */
const draft = ref<AgentDefinitionBundle | null>(null);

/**
 * 整束 → 可编辑草稿。两件事一起做，因为它们都是"数据进编辑态之前必须完成"的转换：
 *
 * <ol>
 *   <li><b>脱代理</b>：vue-query 的 data 是 reactive 代理，直接 structuredClone
 *       会抛 DataCloneError（"#<Object> could not be cloned."），整页白屏。</li>
 *   <li><b>归一化状态存储</b>：库里那一列可能还是历史遗留的任意串（早期存的是文件目录路径），
 *       而这里的下拉只认 'mysql' / ''。不归一化就会显示成空白 —— 看起来像"没开"，
 *       用户顺手一点保存就把这一列真正的语义改掉了。见 lib/stateStore.ts。</li>
 * </ol>
 */
function toDraft(value: AgentDefinitionBundle): AgentDefinitionBundle {
  const copy = editableCopy(value);
  if (copy.runtime) {
    copy.runtime.stateStore = normalizeStateStore(copy.runtime.stateStore);
  }
  return copy;
}

watch(
  bundle,
  (value) => {
    draft.value = value ? toDraft(value) : null;
  },
  { immediate: true },
);

const activeTab = ref(typeof route.query.tab === 'string' ? route.query.tab : 'identity');
watch(activeTab, (tab) => {
  void router.replace({ query: { ...route.query, tab } });
});

const isHarness = computed(() => draft.value?.agent.agentType === 'HARNESS');
/*
 * 返回目标由「从哪个列表进来的」决定，而不是由 agent 类型决定。
 *
 * <p>同一个组件挂在两条路由上（/agents/:agentId 与 /harness/:agentId），
 * 用户在 Agents 列表里翻到 harness 的卡片时也应该能点进来看，
 * 这时按类型硬跳到 /harness 会让他丢掉原来的浏览位置。
 */
const backTarget = computed(() =>
  route.name === 'harness-detail'
    ? { path: '/harness', label: '返回 Harness 工作台' }
    : { path: '/agents', label: '返回 Agents' },
);
/**
 * 相关页面 —— 这一条 agent 在别处留下的东西。
 *
 * <p>这些入口是**离开**这一页去看运行结果，与右上角改定义的动作性质不同。
 * 页头只保留「去对话」这一最常用入口，其余收进「更多」菜单，
 * 既不让四个导航词与发布/删除抢注意力，也不丢掉任何入口。
 *
 * <p>记忆落到状态存储的**列表页**而不是某张表：表名 = state_table ?: agent 名（见 lib/stateStore.ts），
 * 而 state_table 没有页面入口、前端类型里也没有这一列 —— 凭 agent 名猜表名，
 * 在"表名被显式配过"或"改名留下的残留表"这两种情况下会跳到一张不存在的表上。
 * 列表页有「归属 agent」一列，落点明确、永远正确，多花一次点击换掉一类静默跳错。
 *
 * <p>工作区只给 HARNESS：REACT 没有 workspace 行，跳过去只会看到"地址里的 agent 不在工作区清单里"。
 */
const relatedLinks = computed<Array<{ label: string; to: string }>>(() => {
  const name = props.agentId;
  if (!name) return [];
  const items = [
    { label: '去对话', to: chatLink(name) },
    { label: '执行链路', to: tracesLink({ agentId: name }) },
    { label: '会话记录', to: sessionsLink({ agentId: name }) },
    { label: '记忆', to: storageLink() },
  ];
  if (isHarness.value) items.push({ label: '工作区', to: workspaceLink(name) });
  return items;
});
const chatPath = computed(() => (props.agentId ? chatLink(props.agentId) : ''));
const moreLinks = computed(() => relatedLinks.value.filter((item) => item.label !== '去对话'));

function handleMoreCommand(command: string): void {
  if (command.startsWith('link:')) {
    void router.push(command.slice(5));
    return;
  }
  if (command === 'reload') {
    reloadMutation.mutate();
    return;
  }
  if (command === 'delete') void confirmDelete();
}

const rt = computed(() => draft.value?.runtime ?? null);
const ws = computed(() => draft.value?.workspace ?? null);
const mm = computed(() => draft.value?.memory ?? null);
const ref0 = computed(() => draft.value?.ref ?? null);

// ==================== 可选引用项 ====================

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
/** 其它 agent 名：子 agent 只能是库里已存在的 agent（不自引用、不重复由校验兜）。 */
const { data: agentRows } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

const usableMcp = computed(() => (mcpServers.value ?? []).filter((row) => row.enabled !== false));
const subAgentOptions = computed(() =>
  (agentRows.value ?? [])
    // 只允许 REACT 当子 agent：子 agent 是"被派发的执行体"，harness 是"编排体"，角色不重叠。
    // 后端也做同一条校验（ControlPlaneValidator 规则 6），这里过滤是为了不让用户先选中再被拒。
    .filter((row) => row.agentType === 'REACT')
    // 回 { name, displayName } 而不是只回名字：下拉里给人看的是展示名，
    // 而 v-model 绑的 subName 必须是名字（后端拿它去 selectById 查子 agent）。
    .map((row) => ({ name: row.agentName, displayName: row.displayName || row.agentName }))
    .filter((item) => item.name !== props.agentId)
    .sort((a, b) => a.name.localeCompare(b.name)),
);

// ==================== 引用分组：页面只露数量，明细进弹窗 ====================

type RefKind = 'prompt' | 'tools' | 'middleware' | 'skills' | 'mcp';

interface RefGroupMeta {
  kind: RefKind;
  title: string;
  link: string;
}

const REF_GROUPS: RefGroupMeta[] = [
  { kind: 'prompt', title: 'Prompt', link: promptsLink() },
  { kind: 'tools', title: '工具', link: toolsLink() },
  { kind: 'middleware', title: 'Middleware', link: middlewareLink() },
  { kind: 'skills', title: 'Skill', link: skillsLink() },
  { kind: 'mcp', title: 'MCP 服务', link: mcpLink() },
];

function refValues(kind: RefKind): string[] {
  const row = ref0.value;
  if (!row) return [];
  if (kind === 'prompt') return row.promptKey ? [row.promptKey] : [];
  if (kind === 'tools') return row.tools ?? [];
  if (kind === 'middleware') return row.middleware ?? [];
  if (kind === 'skills') return row.skillNames ?? [];
  return row.mcpNames ?? [];
}

function refCount(kind: RefKind): number {
  return refValues(kind).length;
}

const refGroups = computed(() =>
  REF_GROUPS.map((group) => ({ ...group, count: refCount(group.kind) })),
);

const activeRefKind = ref<RefKind | null>(null);
const refDialogOpen = computed({
  get: () => activeRefKind.value !== null,
  set: (open: boolean) => {
    if (!open) activeRefKind.value = null;
  },
});

const activeRefGroup = computed(
  () => REF_GROUPS.find((group) => group.kind === activeRefKind.value) ?? null,
);

const activePromptKey = computed<string>({
  get: () => ref0.value?.promptKey ?? '',
  set: (value) => {
    const row = ref0.value;
    if (!row) return;
    row.promptKey = value || null;
  },
});

const activeRefValues = computed<string[]>({
  get: () => (activeRefKind.value ? refValues(activeRefKind.value) : []),
  set: (value) => {
    const row = ref0.value;
    const kind = activeRefKind.value;
    if (!row || !kind) return;
    const next = value.length ? value : null;
    if (kind === 'tools') row.tools = next;
    else if (kind === 'middleware') row.middleware = next;
    else if (kind === 'skills') row.skillNames = next;
    else if (kind === 'mcp') row.mcpNames = next;
  },
});

interface RefOption {
  value: string;
  label: string;
  note?: string;
}

const activeRefOptions = computed<RefOption[]>(() => {
  switch (activeRefKind.value) {
    case 'prompt':
      return (prompts.value ?? []).map((item) => ({
        value: item.promptKey,
        label: item.displayName,
        note: item.promptKey,
      }));
    case 'tools':
      return (tools.value ?? []).map((item) => ({
        value: item.beanName,
        label: item.name,
        note: item.beanName,
      }));
    case 'middleware':
      return (middleware.value ?? []).map((item) => ({
        value: item.beanName,
        label: item.simpleName,
        note: item.beanName,
      }));
    case 'skills':
      return (skills.value ?? []).map((item) => ({
        value: item.skillName,
        label: item.displayName,
        note: item.skillName,
      }));
    case 'mcp':
      return usableMcp.value.map((item) => ({
        value: item.serverName,
        label: item.displayName,
        note: item.serverName,
      }));
    default:
      return [];
  }
});

// ==================== 三态开关的清单 ====================

/**
 * 只挑出「类型正好是 TriState」的键。
 *
 * 这样清单本身就有类型保证：往数组里加一个 Boolean 的字段会直接编译不过，
 * 而不是等运行时把 null 写成 false 才发现（那正是这一页最怕的事）。
 */
type TriStateKey<T> = { [K in keyof T]-?: T[K] extends TriState ? K : never }[keyof T];

const runtimeToggles: Array<{ key: TriStateKey<AgentRuntimeEntity>; label: string; hint?: string }> = [
  { key: 'checkRunning', label: 'check-running', hint: '工具调用前的运行态检查' },
  { key: 'stopOnReject', label: 'stop-on-reject', hint: '权限被拒时是否终止本轮' },
  { key: 'enableMetaTool', label: 'enable-meta-tool' },
  { key: 'enableTaskList', label: 'enable-task-list' },
  { key: 'enablePendingToolRecovery', label: 'enable-pending-tool-recovery' },
  { key: 'longTermMemoryAsync', label: 'long-term-memory-async' },
];

const compactionToggles: Array<{ key: TriStateKey<AgentMemoryEntity>; label: string }> = [
  { key: 'flushBeforeCompact', label: 'flush-before-compact' },
  { key: 'offloadBeforeCompact', label: 'offload-before-compact' },
  { key: 'evictDisabled', label: 'evict-disabled' },
];

/** 13 个能力裁剪开关。它们全部属于 harness 链，REACT 上配了不生效（校验会拒）。 */
const workspaceToggles: Array<{ key: TriStateKey<AgentWorkspaceEntity>; label: string }> = [
  { key: 'useLegacyXmlWorkspaceContext', label: 'use-legacy-xml-workspace-context' },
  { key: 'agentTracingLogEnabled', label: 'agent-tracing-log-enabled' },
  { key: 'enablePlanMode', label: 'enable-plan-mode' },
  { key: 'planModeAllowShell', label: 'plan-mode-allow-shell' },
  { key: 'skillsEnabled', label: 'skills-enabled' },
  { key: 'skillManageToolEnabled', label: 'skill-manage-tool-enabled' },
  { key: 'disableFilesystemTools', label: 'disable-filesystem-tools' },
  { key: 'disableShellTool', label: 'disable-shell-tool' },
  { key: 'disableMemoryTools', label: 'disable-memory-tools' },
  { key: 'disableMemoryHooks', label: 'disable-memory-hooks' },
  { key: 'disableTranscript', label: 'disable-transcript' },
  { key: 'disableSessionPersistence', label: 'disable-session-persistence' },
  { key: 'disableWorkspaceContext', label: 'disable-workspace-context' },
  { key: 'disableAtPathExpansion', label: 'disable-at-path-expansion' },
  { key: 'disableSubagents', label: 'disable-subagents' },
  { key: 'disableDynamicSubagents', label: 'disable-dynamic-subagents' },
  { key: 'disableDynamicSkills', label: 'disable-dynamic-skills' },
  { key: 'disableDefaultWorkspaceSkills', label: 'disable-default-workspace-skills' },
  { key: 'disableToolsConfig', label: 'disable-tools-config' },
  // 强制子 agent 同步执行：编排型 agent 常常"必须等子 agent 结果回来才能继续"，
  // 而框架默认让模型自己填 timeout_seconds（还可能同步超时后自动转后台），不可控。
  { key: 'subagentForceSync', label: 'subagent-force-sync' },
];

/**
 * REACT 专有的三项技能策略（都出自框架的 ReActAgent.Builder，HarnessAgent.Builder 上没有对应方法）。
 *
 * 它们 2026-09-22 从 md_agent_workspace 迁到了 md_agent_runtime，所以键类型跟着换成 runtime 实体，
 * 渲染位置也换到「运行时」页 —— 之前它们落在 HARNESS 专有的「工作区」页里，
 * 而那一页对 REACT 是整体隐藏的，结果是这三项在页面上根本改不到（后端认、装配读、页面没有入口）。
 */
const reactOnlySkillToggles: Array<{ key: TriStateKey<AgentRuntimeEntity>; label: string }> = [
  { key: 'dynamicSkillsEnabled', label: 'dynamic-skills-enabled' },
  { key: 'skillCodeExecutionEnabled', label: 'skill-code-execution-enabled' },
];

const JSON_FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'generateOptions', label: 'generate-options', hint: 'GenerateOptions' },
  { key: 'modelExecutionConfig', label: 'model-execution-config', hint: 'ModelExecutionConfig' },
  { key: 'toolExecutionConfig', label: 'tool-execution-config', hint: 'ToolExecutionConfig' },
  { key: 'retrieveConfig', label: 'retrieve-config', hint: 'RetrieveConfig' },
  { key: 'permission', label: 'permission', hint: 'PermissionContextState' },
];
/**
 * 三态开关与 JSON 列的通用存取。
 *
 * 清单本身用 TriStateKey 做了编译期收窄（见上），但存取这里刻意用 string 索引：
 * 模板里对一个"联合键"赋值时 TS 会把写入类型收成 never，为了绕开它写一堆断言
 * 反而会把真正的类型错误藏起来。清单负责"只能列三态字段"，存取负责"能跑"。
 */
function toggleValue(host: object | null | undefined, key: string): TriState {
  const value = (host as Record<string, TriState> | null | undefined)?.[key];
  return value ?? null;
}

function setToggle(host: object | null | undefined, key: string, value: TriState) {
  if (!host) return;
  (host as Record<string, TriState>)[key] = value;
}


function jsonValue(host: object | null | undefined, key: string): Record<string, unknown> | null {
  const value = (host as Record<string, unknown> | null | undefined)?.[key];
  return (value as Record<string, unknown> | null) ?? null;
}

function setJson(host: object | null | undefined, key: string, value: Record<string, unknown> | null) {
  if (!host) return;
  (host as Record<string, unknown>)[key] = value;
}

/** 五列 JSON 各自的解析状态。任一列在编辑中语法不合法时禁止保存。 */
const jsonValid = ref<Record<string, boolean>>({});
const jsonAllValid = computed(() => Object.values(jsonValid.value).every(Boolean));

/**
 * 身份域的必填项。
 *
 * <p>displayName 是必填（后端 validateAgentContent 也拦），而它不在 jsonAllValid 的覆盖面里 ——
 * 少了这一条，用户会以为"页面没报错 = 能保存"，然后在最后一次往返上吃到一句后端 400。
 *
 * <p>保存与发布共用同一道闸：发布本来就会先保存（见 publishMutation 的注释），
 * 让两个按钮的判断不一致，只会制造"点保存不报错、点发布才报错"这种看起来像 bug 的现象。
 */
const identityProblems = computed(() => {
  const problems: string[] = [];
  if (!draft.value?.agent?.displayName?.trim()) problems.push('显示名不能为空');
  return problems;
});

// ==================== 类型 ====================
//
// 类型创建后不可变更（后端 saveAgent 里强制），所以这里没有"切换类型"的逻辑。
// 原先那套 onTypeChange 要在切换的瞬间清掉另一条链的域（workspace / memory / 子 agent），
// 而那是把数据完整性放在了前端 —— API 直调、脚本、并发编辑都能绕过它，
// 留下"类型是 REACT 却带着 workspace 行"这种要很久以后才暴露的脏数据。
// 现在类型只在「身份」页只读展示；要另一种形态，去对应入口新建。

// ==================== 子 Agent ====================

function blankSubAgent(sortOrder: number): AgentSubAgentEntity {
  return {
    subName: '',
    sortOrder,
    subDescription: null,
    workspaceMode: null,
    workspacePath: null,
    inlineAgentsBody: null,
    modelRef: null,
    maxIters: null,
    steps: null,
    temperature: null,
    topP: null,
    variant: null,
    mode: null,
    hidden: null,
    persistSession: null,
    inheritParentPermissions: null,
    exposeToUser: null,
    tools: null,
    skills: null,
    remote: null,
    url: null,
    headers: null,
    remoteStreaming: null,
    remoteStreamDetail: null,
    remoteAskPolicy: null,
    remoteContextAttributes: null,
  };
}

function addSubAgent() {
  const rows = draft.value?.subAgents ?? [];
  draft.value!.subAgents = [...rows, blankSubAgent(rows.length)];
}

function removeSubAgent(index: number) {
  const rows = [...(draft.value?.subAgents ?? [])];
  rows.splice(index, 1);
  // sortOrder 重排：它决定 harness 呈现给模型的先后，空洞会让顺序变得不可预期
  draft.value!.subAgents = rows.map((row, i) => ({ ...row, sortOrder: i }));
}

function moveSubAgent(index: number, delta: number) {
  const rows = [...(draft.value?.subAgents ?? [])];
  const target = index + delta;
  if (target < 0 || target >= rows.length) return;
  [rows[index], rows[target]] = [rows[target], rows[index]];
  draft.value!.subAgents = rows.map((row, i) => ({ ...row, sortOrder: i }));
}

// ==================== 版本 ====================

const { data: versions, isLoading: versionsLoading } = useQuery({
  queryKey: computed(() => queryKeys.resourceVersions('agent', props.agentId)),
  queryFn: () => agentVersions(props.agentId),
});

// ==================== 写操作 ====================

const saveMutation = useMutation({
  mutationFn: () => saveAgent(props.agentId, draft.value!),
  onSuccess: (saved) => {
    // 后端回的是「落库后的权威整束」，用它替换草稿 = 立刻反映服务端补齐的字段
    // （version 自增、publishedVersion 归位）。同样要脱代理，理由同上。
    draft.value = toDraft(saved);
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess('已保存为草稿');
  },
  onError: (err) => notifyFailure(err, '保存失败'),
});

/**
 * 发布 = 先保存再发布。
 *
 * 不能只发布不保存：页面上的改动还在草稿里，直接发布会把"上一次保存的内容"装配出去，
 * 而用户以为发的是屏幕上这一份 —— 这类误会最难发现（页面上看着是新的，线上是旧的）。
 */
const publishMutation = useMutation({
  mutationFn: async () => {
    await saveMutation.mutateAsync();
    return publishAgent(props.agentId, changeNote.value || undefined);
  },
  onSuccess: (result) => {
    changeNote.value = '';
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agent(props.agentId) });
    void queryClient.invalidateQueries({ queryKey: ['versions'] });
    notifyPublish(result);
  },
  onError: (err) => notifyFailure(err, '发布失败'),
});

const rollbackMutation = useMutation({
  mutationFn: (version: number) => rollbackAgent(props.agentId, version),
  onSuccess: (_r, version) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agent(props.agentId) });
    void queryClient.invalidateQueries({ queryKey: ['versions'] });
    notifySuccess(`已回滚到 v${version}`);
  },
  onError: (err) => notifyFailure(err, '回滚失败'),
});

const reloadMutation = useMutation({
  mutationFn: () => reloadAgent(props.agentId),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess('已重建实例');
  },
  onError: (err) => notifyFailure(err, '重建失败'),
});

const deleteMutation = useMutation({
  mutationFn: () => deleteAgent(props.agentId),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    notifySuccess('已删除');
    void router.push('/agents');
  },
  onError: (err) => notifyFailure(err, '删除失败'),
});

const busy = computed(
  () => saveMutation.isPending.value || publishMutation.isPending.value || deleteMutation.isPending.value,
);

/** 发布时写入快照的变更说明。 */
const changeNote = ref('');

/**
 * 状态口语化。
 *
 * status 只说「有没有未发布改动」，loaded 才说「实例在不在」。
 * 两者必须一起读：页面上写着"已发布"而实例其实是旧的，是最容易误判线上行为的情况。
 */
function statusText(): string {
  const row = draft.value;
  if (!row) return '';
  if (row.agent.enabled === false) return '已停用';
  const base =
    row.agent.status === 'PUBLISHED'
      ? '已发布'
      : row.agent.publishedVersion === null
        ? '未发布'
        : '有改动待发布';
  if (row.agent.publishedVersion === null) return base;
  return row.agent.status === 'PUBLISHED' ? base : `${base} · 线上是 v${row.agent.publishedVersion}`;
}

function statusTone(): 'ok' | 'off' | 'rw' {
  const row = draft.value;
  if (!row) return 'rw';
  if (row.agent.enabled === false) return 'off';
  return row.agent.status === 'PUBLISHED' ? 'ok' : 'rw';
}

async function confirmDelete() {
  try {
    await ElMessageBox.confirm(
      `删除「${props.agentId}」会同时删掉它的引用、运行时、记忆、工作区与子 agent 行，不可恢复。`,
      '删除 Agent',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  deleteMutation.mutate();
}

async function confirmRollback(version: number) {
  try {
    await ElMessageBox.confirm(
      `把整束行回滚到 v${version}？会生成一个新版本，线上实例要再发布一次才会变。`,
      '回滚版本',
      { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  rollbackMutation.mutate(version);
}
</script>

<template>
  <!--
    面包屑放在三个分支之外：详情页的失败态是一行裸文案时，用户手里没有返回入口。
    数据没到也要能退出去。
  -->
  <div class="row breadcrumb">
    <el-button size="small" @click="router.push(backTarget.path)">← {{ backTarget.label }}</el-button>
    <span class="hint">/</span>
    <span class="hint">{{ agentId }}</span>
  </div>

  <div v-if="isLoading" class="loading">加载中…</div>
  <AppCard v-else-if="error">
    <EmptyState :title="`读不到 Agent「${agentId}」`" :hint="(error as Error).message">
      <template #action>
        <el-button type="primary" @click="router.push(backTarget.path)">{{ backTarget.label }}</el-button>
      </template>
    </EmptyState>
  </AppCard>

  <template v-else-if="draft">
    <PageHeader :title="draft.agent.displayName">
      <template #meta>
        <div class="row badges">
          <AppBadge :variant="isHarness ? 'harness' : 'react'">{{ draft.agent.agentType }}</AppBadge>
          <AppBadge :variant="statusTone()">{{ statusText() }}</AppBadge>
          <span class="hint mono">v{{ draft.agent.version ?? 1 }}</span>
          <!-- agent-name 降为次要索引：路由、子 agent 引用、channel 兜底、run 记录里出现的都是它 -->
          <span class="hint mono">{{ draft.agent.agentName }}</span>
        </div>
      </template>
      <template #actions>
        <el-button :disabled="!chatPath" @click="router.push(chatPath)">
          去对话
        </el-button>
        <el-button :loading="busy" :disabled="identityProblems.length > 0" @click="saveMutation.mutate()">
          保存草稿
        </el-button>
        <el-button
          type="primary"
          :loading="busy"
          :disabled="!jsonAllValid || identityProblems.length > 0"
          @click="publishMutation.mutate()"
        >
          发布
        </el-button>
        <el-dropdown trigger="click" popper-class="agent-more-menu" @command="handleMoreCommand">
          <el-button :disabled="busy">
            更多
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="item in moreLinks"
                :key="item.label"
                :command="`link:${item.to}`"
              >
                {{ item.label }}
              </el-dropdown-item>
              <el-dropdown-item
                divided
                command="reload"
                :disabled="reloadMutation.isPending.value"
              >
                重建实例
              </el-dropdown-item>
              <el-dropdown-item divided command="delete" :disabled="busy" class="is-danger">
                删除
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </PageHeader>

    <AppNote v-if="!jsonAllValid" tone="warn" class="mb">
      有 JSON 配置项还在编辑中（语法不合法）。修好之前不能保存 —— 否则那一列会被写成空。
    </AppNote>

    <AppNote v-if="identityProblems.length > 0" tone="warn" class="mb">
      {{ identityProblems.join('；') }}（在「身份」页补上）
    </AppNote>

    <el-tabs v-model="activeTab">
      <!-- ============ 身份 ============ -->
      <el-tab-pane label="身份" name="identity">
        <PaneCard title="主表（md_agent）">
          <el-form label-position="top">
            <div class="f2">
              <el-form-item label="agent-name">
                <el-input :model-value="draft.agent.agentName" disabled class="mono" />
              </el-form-item>
              <el-form-item label="类型">
                <el-input :model-value="draft.agent.agentType" disabled class="mono" />
              </el-form-item>
            </div>

            <el-form-item label="显示名">
              <el-input v-model="draft.agent.displayName" placeholder="例如 企微报表助手" />
            </el-form-item>

            <el-form-item label="描述">
              <el-input v-model="draft.agent.description" placeholder="请输入说明" />
            </el-form-item>

            <div class="f2">
              <el-form-item label="能力分组">
                <el-input v-model="draft.agent.category" placeholder="例如 运维 / 企微" />
              </el-form-item>
              <el-form-item label="业务标签">
                <el-select
                  v-model="draft.agent.bizTags"
                  multiple
                  filterable
                  allow-create
                  default-first-option
                  :reserve-keyword="false"
                  placeholder="回车创建一个标签"
                  style="width: 100%"
                >
                  <el-option v-for="tag in draft.agent.bizTags ?? []" :key="tag" :label="tag" :value="tag" />
                </el-select>
              </el-form-item>
            </div>

            <el-form-item label="参与装配">
              <el-switch v-model="draft.agent.enabled" active-text="启用" inactive-text="停用" />
            </el-form-item>
          </el-form>
        </PaneCard>
      </el-tab-pane>

      <!-- ============ 引用 ============ -->
      <el-tab-pane label="引用" name="refs">
        <PaneCard title="引用（md_agent_ref）">
          <template v-if="ref0">
            <div class="refs">
              <button
                v-for="group in refGroups"
                :key="group.kind"
                type="button"
                class="refcard"
                @click="activeRefKind = group.kind"
              >
                <span class="refcard__hd">
                  <span class="refcard__ttl">{{ group.title }}</span>
                  <span class="refcard__arw" aria-hidden="true">›</span>
                </span>
                <span class="refcard__main">
                  <b class="refcard__num">{{ group.count }}</b>
                  <span class="refcard__unit">{{ group.count ? '已绑定' : '未绑定' }}</span>
                </span>
              </button>
            </div>

            <AppNote v-if="ref0.knowledges?.length" class="mt" tone="warn">
              存在已废弃的 <b>knowledges</b> 引用，装配时不会生效。
            </AppNote>
          </template>
          <EmptyState v-else title="这条 agent 没有引用行" />
        </PaneCard>
      </el-tab-pane>
      <!-- ============ 运行时 ============ -->
      <el-tab-pane label="运行时" name="runtime">
        <div class="stack">
          <PaneCard title="模型与迭代（md_agent_runtime）">
            <el-form v-if="rt" label-position="top">
              <div class="f2">
                <el-form-item label="主模型（model-ref）">
                  <el-select
                    v-model="rt.modelRef"
                    filterable
                    clearable
                    placeholder="未设置"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="item in modelOptionsFor(rt.modelRef)"
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
                <el-form-item label="兜底模型（fallback-model-ref）">
                  <el-select
                    v-model="rt.fallbackModelRef"
                    filterable
                    clearable
                    placeholder="未设置"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="item in modelOptionsFor(rt.fallbackModelRef)"
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
              </div>
              <div class="f3">
                <el-form-item label="reasoning-effort">
                  <el-select v-model="rt.reasoningEffort" clearable placeholder="未设置" style="width: 100%">
                    <el-option label="low" value="low" />
                    <el-option label="medium" value="medium" />
                    <el-option label="high" value="high" />
                  </el-select>
                </el-form-item>
                <el-form-item label="最大迭代轮数">
                  <el-input-number v-model="rt.maxIters" :min="1" style="width: 100%" />
                </el-form-item>
                <el-form-item label="最大重试次数">
                  <el-input-number v-model="rt.maxRetries" :min="0" style="width: 100%" />
                </el-form-item>
              </div>
              <el-form-item label="最大上下文 token（HARNESS 用）">
                <el-input-number v-model="rt.maxContextTokens" :min="0" :step="1000" style="width: 100%" />
              </el-form-item>
            </el-form>
          </PaneCard>

          <PaneCard title="状态与记忆">
            <el-form v-if="rt" label-position="top">
              <div class="f2">
                <el-form-item label="状态存储标记">
                  <!-- 下拉：这一列只判非空，手输字符串没有意义（见 lib/stateStore.ts 的说明） -->
                  <el-select v-model="rt.stateStore" style="width: 100%">
                    <el-option
                      v-for="item in STATE_STORE_OPTIONS"
                      :key="item.value"
                      :label="item.label"
                      :value="item.value"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="默认会话 id">
                  <el-input v-model="rt.defaultSessionId" class="mono" />
                </el-form-item>
              </div>
              <div class="f3">
                <el-form-item label="长期记忆模式">
                  <el-select v-model="rt.longTermMemoryMode" clearable placeholder="未设置" style="width: 100%">
                    <el-option label="AGENT_CONTROL" value="AGENT_CONTROL" />
                    <el-option label="STATIC_CONTROL" value="STATIC_CONTROL" />
                    <el-option label="BOTH" value="BOTH" />
                  </el-select>
                </el-form-item>
                <el-form-item label="RAG 模式">
                  <el-input v-model="rt.ragMode" class="mono" />
                </el-form-item>
                <el-form-item v-if="!isHarness" label="冲突策略（REACT 专有）">
                  <el-select v-model="rt.conflictPolicy" clearable placeholder="未设置" style="width: 100%">
                    <el-option label="OVERWRITE" value="OVERWRITE" />
                    <el-option label="FAIL" value="FAIL" />
                    <el-option label="APPEND_MERGE" value="APPEND_MERGE" />
                  </el-select>
                </el-form-item>
              </div>
            </el-form>
          </PaneCard>

          <!-- REACT 专有的技能策略：三项同住 md_agent_runtime，所以放在这一页 -->
          <PaneCard v-if="!isHarness" title="技能策略（REACT 专有）">
            <div v-if="rt" class="toggles">
              <div v-for="item in reactOnlySkillToggles" :key="item.key" class="toggles__row">
                <div class="toggles__lb">
                  <span class="mono">{{ item.label }}</span>
                </div>
                <TriStateSelect
                  :model-value="toggleValue(rt, item.key)"
                  @update:model-value="(value) => setToggle(rt, item.key, value)"
                />
              </div>
              <div class="toggles__row">
                <div class="toggles__lb">
                  <span class="mono">skill-work-dir</span>
                </div>
                <el-input v-model="rt.skillWorkDir" class="mono" placeholder="默认目录" />
              </div>
            </div>
          </PaneCard>

          <PaneCard title="行为开关">
            <div v-if="rt" class="toggles">
              <div v-for="item in runtimeToggles" :key="item.key" class="toggles__row">
                <div class="toggles__lb">
                  <span class="mono">{{ item.label }}</span>
                </div>
                <TriStateSelect
                  :model-value="toggleValue(rt, item.key)"
                  @update:model-value="(value) => setToggle(rt, item.key, value)"
                />
              </div>
            </div>
          </PaneCard>

          <PaneCard title="结构化配置">
            <div class="stack">
              <div v-for="field in JSON_FIELDS" :key="field.key">
                <div class="row jf__hd">
                  <span class="mono strong">{{ field.label }}</span>
                </div>
                <JsonField
                  :model-value="jsonValue(rt, field.key)"
                  :rows="4"
                  @update:model-value="(value) => setJson(rt, field.key, value)"
                  @update:valid="(ok) => (jsonValid[field.key] = ok)"
                />
              </div>
            </div>
          </PaneCard>
        </div>
      </el-tab-pane>

      <!-- ============ 上下文与记忆（HARNESS） ============ -->
      <el-tab-pane v-if="isHarness" label="上下文与记忆" name="memory">
        <div class="stack">
          <PaneCard title="上下文压缩">
            <el-form v-if="mm" label-position="top">
              <el-form-item label="禁用压缩（compaction-disabled，非三态开关）">
                <el-switch v-model="mm.compactionDisabled" />
              </el-form-item>
              <div class="f3">
                <el-form-item label="触发轮数（trigger-messages）">
                  <el-input-number v-model="mm.triggerMessages" :min="1" style="width: 100%" />
                </el-form-item>
                <el-form-item label="触发 token（trigger-tokens）">
                  <el-input-number v-model="mm.triggerTokens" :min="1" :step="1000" style="width: 100%" />
                </el-form-item>
                <el-form-item label="保留余量（reserved）">
                  <el-input-number v-model="mm.reserved" :min="0" style="width: 100%" />
                </el-form-item>
              </div>
              <div class="f3">
                <el-form-item label="保留轮数（keep-messages）">
                  <el-input-number v-model="mm.keepMessages" :min="0" style="width: 100%" />
                </el-form-item>
                <el-form-item label="保留 token（keep-tokens）">
                  <el-input-number v-model="mm.keepTokens" :min="0" style="width: 100%" />
                </el-form-item>
                <el-form-item label="压缩用模型（compaction-model-ref）">
                  <el-select
                    v-model="mm.compactionModelRef"
                    filterable
                    clearable
                    placeholder="未设置"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="item in modelOptionsFor(mm.compactionModelRef)"
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
              </div>
              <div class="f3">
                <el-form-item label="保留 token 下限">
                  <el-input-number v-model="mm.keepTokensMin" :min="0" style="width: 100%" />
                </el-form-item>
                <el-form-item label="保留 token 上限">
                  <el-input-number v-model="mm.keepTokensMax" :min="0" style="width: 100%" />
                </el-form-item>
                <el-form-item label="保留比例（keep-tokens-ratio）">
                  <el-input-number
                    v-model="mm.keepTokensRatio"
                    :min="0"
                    :max="1"
                    :step="0.05"
                    :precision="3"
                    style="width: 100%"
                  />
                </el-form-item>
              </div>
              <el-form-item label="压缩提示词（summary-prompt）">
                <el-input v-model="mm.summaryPrompt" type="textarea" :rows="4" resize="vertical" />
              </el-form-item>
              <div class="toggles">
                <div v-for="item in compactionToggles" :key="item.key" class="toggles__row">
                  <div class="toggles__lb"><span class="mono">{{ item.label }}</span></div>
                  <TriStateSelect
                    :model-value="toggleValue(mm, item.key)"
                    @update:model-value="(value) => setToggle(mm, item.key, value)"
                  />
                </div>
              </div>
            </el-form>
          </PaneCard>

          <PaneCard title="长期记忆">
            <el-form v-if="mm" label-position="top">
              <div class="f2">
                <el-form-item label="记忆模型（memory-model-ref）">
                  <el-select
                    v-model="mm.memoryModelRef"
                    filterable
                    clearable
                    placeholder="未设置"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="item in modelOptionsFor(mm.memoryModelRef)"
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
                <el-form-item label="整理最大 token">
                  <el-input-number v-model="mm.consolidationMaxTokens" :min="0" :step="500" style="width: 100%" />
                </el-form-item>
              </div>
              <el-form-item label="整理提示词（consolidation-prompt）">
                <el-input v-model="mm.consolidationPrompt" type="textarea" :rows="3" resize="vertical" />
              </el-form-item>
              <el-form-item label="落盘提示词（flush-prompt）">
                <el-input v-model="mm.flushPrompt" type="textarea" :rows="3" resize="vertical" />
              </el-form-item>
              <div class="f3">
                <el-form-item label="整理最小间隔（毫秒）">
                  <el-input-number v-model="mm.consolidationMinGapMs" :min="0" :step="1000" style="width: 100%" />
                </el-form-item>
                <el-form-item label="日文件保留天数">
                  <el-input-number v-model="mm.dailyFileRetentionDays" :min="0" style="width: 100%" />
                </el-form-item>
              </div>
              <el-form-item label="会话保留天数">
                <el-input-number v-model="mm.sessionRetentionDays" :min="0" style="width: 100%" />
              </el-form-item>
              <div class="f2">
                <el-form-item label="落盘触发（flush-trigger，JSON）">
                  <JsonField
                    :model-value="jsonValue(mm, 'flushTrigger')"
                    :rows="3"
                    @update:model-value="(value) => setJson(mm, 'flushTrigger', value)"
                    @update:valid="(ok) => (jsonValid.flushTrigger = ok)"
                  />
                </el-form-item>
                <el-form-item label="参数截断 / 裁剪（JSON）">
                  <JsonField
                    :model-value="jsonValue(mm, 'truncateArgs')"
                    :rows="3"
                    @update:model-value="(value) => setJson(mm, 'truncateArgs', value)"
                    @update:valid="(ok) => (jsonValid.truncateArgs = ok)"
                  />
                </el-form-item>
              </div>
              <el-form-item label="结果裁剪（prune，JSON）">
                <JsonField
                  :model-value="jsonValue(mm, 'prune')"
                  :rows="3"
                  @update:model-value="(value) => setJson(mm, 'prune', value)"
                  @update:valid="(ok) => (jsonValid.prune = ok)"
                />
              </el-form-item>
            </el-form>
          </PaneCard>

          <PaneCard title="工具结果驱逐">
            <el-form v-if="mm" label-position="top">
              <div class="f2">
                <el-form-item label="单条结果最大字符数">
                  <el-input-number v-model="mm.evictMaxResultChars" :min="0" :step="1000" style="width: 100%" />
                </el-form-item>
                <el-form-item label="预览保留字符数">
                  <el-input-number v-model="mm.evictPreviewChars" :min="0" :step="100" style="width: 100%" />
                </el-form-item>
              </div>
              <el-form-item label="落盘路径（evict-path）">
                <el-input v-model="mm.evictPath" class="mono" placeholder="可选" />
              </el-form-item>
              <el-form-item label="豁免工具（不驱逐）">
                <el-select
                  v-model="mm.evictExcludedTools"
                  multiple
                  filterable
                  allow-create
                  default-first-option
                  :reserve-keyword="false"
                  placeholder="回车添加工具名"
                  style="width: 100%"
                >
                  <el-option
                    v-for="item in mm.evictExcludedTools ?? []"
                    :key="item"
                    :label="item"
                    :value="item"
                  />
                </el-select>
              </el-form-item>
            </el-form>
          </PaneCard>
        </div>
      </el-tab-pane>
      <!-- ============ 工作区（HARNESS） ============ -->
      <el-tab-pane v-if="isHarness" label="工作区" name="workspace">
        <div class="stack">
          <PaneCard title="路径与身份（md_agent_workspace）">
            <el-form v-if="ws" label-position="top">
              <div class="f2">
                <el-form-item label="工作区路径（workspace-root 下）">
                  <el-input v-model="ws.workspacePath" class="mono" placeholder="例如 workwx_batch_agent" />
                </el-form-item>
                <el-form-item label="harness-agent-id">
                  <el-input v-model="ws.harnessAgentId" class="mono" placeholder="agent-name" />
                </el-form-item>
              </div>
              <div class="f2">
                <el-form-item label="计划文件目录（plan-file-directory）">
                  <el-input v-model="ws.planFileDirectory" class="mono" />
                </el-form-item>
                <el-form-item label="项目级技能目录">
                  <el-input v-model="ws.projectGlobalSkillsDir" class="mono" />
                </el-form-item>
              </div>
              <el-form-item label="额外注入上下文的文件">
                <el-select
                  v-model="ws.additionalContextFiles"
                  multiple
                  filterable
                  allow-create
                  default-first-option
                  :reserve-keyword="false"
                  placeholder="回车添加相对路径"
                  style="width: 100%"
                >
                  <el-option
                    v-for="item in ws.additionalContextFiles ?? []"
                    :key="item"
                    :label="item"
                    :value="item"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="环境描述 / 环境记忆">
                <el-input v-model="ws.environment" type="textarea" :rows="2" resize="vertical" />
              </el-form-item>
              <el-form-item label="环境记忆（environment-memory）">
                <el-input v-model="ws.environmentMemory" type="textarea" :rows="3" resize="vertical" />
              </el-form-item>
            </el-form>
          </PaneCard>

          <PaneCard title="技能">
            <el-form v-if="ws" label-position="top">
              <div class="f2">
                <el-form-item label="启用技能（enable-skills）">
                  <el-select
                    v-model="ws.enableSkills"
                    multiple
                    filterable
                    clearable
                    placeholder="可选"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="item in skills ?? []"
                      :key="item.skillName"
                      :label="item.displayName || item.skillName"
                      :value="item.skillName"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="屏蔽技能（disable-skills）">
                  <el-select
                    v-model="ws.disableSkills"
                    multiple
                    filterable
                    clearable
                    placeholder="可选"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="item in skills ?? []"
                      :key="item.skillName"
                      :label="item.displayName || item.skillName"
                      :value="item.skillName"
                    />
                  </el-select>
                </el-form-item>
              </div>
              <el-form-item label="skill-manage-config（JSON）" class="mt">
                <JsonField
                  :model-value="jsonValue(ws, 'skillManageConfig')"
                  :rows="3"
                  @update:model-value="(value) => setJson(ws, 'skillManageConfig', value)"
                  @update:valid="(ok) => (jsonValid.skillManageConfig = ok)"
                />
              </el-form-item>
            </el-form>
          </PaneCard>

          <PaneCard title="能力开关">
            <div v-if="ws" class="toggles">
              <div v-for="item in workspaceToggles" :key="item.key" class="toggles__row">
                <div class="toggles__lb"><span class="mono">{{ item.label }}</span></div>
                <TriStateSelect
                  :model-value="toggleValue(ws, item.key)"
                  @update:model-value="(value) => setToggle(ws, item.key, value)"
                />
              </div>
            </div>
            <el-form v-if="ws" label-position="top" class="mt">
              <el-form-item label="subagent-sync-timeout-seconds">
                <!-- v-model 而不是手动接管事件：清空时组件发 undefined，JSON 里就不带这个键，
                     后端反序列化成 null → 存 NULL（等于"用框架默认 30 秒"）。这与填 0 完全不同。 -->
                <el-input-number
                  v-model="ws.subagentSyncTimeoutSeconds"
                  :min="1"
                  :max="600"
                  :step="10"
                  controls-position="right"
                  placeholder="30"
                />
              </el-form-item>
              <el-form-item label="filesystem（JSON）">
                <JsonField
                  :model-value="jsonValue(ws, 'filesystem')"
                  :rows="3"
                  @update:model-value="(value) => setJson(ws, 'filesystem', value)"
                  @update:valid="(ok) => (jsonValid.filesystem = ok)"
                />
              </el-form-item>
            </el-form>
          </PaneCard>
        </div>
      </el-tab-pane>

      <!-- ============ 子 Agent（HARNESS） ============ -->
      <el-tab-pane v-if="isHarness" label="子 Agent" name="subagents">
        <PaneCard title="子 Agent 声明（md_agent_sub_agent）" :right="`${draft.subAgents?.length ?? 0} 个`">
          <p v-if="(draft.subAgents?.length ?? 0) === 0" class="mt">还没有子 Agent</p>

          <div v-for="(row, index) in draft.subAgents ?? []" :key="index" class="sub">
            <div class="sub__hd">
              <span class="ordnum">{{ index + 1 }}</span>
              <el-select v-model="row.subName" filterable placeholder="选择一个已存在的 agent" class="sub__name">
                <el-option
                  v-for="item in subAgentOptions"
                  :key="item.name"
                  :label="item.displayName"
                  :value="item.name"
                >
                  <span class="row">
                    <span>{{ item.displayName }}</span>
                    <span class="spacer" />
                    <span class="hint mono">{{ item.name }}</span>
                  </span>
                </el-option>
              </el-select>
              <el-button text @click="moveSubAgent(index, -1)">↑</el-button>
              <el-button text @click="moveSubAgent(index, 1)">↓</el-button>
              <el-button text type="danger" @click="removeSubAgent(index)">移除</el-button>
            </div>

            <el-form label-position="top">
              <el-form-item label="派发职责说明">
                <el-input v-model="row.subDescription" />
              </el-form-item>
              <div class="f3">
                <el-form-item label="工作区模式">
                  <el-select v-model="row.workspaceMode" clearable placeholder="未设置" style="width: 100%">
                    <el-option label="ISOLATED" value="ISOLATED" />
                    <el-option label="SHARED" value="SHARED" />
                  </el-select>
                </el-form-item>
                <el-form-item label="最大迭代">
                  <el-input-number v-model="row.maxIters" :min="1" style="width: 100%" />
                </el-form-item>
                <el-form-item label="模式（mode）">
                  <el-select v-model="row.mode" clearable placeholder="未设置" style="width: 100%">
                    <el-option label="PRIMARY" value="PRIMARY" />
                    <el-option label="SUBAGENT" value="SUBAGENT" />
                    <el-option label="ALL" value="ALL" />
                  </el-select>
                </el-form-item>
              </div>
              <div class="f3">
                <el-form-item label="temperature">
                  <el-input-number
                    v-model="row.temperature"
                    :min="0"
                    :max="2"
                    :step="0.1"
                    :precision="2"
                    style="width: 100%"
                  />
                </el-form-item>
                <el-form-item label="top-p">
                  <el-input-number
                    v-model="row.topP"
                    :min="0"
                    :max="1"
                    :step="0.05"
                    :precision="2"
                    style="width: 100%"
                  />
                </el-form-item>
                <el-form-item label="模型（model-ref）">
                  <el-select
                    v-model="row.modelRef"
                    filterable
                    clearable
                    placeholder="未设置"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="item in modelOptionsFor(row.modelRef)"
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
              </div>
              <el-form-item label="内联 AGENTS.md 正文">
                <el-input v-model="row.inlineAgentsBody" type="textarea" :rows="4" resize="vertical" />
              </el-form-item>
              <div class="f2">
                <el-form-item label="工具">
                  <el-select v-model="row.tools" multiple filterable clearable style="width: 100%">
                    <el-option
                      v-for="item in tools ?? []"
                      :key="item.beanName"
                      :label="`${item.name}（${item.beanName}）`"
                      :value="item.beanName"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="技能">
                  <el-select v-model="row.skills" multiple filterable clearable style="width: 100%">
                    <el-option
                      v-for="item in skills ?? []"
                      :key="item.skillName"
                      :label="item.displayName"
                      :value="item.skillName"
                    />
                  </el-select>
                </el-form-item>
              </div>
            </el-form>
          </div>

          <el-button class="mt" @click="addSubAgent">+ 添加子 Agent</el-button>
        </PaneCard>
      </el-tab-pane>

      <!-- ============ 版本 ============ -->
      <el-tab-pane label="版本" name="versions">
        <PaneCard title="版本历史">
          <el-input v-model="changeNote" placeholder="变更说明" class="mb" />
          <VersionsPanel
            :versions="versions ?? []"
            :loading="versionsLoading"
            :published-version="draft.agent.publishedVersion"
            @rollback="confirmRollback"
          />
        </PaneCard>
      </el-tab-pane>
    </el-tabs>

    <el-dialog
      v-model="refDialogOpen"
      :title="activeRefGroup ? `绑定 · ${activeRefGroup.title}` : '绑定'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-form v-if="activeRefGroup" label-position="top">
        <el-form-item :label="activeRefGroup.title">
          <el-select
            v-if="activeRefKind === 'prompt'"
            v-model="activePromptKey"
            filterable
            clearable
            placeholder="不引用"
            style="width: 100%"
          >
            <el-option
              v-for="item in activeRefOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            >
              <span class="row">
                <span>{{ item.label }}</span>
                <span class="spacer" />
                <span v-if="item.note" class="hint mono">{{ item.note }}</span>
              </span>
            </el-option>
          </el-select>
          <el-select
            v-else
            v-model="activeRefValues"
            multiple
            filterable
            clearable
            placeholder="不绑定"
            style="width: 100%"
          >
            <el-option
              v-for="item in activeRefOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            >
              <span class="row">
                <span>{{ item.label }}</span>
                <span class="spacer" />
                <span v-if="item.note" class="hint mono">{{ item.note }}</span>
              </span>
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="refdlg__ft">
          <router-link v-if="activeRefGroup" class="lk" :to="activeRefGroup.link">去维护</router-link>
          <span class="spacer" />
          <el-button type="primary" @click="refDialogOpen = false">完成</el-button>
        </div>
      </template>
    </el-dialog>
  </template>
</template>

<style scoped>
.breadcrumb {
  margin-bottom: var(--s4);
}
.badges {
  margin-top: 6px;
}
.refs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: var(--s3);
}
.refcard {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
  min-height: 104px;
  padding: var(--s4);
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
  background: var(--panel);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.refcard:hover {
  border-color: var(--pri-line);
  background: var(--panel-soft);
  box-shadow: var(--sh-card-hover);
  transform: translateY(-1px);
}
.refcard:focus-visible {
  outline: 2px solid var(--pri-line);
  outline-offset: 2px;
}
.refcard__hd {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.refcard__ttl {
  color: var(--t2);
  font-size: 13.5px;
  font-weight: 600;
}
.refcard__arw {
  margin-left: auto;
  color: var(--t3);
  font-size: 18px;
  line-height: 1;
  transition: color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.refcard:hover .refcard__arw {
  color: var(--pri-ink);
  transform: translateX(2px);
}
.refcard__main {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
}
.refcard__num {
  color: var(--t1);
  font-size: 26px;
  font-weight: 650;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.refcard__unit {
  color: var(--t3);
  font-size: 13px;
}
.refdlg__ft {
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.f2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 var(--s4);
}
.f3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 var(--s4);
}
.toggles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--s2) var(--s4);
}
.toggles__row {
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-height: 34px;
}
.toggles__lb {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-right: auto;
}
.jf__hd {
  margin-bottom: 5px;
}
.sub {
  padding: var(--s3) var(--s4) var(--s2);
  margin-bottom: var(--s3);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  background: var(--panel-soft);
}
.sub__hd {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-bottom: var(--s3);
}
.sub__name {
  width: 260px;
}
.tabs :deep(.el-tabs__content) {
  overflow: visible;
}
@media (max-width: 1100px) {
  .f2,
  .f3 {
    grid-template-columns: 1fr;
  }
}
</style>
