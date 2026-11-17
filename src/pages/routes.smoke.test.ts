/*
 * 全路由冒烟测试 —— 每个路由都真挂一次，断言没有掉进错误边界。
 *
 * <h2>为什么需要这一层</h2>
 * 这个项目已经出现过两次「vue-tsc + 单测 + 构建全绿，但页面在真实运行里白屏」：
 *
 * <ol>
 *   <li><b>AgentDetailPage 白屏</b>：编辑副本用 structuredClone 复制 vue-query 的 data，
 *       而那是 reactive 代理 —— 结构化克隆算法遇到 Proxy 直接抛 DataCloneError，
 *       页面被 RouteBoundary 接住，用户看到「这个页面渲染失败了」。</li>
 *   <li><b>ChatPage 的 agent 下拉项是 undefined</b>：后端 /api/agents 返回的是
 *       AgentRow（agentName / agentType），而调用方按 {name, type} 读 ——
 *       展开下拉时 item.type.toLowerCase() 当场抛错。</li>
 * </ol>
 *
 * 两者的共同点：<b>只有「组件真的跑一次 setup、真的渲染一次模板」才会暴露</b>。
 * vue-tsc 看不出来 —— apiJson&lt;T&gt; 里的 T 只是一次类型断言，写错了它照样通过；
 * 纯函数单测也看不出来 —— 它们根本不碰组件树。所以必须有一个真的把页面挂起来的测试。
 *
 * <h2>夹具为什么抄真实响应，又为什么标类型</h2>
 * 夹具照抄运行中的后端返回（2026-09-22 实测），不自己编一套 ——
 * 编出来的形状一旦与后端不符，这个测试就从「守门」退化成「骗自己」。
 * 每个夹具都用 controlplane/types.ts 的接口标注：字段名写错、少写、多写都会被
 * vue-tsc 拦下，接口改了而夹具没跟上的情况也跑不掉。
 *
 * <h2>测试不依赖后端</h2>
 * 这里把 fetch 整个换掉，所以 CI 上没有 9090 也能跑。
 * 真后端的联调由浏览器里点一遍承担，不由单测承担 ——
 * 单测要的是「任何机器上结果都一样」，不是「连得上本机服务」。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import ElementPlus from 'element-plus';

import AppShell from '@/app/AppShell.vue';
import { router } from '@/app/router';
import { queryKeys } from '@/lib/queryKeys';
import type {
  AgentDefinitionBundle,
  AgentRow,
  ChannelTypeDescriptor,
  ChannelView,
  GatewayView,
  McpServerEntity,
  MiddlewareChainInfo,
  MiddlewareMeta,
  ModelDetail,
  ModelDefaults,
  ModelRow,
  PromptEntity,
  SkillMetaEntity,
  ToolMeta,
  WorkspaceAgentRow,
  WorkflowEntity,
  WorkflowRow,
  WorkflowRunDetail,
  WorkflowRunNodeRow,
  WorkflowRunRow,
  WorkspaceDirView,
  WorkspaceFileView,
  WorkspaceUserRow,
} from '@/api/controlplane/types';
import type {
  EnvDetail,
  EnvDetailInstance,
  EnvGroupKeyTemplate,
  EnvGroupState,
  EnvGroupTemplate,
  EnvInstanceDetail,
  EnvInstanceRow,
  EnvKeyValue,
  EnvRow,
} from '@/api/controlplane/types';
import type { Overview } from '@/api/overview';
import type { RunSummary } from '@/api/types';
import type { TraceEvent, TraceRunInfo } from '@/features/traces/model';
import type { StateMessage, StateSessionDetail, StateSessionPage, StateTableRow } from '@/api/state';
import type { SessionDetail, SessionPage } from '@/api/sessions';

/*
 * jsdom 没有 ResizeObserver / matchMedia，而 Element Plus 的下拉、滚动容器会用到它们。
 * 不补的话失败会是「测试环境缺 API」而不是「页面有问题」，这种噪声比不测更糟 ——
 * 它会训练人忽略红色。
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
/*
 * 路由的 scrollBehavior 每次跳转都会调 window.scrollTo，而 jsdom 没实现它 ——
 * 它会往 stderr 打一行 "Error: Not implemented"。那不是失败，但满屏假 Error
 * 会让人对真的报错脱敏。这里补一个空实现。
 */
window.scrollTo = (() => {}) as typeof window.scrollTo;

// ==================================================================================
// 夹具
// ==================================================================================

const REACT_AGENT: AgentRow = {
  agentName: 'test_agent',
  displayName: '冒烟测试 Agent',
  agentType: 'REACT',
  description: '冒烟测试用的 agent',
  category: '开发',
  bizTags: ['smoke'],
  status: 'PUBLISHED',
  version: 1,
  publishedVersion: 1,
  publishedAtMs: 1_790_047_793_967,
  enabled: true,
  updatedAtMs: 1_790_047_793_967,
  promptKey: 'deployment_agent',
  tools: ['gitlabCommitDiff'],
  middleware: ['agentRunTraceMiddleware'],
  skillNames: null,
  mcpNames: null,
  subAgentNames: [],
  loaded: true,
};

const HARNESS_AGENT: AgentRow = {
  ...REACT_AGENT,
  agentName: 'smoke_harness',
  agentType: 'HARNESS',
  description: '冒烟测试用的 harness',
  category: '运维',
  subAgentNames: ['test_agent'],
};

const REACT_BUNDLE: AgentDefinitionBundle = {
  agent: {
    agentName: 'test_agent',
    displayName: '冒烟测试 Agent',
    agentType: 'REACT',
    description: '冒烟测试用的 agent',
    bizTags: ['smoke'],
    category: '开发',
    enabled: true,
    status: 'PUBLISHED',
    version: 1,
    publishedVersion: 1,
    publishedAtMs: 1_790_047_793_967,
    createdAtMs: 1_790_047_789_046,
    updatedAtMs: 1_790_047_793_967,
    createdBy: 'console',
    updatedBy: 'console',
  },
  ref: {
    agentName: 'test_agent',
    promptKey: 'deployment_agent',
    tools: ['gitlabCommitDiff'],
    middleware: ['agentRunTraceMiddleware'],
    skillNames: null,
    mcpNames: null,
    knowledges: null,
  },
  runtime: {
    agentName: 'test_agent',
    modelRef: null,
    fallbackModelRef: null,
    reasoningEffort: null,
    maxIters: null,
    maxRetries: null,
    maxContextTokens: null,
    checkRunning: null,
    stopOnReject: null,
    enableMetaTool: null,
    enableTaskList: null,
    enablePendingToolRecovery: null,
    conflictPolicy: 'OVERWRITE',
    dynamicSkillsEnabled: null,
    skillCodeExecutionEnabled: null,
    skillWorkDir: null,
    stateStore: null,
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
  // REACT 没有这两张表的行 —— null 表示「没有这行」，不是「没查到」，这是正确状态
  memory: null,
  workspace: null,
  subAgents: [],
};

const HARNESS_BUNDLE: AgentDefinitionBundle = {
  agent: { ...REACT_BUNDLE.agent, agentName: 'smoke_harness', agentType: 'HARNESS', category: '运维' },
  ref: { ...REACT_BUNDLE.ref!, agentName: 'smoke_harness' },
  runtime: {
    ...REACT_BUNDLE.runtime!,
    agentName: 'smoke_harness',
    // REACT 专有项：HARNESS 上必须是空，否则后端校验会拒
    conflictPolicy: null,
  },
  memory: {
    agentName: 'smoke_harness',
    compactionDisabled: false,
    triggerMessages: null,
    triggerTokens: 32_000,
    reserved: null,
    keepMessages: null,
    keepTokens: 8_000,
    keepTokensMin: null,
    keepTokensMax: null,
    keepTokensRatio: null,
    summaryPrompt: null,
    flushBeforeCompact: null,
    offloadBeforeCompact: null,
    compactionModelRef: null,
    truncateArgs: null,
    prune: null,
    memoryModelRef: null,
    flushPrompt: null,
    consolidationPrompt: null,
    consolidationMaxTokens: null,
    consolidationMinGapMs: null,
    dailyFileRetentionDays: null,
    sessionRetentionDays: null,
    flushTrigger: null,
    evictDisabled: null,
    evictMaxResultChars: null,
    evictPreviewChars: null,
    evictPath: null,
    evictExcludedTools: null,
  },
  workspace: {
    agentName: 'smoke_harness',
    harnessAgentId: 'smoke_harness',
    workspacePath: 'smoke_harness',
    fsBackend: 'LOCAL',
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
    subagentForceSync: null,
    subagentSyncTimeoutSeconds: null,
  },
  subAgents: [
    {
      id: 1,
      agentName: 'smoke_harness',
      // 子 agent 只能是 REACT：后端与前端下拉都只放行 REACT
      subName: 'test_agent',
      sortOrder: 0,
      subDescription: '负责提交差异查询',
      workspaceMode: 'ISOLATED',
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
    },
  ],
};

const PROMPTS: PromptEntity[] = [
  {
    promptKey: 'deployment_agent',
    displayName: '发布助手提示词',
    description: '发布流程',
    bizTags: null,
    body: '你是一个发布助手。',
    status: 'PUBLISHED',
    version: 1,
    publishedVersion: 1,
    publishedAtMs: 1_790_000_000_000,
    createdAtMs: 1_790_000_000_000,
    updatedAtMs: 1_790_000_000_000,
    createdBy: 'console',
    updatedBy: 'console',
  },
];

/* skill / mcp 在库里就是空的（导入器没跑完），夹具照实为空 —— 空态也必须能渲染。 */
const SKILLS: SkillMetaEntity[] = [];
const MCPS: McpServerEntity[] = [];

const TOOLS: ToolMeta[] = [
  {
    name: 'gitlabCommitDiff',
    beanName: 'gitlabCommitDiff',
    description: '查一次提交的差异',
    parameters: [{ name: 'commitSha', description: '提交 sha' }],
  },
];

const MIDDLEWARE_CATALOG: MiddlewareMeta[] = [
  {
    beanName: 'agentRunTraceMiddleware',
    simpleName: 'AgentRunTraceMiddleware',
    className: 'com.md.agentplatform.server.trace.AgentRunTraceMiddleware',
  },
];

const MIDDLEWARE_CHAIN: MiddlewareChainInfo = {
  global: ['AgentRunTraceMiddleware'],
  note: '其余中间件按 agent 声明挂载。',
};

const RUN_SUMMARY: RunSummary = {
  runId: 'smoke-run-1',
  agentId: 'test_agent',
  sessionId: 'console-smoke',
  status: 'success',
  tone: 'ok',
  durationMs: 1468,
  tokens: 6726,
  startedAt: '2026-09-21T14:01:34.104Z',
};

const RUN_INFO: TraceRunInfo = {
  runId: 'smoke-run-1',
  agentId: 'test_agent',
  agentKind: 'react',
  sessionId: 'console-smoke',
  user: 'console',
  source: 'unknown',
  durationMs: 1468,
  tokens: 6726,
  cacheHitRate: '98%',
  parentRunId: null,
  taskId: null,
};

const RUN_EVENTS: TraceEvent[] = [
  {
    id: 'smoke-run-1-1',
    seq: 1,
    runId: 'smoke-run-1',
    // 必须是 eventPresentation 里登记过的类型：抄的是后端真实事件
    // （2026-09-22 实测第一条就是 run.started）
    type: 'run.started',
    occurredAt: '2026-09-21T14:01:34.104Z',
    path: '1',
    parentPath: null,
    kind: 'agent',
    label: 'test_agent',
    source: null,
    status: 'run',
    durationMs: null,
    tokens: null,
  },
];

// ==================================================================================
// 取数桩
// ==================================================================================

/**
 * 路径 → 夹具。
 *
 * 只列会被请求到的路径；漏了哪条就会回 404，页面会走错误态 ——
 * 那是刻意的：新页面第一次接进来时，这里漏配会立刻暴露成一条红色，
 * 而不是让冒烟测试悄悄放行一个从没验过的页面。
 */
/*
 * 接入域的夹具（渠道 + 网关）。
 *
 * 渠道页与网关页<b>不走 mock 开关</b>（渠道是受治理资源，库是唯一真相），
 * 所以这里必须给真夹具，否则页面拿到 404 会渲染成错误态 —— 而错误态也是"渲染成功"，
 * 冒烟测试就放行了一个从没验过的正常态。
 */
const CHANNEL_TYPES: ChannelTypeDescriptor[] = [
  {
    typeId: 'wecom-bot',
    label: '企业微信机器人（长连接）',
    kind: 'BOT',
    description: '企微智能机器人：WebSocket 长连接接入，不需要公网回调地址。',
    properties: [
      { key: 'botId', label: '机器人 ID', required: true, secret: false, placeholder: 'aib...', hint: null },
      { key: 'secret', label: '机器人 Secret', required: true, secret: true, placeholder: null, hint: null },
    ],
    // 长连接机器人：会话由本项目渲染器决定，不看 dmScope；回复风格只有企微那一种
    dmScope: { options: [], note: '长连接机器人的会话由聊天窗口决定。' },
    replyStyle: { options: ['WECOM_THINK'], note: null },
  },
  {
    typeId: 'wecom',
    label: '企业微信（回调式）',
    kind: 'OFFICIAL',
    description: '自建应用 + 回调 URL，消息由官方通道派发给网关。',
    properties: [
      { key: 'corpId', label: '企业 ID', required: true, secret: false, placeholder: null, hint: null },
      { key: 'encodingAesKey', label: 'EncodingAesKey', required: true, secret: true, placeholder: null, hint: null },
    ],
    // 回调式相反：回复由官方 outbound 渲染
    dmScope: {
      options: ['MAIN', 'PER_PEER', 'PER_CHANNEL_PEER', 'PER_ACCOUNT_CHANNEL_PEER'],
      note: '只作用于单聊。',
    },
    replyStyle: { options: [], note: '回复由官方 outbound 发送。' },
  },
];

const CHANNELS: ChannelView[] = [
  {
    channelId: 'deployment_agent-bot',
    channelType: 'wecom-bot',
    typeLabel: '企业微信机器人（长连接）',
    kind: 'BOT',
    displayName: '企微机器人',
    description: '演示用',
    ownerId: null,
    defaultAgentId: 'test_agent',
    dmScope: null,
    replyStyle: null,
    // 列表接口里敏感字段是 ******
    properties: { botId: 'aibvROqyj1F_kwFp', secret: '******' },
    enabled: true,
    status: 'PUBLISHED',
    version: 3,
    publishedVersion: 3,
    publishedAtMs: 1_758_000_000_000,
    createdAtMs: 1_757_000_000_000,
    updatedAtMs: 1_758_000_000_000,
    createdBy: 'console',
    updatedBy: 'console',
    bindings: [
      {
        id: 1,
        channelId: 'deployment_agent-bot',
        agentId: 'test_agent',
        peer: 'group:chatid_1',
        parentPeer: null,
        guild: null,
        roles: null,
        team: null,
        account: null,
        channel: null,
        sessionScope: null,
        sortOrder: 0,
      },
    ],
    runtime: {
      channelId: 'deployment_agent-bot',
      channelType: 'wecom-bot',
      typeLabel: '企业微信机器人（长连接）',
      kind: 'BOT',
      enabled: true,
      status: 'PUBLISHED',
      publishedVersion: 3,
      started: true,
      alive: true,
      error: null,
      bindingCount: 1,
      appliedAtMs: 1_758_000_000_000,
    },
  },
  {
    channelId: 'feishu-main',
    channelType: 'feishu-bot',
    // 类型未注册（工厂被删了/类型名写错）时后端回 null，页面必须能显示"未知类型"而不是空白
    typeLabel: null,
    kind: null,
    displayName: null,
    description: null,
    ownerId: null,
    defaultAgentId: null,
    dmScope: null,
    replyStyle: null,
    properties: null,
    enabled: false,
    status: 'DRAFT',
    version: 4,
    publishedVersion: 2,
    publishedAtMs: 1_757_000_000_000,
    createdAtMs: 1_756_000_000_000,
    updatedAtMs: 1_758_500_000_000,
    createdBy: 'console',
    updatedBy: 'console',
    bindings: [],
    runtime: {
      channelId: 'feishu-main',
      channelType: 'feishu-bot',
      typeLabel: null,
      kind: null,
      enabled: false,
      status: 'DRAFT',
      publishedVersion: 2,
      started: false,
      alive: false,
      error: '缺少必填凭据 appId（App ID）',
      bindingCount: 0,
      appliedAtMs: null,
    },
  },
  {
    channelId: 'wecom-main',
    channelType: 'wecom',
    typeLabel: '企业微信（回调式）',
    kind: 'OFFICIAL',
    displayName: '企微自建应用',
    description: null,
    ownerId: null,
    defaultAgentId: 'test_agent',
    dmScope: null,
    replyStyle: null,
    properties: { corpId: 'ww1234', agentId: '1000002', secret: '******' },
    enabled: true,
    status: 'PUBLISHED',
    version: 2,
    publishedVersion: 2,
    publishedAtMs: 1_758_000_000_000,
    createdAtMs: 1_757_000_000_000,
    updatedAtMs: 1_758_000_000_000,
    createdBy: 'console',
    updatedBy: 'console',
    // 回调式不需要"绑定规则"也接得到消息（走兜底 Agent），夹具故意留空
    bindings: [],
    runtime: {
      channelId: 'wecom-main',
      channelType: 'wecom',
      typeLabel: '企业微信（回调式）',
      kind: 'OFFICIAL',
      enabled: true,
      status: 'PUBLISHED',
      publishedVersion: 2,
      started: true,
      alive: true,
      error: null,
      bindingCount: 0,
      appliedAtMs: 1_758_000_000_000,
    },
  },
];

const GATEWAY: GatewayView = {
  mainAgentId: 'smoke_harness',
  description: '演示用',
  updatedAtMs: 1_758_000_000_000,
  updatedBy: 'console',
  runtime: {
    built: true,
    mainAgentId: 'smoke_harness',
    agentIds: ['smoke_harness'],
    routerDefault: 'smoke_harness',
    note: null,
    loadedAtMs: 1_758_000_000_000,
  },
  candidates: ['smoke_harness'],
};
/*
 * 状态存储：一张有数据的表 + 一张「声明了但还没被框架建出来」的表。
 *
 * 第二种是必须有的 —— 框架是「第一次真正用到时才建表」，所以刚配好的 agent
 * 在库里根本不存在。夹具里少了它，"尚未创建"这一支就永远测不到。
 */
const STATE_TABLES: StateTableRow[] = [
  {
    tableName: 'test_agent',
    agentName: 'test_agent',
    exists: true,
    sessions: 2,
    rows: 2,
    bytes: 11_078,
    lastWriteAt: '2026-09-22T15:30:05',
  },
  {
    tableName: 'new_agent',
    agentName: 'new_agent',
    exists: false,
    sessions: 0,
    rows: 0,
    bytes: 0,
    lastWriteAt: null,
  },
];

const STATE_SESSIONS: StateSessionPage = {
  total: 1,
  tableTotal: 2,
  items: [
    {
      /* slotId 的形态就是库里的 session_id 列：<userId>:<sessionId>，页面按冒号拆成两列。 */
      slotId: 'codex:conv-basic',
      userId: 'codex',
      sessionId: 'conv-basic',
      stateKey: null,
      itemIndex: null,
      bytes: 10_407,
      rows: 1,
      version: 3,
      createdAt: null,
      /* 列表里的时间来自 MAX(updated_at)，是 MySQL DATETIME 原样的空格分隔形态 —— 夹保持着不改成 ISO， */
      /* 这样 formatDateTime 里那步兼容归一化才会被真正走到。 */
      updatedAt: '2026-09-22 15:29:18',
    },
  ],
};

const STATE_DETAIL: StateSessionDetail = {
  slotId: 'codex:conv-basic',
  userId: 'codex',
  sessionId: 'conv-basic',
  totalBytes: 10_407,
  slots: [
    {
      slotId: 'codex:conv-basic',
      userId: 'codex',
      sessionId: 'conv-basic',
      stateKey: 'agent_state',
      itemIndex: 0,
      bytes: 10_407,
      rows: null,
      version: 3,
      createdAt: '2026-09-22T15:29:18',
      updatedAt: '2026-09-22T15:29:18',
    },
  ],
  snapshot: {
    bytes: 10_407,
    version: 3,
    createdAt: '2026-09-22T15:29:18',
    updatedAt: '2026-09-22T15:29:18',
    summary: '',
    messages: 4,
    curIter: 1,
    shutdownInterrupted: false,
    tasksTotal: 1,
    tasks: [{ id: '1', subject: '冒烟任务', state: 'pending', owner: 'test_agent' }],
    planActive: false,
    planFile: null,
    activatedToolGroups: ['git'],
    permissionMode: 'bypass',
    preview: [
      {
        role: 'USER',
        kind: 'text',
        text: '只回复两个字：收到。',
        timestamp: '2026-09-22 15:29:18.100',
      },
    ],
  },
  parseError: null,
};

/*
 * 会话记录页的夹具。
 *
 * 形状照抄运行中的后端（2026-09-23 实测 /api/sessions）：**agents 与 sources 是数组**，
 * 这正是这一页立论的地方 —— 同一条会话会被多个 agent 服务过，而来源可能一次都没标注过
 * （存量 run 的 source 列是 NULL）。夹具里两条会话各占一种：一条两个 agent + 两个来源 + 有记忆，
 * 一条单 agent + 没来源 + 没记忆，user_id 还是 NULL。
 * 编一个"每个会话只有一个 agent"的夹具，等于把这一页最该守住的那条认知从测试里删掉。
 */
const SESSION_PAGE: SessionPage = {
  total: 2,
  allTotal: 3,
  items: [
    {
      userId: 'wo7U1',
      sessionId: 'single-abc',
      runs: 6,
      failed: 1,
      tokens: 1_200,
      agents: ['deployment_agent', 'workwx_batch_agent'],
      sources: ['wecom', 'console'],
      firstMs: 1_790_064_819_160,
      lastMs: 1_790_066_317_176,
      hasState: true,
      stateTables: ['test_agent'],
    },
    {
      /* user_id 为 NULL 的会话确实存在（老数据、非渠道入口），页面必须显示成「（未分区）」而不是空白 */
      userId: null,
      sessionId: 'console-7cc8d068',
      runs: 1,
      failed: 0,
      tokens: 13_018,
      agents: ['test_agent'],
      /* 来源为空数组 = 这条会话的每一次执行都没标注过来源（source 列为 NULL） */
      sources: [],
      firstMs: 1_790_065_068_650,
      lastMs: 1_790_065_068_650,
      hasState: false,
      stateTables: [],
    },
  ],
};

/*
 * 会话回放的消息。形状照抄后端 /api/state/sessions/messages（2026-09-30 实测）：
 * role 是框架的大写原值（USER / ASSISTANT），正文与思考分成两段，工具只给名字。
 *
 * 三条覆盖三种落点：用户提问、带思考与工具调用的回答、纯正文的回答。
 * 工具结果（role=TOOL）后端刻意不返回（它是"过程"不是"对话"，见后端
 * AgentStateAdminService#collectBlock），所以夹具里也不放 —— 编一个后端不会给的形状，
 * 测的就是一段不存在的契约。
 */
const STATE_MESSAGES: StateMessage[] = [
  {
    role: 'USER',
    text: '帮我看下昨天日报',
    thinking: '',
    tools: [],
    timestamp: '2026-09-22T15:29:10',
  },
  {
    role: 'ASSISTANT',
    text: '好的，先看**任务列表**。',
    thinking: '先确认有没有可用的任务模板',
    tools: ['taskList'],
    timestamp: '2026-09-22T15:29:12',
  },
  {
    role: 'ASSISTANT',
    text: '昨天的日报已经生成。',
    thinking: '',
    tools: [],
    timestamp: '2026-09-22T15:29:15',
  },
];

/** 详情：执行时间线（新在前）+ 记忆清单，两块在同一个响应里。 */
const SESSION_DETAIL: SessionDetail = {
  userId: 'wo7U1',
  sessionId: 'single-abc',
  runs: [
    {
      runId: 'smoke-run-1',
      agentId: 'workwx_batch_agent',
      agentKind: 'harness',
      source: 'wecom',
      status: 'success',
      tone: 'ok',
      durationMs: 1_500,
      tokens: 300,
      startedAtMs: 1_790_066_317_176,
      error: null,
    },
    {
      runId: 'smoke-run-2',
      agentId: 'deployment_agent',
      agentKind: 'react',
      source: 'console',
      status: 'failed',
      tone: 'err',
      durationMs: 2_386,
      tokens: 0,
      startedAtMs: 1_790_064_819_160,
      /* 失败原因要在抽屉里读得到 —— 只显示一个「失败」徽标等于什么都没说 */
      error: 'OpenAIException: Insufficient Balance',
    },
  ],
  states: [
    {
      tableName: 'test_agent',
      agentName: 'test_agent',
      rows: 1,
      bytes: 707,
      updatedAt: '2026-09-22T15:29:00',
    },
  ],
};

/*
 * 概览页的夹具（形状照抄 OverviewViews）。
 *
 * 这里刻意让「今日执行」与「昨日」都能算出一个具体增量：页面上那个「较昨日 ±x%」
 * 是<b>前端算的</b>（后端只给 total 与 yesterdayTotal 两个原始数字），
 * 所以必须有两条真实数字才能验出来。
 * 另外 runs 里混进一条 running：进度中的 run 也要出现在最近执行里，
 * 且它的耗时会一直增长 —— 夹具漏掉这种状态，页面上那两个时间列就永远只测到已完成的分支。
 */
const OVERVIEW: Overview = {
  metrics: {
    agents: { total: 3, harness: 1, react: 2, published: 2, enabled: 3 },
    tools: { local: 5, mcpServers: 1, mcpEnabled: 1 },
    executionsToday: { total: 6, success: 4, failed: 1, running: 1, yesterdayTotal: 4 },
    latency: { averageMs: 12_400, p95Ms: 48_200, slowestAgent: 'workwx_batch_agent', slowestMs: 48_200 },
    tokens: { today: 1_820_000, cacheHitRate: '61%' },
    models: { total: 1, enabled: 1, defaultKey: 'ds-flash' },
  },
  health: [
    { label: 'Agent 发布率', ratio: 0.67, value: '2 / 3' },
    { label: 'MCP 启用率', ratio: 1, value: '1 / 1' },
  ],
  attention: [
    {
      title: 'test_agent 已启用但从未发布',
      meta: '当前仅草稿',
      detail: '实例能跑，但没有任何版本快照可回滚。',
      tone: 'wait',
    },
  ],
  changes: [
    {
      subject: 'test_agent',
      resourceType: 'AGENT',
      action: '发布 v1',
      note: '首版上线',
      atMs: 1_790_065_068_650,
      actor: 'console',
    },
  ],
  runs: [RUN_SUMMARY],
  generatedAtMs: 1_790_066_317_176,
};

/*
 * 模型页夹具（形状照抄 ModelViews.ModelRow）。
 *
 * 两条各占一种状态：一条是已发布 + 默认 + 有引用，一条是草稿 + 停用。
 * 只用一条"完美"的模型会让筛选 chips、状态徽标、引用计数这几处永远只走一个分支。
 * apiKeyMask 故意留成六个星号：列表页给的<b>就是</b>打码值，明文只在详情接口。
 */
const MODEL_ROWS: ModelRow[] = [
  {
    modelKey: 'ds-flash',
    displayName: 'DeepSeek V4 Flash',
    purpose: '对话',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyMask: '******',
    modelName: 'deepseek-v4-flash',
    endpointPath: null,
    formatter: 'deepseek-reasoning',
    reasoningEffort: 'low',
    temperature: null,
    topP: null,
    maxTokens: 4096,
    contextWindowSize: 131_072,
    description: '全部 agent 的主模型',
    bizTags: ['对话'],
    isDefault: true,
    enabled: true,
    status: 'PUBLISHED',
    version: 3,
    publishedVersion: 3,
    publishedAtMs: 1_790_065_068_650,
    createdAtMs: 1_790_000_000_000,
    updatedAtMs: 1_790_065_068_650,
    createdBy: 'console',
    updatedBy: 'console',
    agentCount: 3,
    /* 默认模型额外的「靠它兜底」计数：这批 agent 用它是没写 model_ref，不是写了它 */
    fallbackForAgents: 4,
    tokens7d: 1_820_000,
    runs7d: 128,
  },
  {
    modelKey: 'ark-embed',
    displayName: 'Ark 向量化',
    purpose: '向量化',
    provider: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    apiKeyMask: '',
    modelName: 'doubao-embedding-vision',
    endpointPath: null,
    formatter: 'default',
    reasoningEffort: null,
    temperature: null,
    topP: null,
    maxTokens: null,
    contextWindowSize: null,
    description: null,
    bizTags: null,
    isDefault: false,
    enabled: false,
    status: 'DRAFT',
    version: 1,
    publishedVersion: null,
    publishedAtMs: null,
    createdAtMs: 1_790_000_000_000,
    updatedAtMs: 1_790_000_000_000,
    createdBy: 'console',
    updatedBy: 'console',
    agentCount: 0,
    fallbackForAgents: 0,
    tokens7d: 0,
    runs7d: 0,
  },
];

const MODEL_DEFAULTS: ModelDefaults = {
  fallbackKey: 'ds-flash',
  fallbackSource: 'md_model',
  items: [
    { label: '兜底来源', value: 'md_model · ds-flash', note: 'agent 没声明 model-ref 时用它。' },
    { label: '端点', value: 'https://api.deepseek.com', note: null },
    { label: 'formatter', value: 'deepseek-reasoning', note: '不回传 reasoning_content 时厂商会返回 400。' },
  ],
};

const MODEL_DETAIL: ModelDetail = {
  /* 详情给的是明文：编辑表单要回填，打码值回传会把真密钥覆盖成六个星号 */
  model: {
    modelKey: 'ds-flash',
    displayName: 'DeepSeek V4 Flash',
    purpose: '对话',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-smoke-not-a-real-key',
    modelName: 'deepseek-v4-flash',
    endpointPath: null,
    formatter: 'deepseek-reasoning',
    reasoningEffort: 'low',
    temperature: null,
    topP: null,
    maxTokens: 4096,
    contextWindowSize: 131_072,
    description: '全部 agent 的主模型',
    bizTags: ['对话'],
    isDefault: true,
    enabled: true,
    status: 'PUBLISHED',
    version: 3,
    publishedVersion: 3,
    publishedAtMs: 1_790_065_068_650,
    createdAtMs: 1_790_000_000_000,
    updatedAtMs: 1_790_065_068_650,
    createdBy: 'console',
    updatedBy: 'console',
  },
  agentCount: 3,
  tokens7d: 1_820_000,
  runs7d: 128,
  usedByAgents: ['test_agent', 'smoke_harness'],
};

/*
 * 工作区夹具。
 *
 * 形状照后端 WorkspaceViews.java 抄：agentName / fsBackend / workspacePath / filesystemType
 * 一个不少。条目上的 writable 刻意混着真假 —— 只给可写条目的话，
 * 「只读条目不给写入口」这条规则就永远不会被这个测试碰到，而它正是这一页唯一的安全规则。
 */
const WORKSPACE_AGENTS: WorkspaceAgentRow[] = [
  {
    agentName: 'smoke_harness',
    fsBackend: 'REMOTE',
    workspacePath: 'D:\\code\\Md-Agent-Platform\\workspace\\harness\\smoke_harness',
    filesystemType: 'CompositeFilesystem',
  },
];

/*
 * 隔离维度的候选值。
 *
 * 刻意给两个"完整度不同"的身份（一个常在用、一个只有一条历史）：页面上它们只差次行的
 * 规模与新鲜度，而那段文字是"日常在用"与"只留了一条历史"的唯一区分手段，
 * 只给一个身份就测不出它有没有渲染。
 */
const WORKSPACE_USERS: WorkspaceUserRow[] = [
  { userId: 'console', runs: 9, lastActiveMs: 1790663000000 },
  { userId: 'wo7U1ZEQAApziTCwT6jow9UKLs0xrqlw', runs: 1, lastActiveMs: 1790570000000 },
];

const WORKSPACE_DIR: WorkspaceDirView = {
  agentName: 'smoke_harness',
  userId: null,
  path: '',
  entries: [
    { name: 'AGENTS.md', path: 'AGENTS.md', directory: false, size: 0, modifiedAt: '', writable: true },
    { name: 'knowledge', path: 'knowledge', directory: true, size: 0, modifiedAt: '', writable: true },
    { name: 'memory', path: 'memory', directory: true, size: 0, modifiedAt: '', writable: false },
  ],
};

const WORKSPACE_FILE: WorkspaceFileView = {
  agentName: 'smoke_harness',
  userId: null,
  path: 'AGENTS.md',
  content: '# smoke harness',
  size: 15,
  writable: true,
  truncated: false,
};

/*
 * 环境目录夹具：环境 → 变量分组 → 键 → 值。
 *
 * 页面读的是 /api/environments 与 /api/env-groups。夹具照抄后端口径：
 * 分组的 missing 用「展示名」而不是 keyCode，因为它是直接给人看的；
 * 详情里未配置的键以 value=null 出现，页面只把有值的项放进抽屉。
 *
 * 三行环境刻意覆盖三种状态：已配齐、在用但缺凭据、完全未配置。
 * 凭据一律是假值，避免把真实 token 抄进仓库。
 */
function envKey(
  keyCode: string,
  label: string,
  options: Partial<Pick<EnvGroupKeyTemplate, 'valueType' | 'required' | 'secret' | 'reserved' | 'description'>> = {},
): EnvGroupKeyTemplate {
  return {
    keyCode,
    label,
    valueType: options.valueType ?? 'STRING',
    required: options.required ?? false,
    secret: options.secret ?? false,
    placeholder: null,
    exampleValue: null,
    description: options.description ?? null,
    sortOrder: 0,
    reserved: options.reserved ?? false,
  };
}

const ENV_GROUPS: EnvGroupTemplate[] = [
  {
    groupCode: 'k8s',
    displayName: 'Kubernetes',
    icon: null,
    description: '集群连接信息',
    builtin: true,
    sortOrder: 10,
    keys: [
      envKey('url', '集群地址', {
        required: true,
        reserved: true,
        description: '要把 /kubernetes/global 这段带上，少一段会 404',
      }),
      envKey('token', '访问令牌', {
        required: true,
        secret: true,
        reserved: true,
        description: 'ServiceAccount 的 Bearer Token',
      }),
      envKey('clusterName', '集群名'),
    ],
  },
  {
    groupCode: 'magic',
    displayName: 'Magic',
    icon: null,
    description: '取数服务',
    builtin: true,
    sortOrder: 20,
    keys: [
      envKey('url', '取数地址', {
        required: true,
        reserved: true,
        description: '整条取数 URL（含路径），不是一个根地址',
      }),
    ],
  },
  {
    groupCode: 'nacos',
    displayName: 'Nacos',
    icon: null,
    description: '配置中心',
    builtin: true,
    sortOrder: 30,
    keys: [envKey('password', '密码', { required: true, secret: true, reserved: true })],
  },
  {
    groupCode: 'biz',
    displayName: '业务参数',
    icon: null,
    description: '页面自由添加的业务键',
    builtin: false,
    sortOrder: 40,
    keys: [envKey('owner', '对接人', { description: '推送到群里时用于点名' })],
  },
];

function envGroupState(
  groupCode: string,
  status: EnvGroupState['status'],
  missing: string[] = [],
): EnvGroupState {
  const group = ENV_GROUPS.find((item) => item.groupCode === groupCode);
  if (!group) throw new Error(`夹具里没有分组 ${groupCode}`);
  return { groupCode, displayName: group.displayName, status, missing, instanceCount: status === 'EMPTY' ? 0 : 1 };
}

function envDetailInstance(
  instanceCode: string,
  displayName: string,
  sortOrder = 0,
): EnvDetailInstance {
  return {
    instanceCode,
    displayName,
    enabled: true,
    sortOrder,
  };
}

const ENV_ROWS: EnvRow[] = [
  {
    envCode: 'cameroon-uat',
    displayName: '喀麦隆 UAT',
    description: '组件类信息配齐，另挂了一个业务键。',
    enabled: true,
    sortOrder: 10,
    updatedAtMs: 1_790_065_068_650,
    updatedBy: 'console',
    readyKeys: 4,
    requiredKeys: 4,
    groups: [
      envGroupState('k8s', 'READY'),
      envGroupState('magic', 'READY'),
      envGroupState('nacos', 'READY'),
      envGroupState('biz', 'READY'),
    ],
  },
  {
    /* 只缺一项，而且缺的是一个凭据 —— 页面必须点名「访问令牌」。 */
    envCode: 'ghana-uat',
    displayName: '加纳 UAT',
    description: '在用 k8s 与 magic，但还缺两项必填。',
    enabled: true,
    sortOrder: 20,
    updatedAtMs: 1_790_065_347_932,
    updatedBy: 'console',
    readyKeys: 2,
    requiredKeys: 4,
    groups: [
      envGroupState('k8s', 'PARTIAL', ['访问令牌']),
      envGroupState('magic', 'READY'),
      envGroupState('nacos', 'EMPTY', ['密码']),
      envGroupState('biz', 'EMPTY'),
    ],
  },
  {
    /* 停用 + 一条值都没有：完整度是灰的，且与「缺必填项」（橙）不是同一句话。 */
    envCode: 'ghana-prod',
    displayName: '加纳生产环境',
    description: null,
    enabled: false,
    sortOrder: 30,
    updatedAtMs: 1_790_065_347_932,
    updatedBy: 'console',
    readyKeys: 0,
    requiredKeys: 4,
    groups: [
      envGroupState('k8s', 'EMPTY', ['集群地址', '访问令牌']),
      envGroupState('magic', 'EMPTY', ['取数地址']),
      envGroupState('nacos', 'EMPTY', ['密码']),
      envGroupState('biz', 'EMPTY'),
    ],
  },
];

/* 实例编辑弹窗的数据源；环境详情不再携带这些明文值。 */
const K8S_VALUES: EnvKeyValue[] = [
  {
    keyCode: 'url',
    label: '集群地址',
    valueType: 'STRING',
    required: true,
    secret: false,
    value: 'https://cmr-uat-k8s.example.internal/kubernetes/global',
  },
  {
    keyCode: 'token',
    label: '访问令牌',
    valueType: 'STRING',
    required: true,
    secret: true,
    value: 'smoke-not-a-real-token',
  },
  {
    keyCode: 'clusterName',
    label: '集群名',
    valueType: 'STRING',
    required: false,
    secret: false,
    value: null,
  },
];

/* 编辑抽屉的数据源。只配 cameroon-uat 一条：点这一行就等于验证了请求带对了 envCode。 */
const ENV_DETAIL: EnvDetail = {
  envCode: 'cameroon-uat',
  displayName: '喀麦隆 UAT',
  description: '组件类信息配齐，另挂了一个业务键。',
  enabled: true,
  sortOrder: 10,
  createdAtMs: 1_790_000_000_000,
  updatedAtMs: 1_790_065_068_650,
  createdBy: 'console',
  updatedBy: 'console',
  groups: [
    {
      groupCode: 'k8s',
      displayName: 'Kubernetes',
      instances: [
        envDetailInstance('default', '默认', 0),
        envDetailInstance('backup', '备用集群', 10),
      ],
    },
    {
      groupCode: 'magic',
      displayName: 'Magic',
      instances: [envDetailInstance('default', '默认', 0)],
    },
    {
      groupCode: 'nacos',
      displayName: 'Nacos',
      instances: [envDetailInstance('default', '默认', 0)],
    },
    {
      groupCode: 'biz',
      displayName: '业务参数',
      instances: [envDetailInstance('default', '默认', 0)],
    },
  ],
};

/* 第二个环境的绑定夹具：用于环境复制/详情读取，不再参与实例配置回填。 */
const ENV_DETAIL_GHANA: EnvDetail = {
  ...ENV_DETAIL,
  envCode: 'ghana-uat',
  displayName: '加纳 UAT',
};

const ENV_INSTANCE_DEFAULT: EnvInstanceDetail = {
  groupCode: 'k8s',
  groupDisplayName: 'Kubernetes',
  instanceCode: 'default',
  displayName: '默认',
  enabled: true,
  sortOrder: 0,
  values: K8S_VALUES,
};

/* 页面「分组实例」独立维护区的数据源，实例是分组级元数据，与环境无关。 */
const ENV_INSTANCES: EnvInstanceRow[] = [
  {
    groupCode: 'k8s',
    groupDisplayName: 'Kubernetes',
    instanceCode: 'default',
    displayName: '默认',
    enabled: true,
    sortOrder: 0,
  },
  {
    groupCode: 'k8s',
    groupDisplayName: 'Kubernetes',
    instanceCode: 'backup',
    displayName: '备用集群',
    enabled: true,
    sortOrder: 10,
  },
  {
    groupCode: 'magic',
    groupDisplayName: 'Magic',
    instanceCode: 'default',
    displayName: '默认',
    enabled: true,
    sortOrder: 0,
  },
  {
    groupCode: 'nacos',
    groupDisplayName: 'Nacos',
    instanceCode: 'default',
    displayName: '默认',
    enabled: true,
    sortOrder: 0,
  },
  {
    groupCode: 'biz',
    groupDisplayName: '业务参数',
    instanceCode: 'default',
    displayName: '默认',
    enabled: true,
    sortOrder: 0,
  },
];
/*
 * 工作流：清单 / 详情 / 一次运行。
 *
 * spec 给的是「agent → 条件 → agent」这条三段图，<b>不是</b>空 spec：设计器页会把 nodes
 * 铺到画布上、把 edges 铺进连线面板，空 spec 恰好测不到这两块 —— 而它们正是这一页
 * 最容易写错的地方（SVG 分层布局、出边顺序、表达式列）。
 *
 * 运行状态用后端真实的字面量：triggerType=manual、policy=fail_fast、节点态 SUCCEEDED/SKIPPED。
 * 自编一套（比如 "MANUAL"）会让夹具与后端悄悄分叉，这个测试就退化成骗自己。
 */
const WORKFLOW_ROW: WorkflowRow = {
  workflowKey: 'wf-test',
  displayName: '冒烟测试工作流',
  description: '冒烟测试用的三段图',
  status: 'PUBLISHED',
  version: 2,
  publishedVersion: 2,
  publishedAtMs: 1_790_047_793_967,
  updatedAtMs: 1_790_047_793_967,
  nodeCount: 3,
  edgeCount: 3,
};

const WORKFLOW_DETAIL: WorkflowEntity = {
  workflowKey: 'wf-test',
  displayName: '冒烟测试工作流',
  description: '冒烟测试用的三段图',
  status: 'PUBLISHED',
  version: 2,
  publishedVersion: 2,
  publishedAtMs: 1_790_047_793_967,
  createdAtMs: 1_790_047_789_046,
  updatedAtMs: 1_790_047_793_967,
  createdBy: 'console',
  updatedBy: 'console',
  spec: {
    nodes: [
      { key: 'step1', type: 'agent', label: '拉取工时', agentId: 'test_agent' },
      { key: 'gate', type: 'condition', label: '月份是否合法', condition: 'input.month != null' },
      { key: 'step2', type: 'agent', label: '写回报表', agentId: 'test_agent' },
    ],
    edges: [
      { from: 'step1', to: 'gate' },
      /* 条件节点的出边按声明顺序求值：有条件的那条在前，兜底边（不写条件）在后 */
      { from: 'gate', to: 'step2', condition: 'input.month != null' },
      { from: 'gate', to: 'step1' },
    ],
  },
};

const WORKFLOW_RUN_ROW: WorkflowRunRow = {
  runId: 'smoke-wf-1',
  workflowKey: 'wf-test',
  revision: 2,
  triggerType: 'manual',
  triggerRef: '页面试跑',
  /* 整次运行共用一个会话键，形如 wf-<runId> —— 这是后端 buildSessionId 的规则 */
  sessionId: 'wf-smoke-wf-1',
  userId: null,
  state: 'SUCCEEDED',
  input: { month: '2026-09' },
  output: { text: '工时核对通过' },
  failureCode: null,
  failureMessage: null,
  policy: 'fail_fast',
  startedAtMs: 1_790_047_793_967,
  endedAtMs: 1_790_047_796_967,
  createdAtMs: 1_790_047_793_967,
};

const WORKFLOW_RUN_NODES: WorkflowRunNodeRow[] = [
  {
    id: 1,
    runId: 'smoke-wf-1',
    nodeKey: 'step1',
    nodeType: 'agent',
    state: 'SUCCEEDED',
    input: null,
    output: { text: '本月工时 168h' },
    branchTaken: null,
    failureCode: null,
    failureMessage: null,
    /* agent 节点的执行链路 id：页面上从节点直接跳到 /traces/<runId> */
    agentRunId: 'smoke-run-1',
    startedAtMs: 1_790_047_793_967,
    endedAtMs: 1_790_047_795_000,
  },
  {
    id: 2,
    runId: 'smoke-wf-1',
    nodeKey: 'gate',
    nodeType: 'condition',
    state: 'SUCCEEDED',
    input: null,
    output: null,
    /* condition 节点明确写出选了哪条出边 */
    branchTaken: 'step2',
    failureCode: null,
    failureMessage: null,
    agentRunId: null,
    startedAtMs: 1_790_047_795_000,
    endedAtMs: 1_790_047_795_010,
  },
  {
    id: 3,
    runId: 'smoke-wf-1',
    nodeKey: 'step2',
    nodeType: 'agent',
    state: 'SKIPPED',
    input: null,
    output: null,
    branchTaken: null,
    failureCode: null,
    failureMessage: null,
    agentRunId: null,
    startedAtMs: null,
    endedAtMs: null,
  },
];

const WORKFLOW_RUN_DETAIL: WorkflowRunDetail = {
  run: WORKFLOW_RUN_ROW,
  nodes: WORKFLOW_RUN_NODES,
};

const RESPONSES: Record<string, unknown> = {
  /* 工作流：四个 pathname 互不为前缀（/runs 与 /versions 各是一段），按精确匹配不会串。 */
  '/api/workflows': [WORKFLOW_ROW],
  '/api/workflows/wf-test': WORKFLOW_DETAIL,
  '/api/workflows/wf-test/runs': [WORKFLOW_RUN_ROW],
  '/api/workflows/wf-test/versions': [],
  '/api/workflow-runs/smoke-wf-1': WORKFLOW_RUN_DETAIL,
  /* 工作区：三个接口的 pathname 互不为前缀，夹具按 pathname 精确匹配不会串。 */
  '/api/workspace/agents': WORKSPACE_AGENTS,
  '/api/workspace/users': WORKSPACE_USERS,
  '/api/workspace/files': WORKSPACE_DIR,
  '/api/workspace/file': WORKSPACE_FILE,

  '/api/overview': OVERVIEW,
  '/api/models': MODEL_ROWS,
  /* 与 /api/models/{key} 同前缀不同 pathname：夹具按 pathname 精确匹配，不会串 */
  '/api/models/defaults': MODEL_DEFAULTS,
  '/api/models/ds-flash': MODEL_DETAIL,
  '/api/models/ds-flash/versions': [],
  '/api/agents': [REACT_AGENT, HARNESS_AGENT],
  '/api/agents/test_agent': REACT_BUNDLE,
  '/api/agents/smoke_harness': HARNESS_BUNDLE,
  '/api/agents/test_agent/versions': [],
  '/api/agents/smoke_harness/versions': [],
  '/api/agents/tools/available': TOOLS,
  '/api/resources/prompts': PROMPTS,
  '/api/resources/skills': SKILLS,
  '/api/resources/mcp': MCPS,
  '/api/resources/middleware': MIDDLEWARE_CHAIN,
  '/api/resources/middleware/catalog': MIDDLEWARE_CATALOG,
  '/api/channels': CHANNELS,
  '/api/channels/types': CHANNEL_TYPES,
  '/api/gateway': GATEWAY,
  '/api/traces': [RUN_SUMMARY],
  '/api/traces/smoke-run-1': RUN_INFO,
  '/api/traces/smoke-run-1/events': { events: RUN_EVENTS, hasEarlier: false },
  '/api/state/database': { database: 'md_agent_state' },
  '/api/state/tables': STATE_TABLES,
  '/api/state/sessions': STATE_SESSIONS,
  '/api/state/sessions/detail': STATE_DETAIL,
  /* 原文是按钮触发的单独一次请求；夹具给一段能看出"是库里的原文"的文本即可。 */
  '/api/state/sessions/raw': '{"session_id":"conv-basic","context":[]}',
  /* 对话页回放会话时拉的完整消息（与上面那条 raw 的用途完全不同，见 api/state.ts） */
  '/api/state/sessions/messages': STATE_MESSAGES,
  /*
   * 环境目录：清单 / 详情 / 分组模板。三个 pathname 互不为前缀，按精确匹配不会串。
   * 详情带明文值，只给 cameroon-uat 一条，点其它行会落到 404 —— 这本身也是一种保护。
   */
  '/api/environments': ENV_ROWS,
  '/api/environments/cameroon-uat': ENV_DETAIL,
  '/api/environments/ghana-uat': ENV_DETAIL_GHANA,
  '/api/env-groups': ENV_GROUPS,
  '/api/env-instances': ENV_INSTANCES,
  '/api/env-groups/k8s/instances/default': ENV_INSTANCE_DEFAULT,
  '/api/sessions': SESSION_PAGE,
  '/api/sessions/detail': SESSION_DETAIL,
};

function installFetchStub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // 只按 pathname 匹配：query 上的 limit / after 是分页细节，夹具不区分
      const pathname = new URL(raw, 'http://localhost').pathname;
      const hit = RESPONSES[pathname];
      if (hit === undefined) {
        return new Response(JSON.stringify({ error: `冒烟测试没有为 ${pathname} 准备夹具` }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(hit), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

// ==================================================================================
// 挂载
// ==================================================================================

/**
 * 等取数落地。
 *
 * 执行链路的演示分支有 120ms 的假时延，
 * 只 flushPromises 是不够的 —— 那时 promise 还没被 resolve。
 * 这里用真定时器等一小段，而不是 fake timers：本测试关心的是「页面最终长什么样」，
 * 不关心时序，fake timers 只会引入「谁在什么时候推进时间」的新麻烦。
 */
async function settle(ms = 220): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await flushPromises();
  await nextTick();
}

/**
 * @param seed 挂载前先往查询缓存里塞一次数据，用来复刻「详情已经在缓存里」这个时点。
 *
 * <p>为什么需要它：同一个页面<b>第二次</b>进入时，详情往往是缓存里现成的，挂载时就有值。
 * 而默认的挂载路径里缓存是空的、数据总是"后到" —— 这两者对 watch 来说是完全不同的两个时点，
 * 只测后者就会漏掉整类 bug（工作流设计器在 2026-09-24 就是这么空过一次）。
 */
async function mountRoute(
  path: string,
  seed?: (client: QueryClient) => void,
): Promise<VueWrapper> {
  await router.push(path);
  await router.isReady();

  // 每个用例一个全新的 QueryClient：共用的话上一个用例缓存下来的数据会漏进下一个，
  // 于是「页面自己取数」这件事就不再被测到了。
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // 生产配置是 retry: 1，测试里关掉：夹具故意漏配的路径不该重试两遍才失败
        retry: false,
        staleTime: 0,
        refetchOnWindowFocus: false,
      },
    },
  });
  seed?.(queryClient);

  const wrapper = mount(AppShell, {
    global: {
      plugins: [router, ElementPlus, [VueQueryPlugin, { queryClient }]],
    },
  });
  await settle();
  return wrapper;
}

/** 失败时把错误边界里那句话带出来，否则只能看到「期望 false，实际 true」。 */
function crashMessage(wrapper: VueWrapper): string {
  return wrapper.find('.crash__msg').exists()
    ? `页面掉进了错误边界：${wrapper.find('.crash__msg').text()}`
    : '';
}

interface RouteCase {
  path: string;
  /** 当前标签标题（由 app/tabs.ts 的 tabTitleForRoute 决定）。 */
  title: string;
  /** 页面名，只用于测试名可读性。 */
  page: string;
}

let warnSpy: MockInstance;

/*
 * 挂载超时。
 *
 * 一次挂载要把整个 Element Plus 的表单/表格在 jsdom 里建出来，AgentDetailPage
 * 这种几百行的表单实测要 3~5 秒 —— vitest 默认的 5 秒会把「慢」误判成「挂死」。
 * 只给这一层放宽，纯函数单测那边仍然用默认值：那里超时就是真的出问题了。
 */
const MOUNT_TIMEOUT_MS = 20_000;

// 按文件放宽，而不是改 vitest.config.ts 的全局值 ——
// 全局放宽会让别的测试「挂死」时也要等 20 秒才报红。
vi.setConfig({ testTimeout: MOUNT_TIMEOUT_MS });

/*
 * Vue 在「模板里用了没有导入的组件」时只打一条 warn，DOM 上完全看不出来 ——
 * 那一块会被渲染成空。于是「错误态里少了一个卡片」这种缺陷永远不会变红：
 * AgentDetailPage 就漏导入过 AppCard，读取失败时本该显示的提示卡直接消失。
 * 所以把 warn 提成断言：未解析的组件必须让测试失败。
 */
function spyOnWarnings(): MockInstance {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

function verifyNoUnresolvedComponents(spy: MockInstance): void {
  const unresolved = spy.mock.calls
    .map((call) => String(call[0]))
    .filter((text) => text.includes('Failed to resolve component'));
  spy.mockRestore();
  expect(unresolved, `模板里有组件没有导入：\n${unresolved.join('\n')}`).toEqual([]);
}

/*
 * 覆盖 router.ts 里的全部路由。带参数的路由各给一个真实存在的 id，
 * 否则测的是「错误态能不能渲染」，而不是页面本身。
 */
const CASES: RouteCase[] = [
  { path: '/', title: '概览', page: 'OverviewPage' },
  { path: '/chat', title: '对话', page: 'ChatPage' },
  { path: '/chat/test_agent', title: '对话', page: 'ChatPage（带 agent）' },
  { path: '/traces', title: '执行链路', page: 'TracesPage' },
  { path: '/traces/smoke-run-1', title: '链路详情 · smoke-run-1', page: 'TraceDetailPage' },
  { path: '/sessions', title: '会话记录', page: 'SessionsPage' },
  { path: '/agents', title: 'Agents', page: 'AgentsPage' },
  { path: '/agents/test_agent', title: 'Agent 详情 · test_agent', page: 'AgentDetailPage（REACT）' },
  { path: '/agents/test_agent?tab=runtime', title: 'Agent 详情 · test_agent', page: 'AgentDetailPage（运行时页）' },
  { path: '/agents/test_agent?tab=memory', title: 'Agent 详情 · test_agent', page: 'AgentDetailPage（上下文与记忆页）' },
  { path: '/harness', title: 'Harness 工作台', page: 'HarnessPage' },
  { path: '/harness/smoke_harness', title: 'Harness 工作台 · smoke_harness', page: 'AgentDetailPage（HARNESS 入口）' },
  { path: '/harness/smoke_harness?tab=workspace', title: 'Harness 工作台 · smoke_harness', page: '编排域 · 工作区页' },
  { path: '/harness/smoke_harness?tab=subagents', title: 'Harness 工作台 · smoke_harness', page: '编排域 · 子 Agent 页' },
  { path: '/workspace', title: '工作区', page: 'WorkspacePage（列表）' },
  { path: '/workspace/smoke_harness', title: '工作区 · smoke_harness', page: 'WorkspaceDetailPage（详情）' },
  { path: '/workflows', title: '工作流', page: 'WorkflowsPage' },
  { path: '/workflows/wf-test', title: '工作流 · wf-test', page: 'WorkflowDesignerPage（设计）' },
  { path: '/tools', title: '工具', page: 'ToolsPage' },
  { path: '/skills', title: 'Skills', page: 'SkillsPage' },
  { path: '/prompts', title: 'Prompt', page: 'PromptsPage' },
  { path: '/mcp', title: 'MCP 服务', page: 'McpPage' },
  { path: '/middleware', title: 'Middleware', page: 'MiddlewarePage' },
  { path: '/channels', title: 'Channels', page: 'ChannelsPage' },
  { path: '/gateway', title: 'Gateway', page: 'GatewayPage' },
  { path: '/models', title: '模型', page: 'ModelsPage' },
  { path: '/environments', title: '环境', page: 'EnvironmentsPage' },
  { path: '/storage', title: '状态存储', page: 'StoragePage（列表）' },
  { path: '/storage/test_agent', title: '状态存储 · test_agent', page: 'StorageTablePage（表详情）' },
  { path: '/storage/test_agent/codex:conv-basic', title: '会话详情 · codex:conv-basic', page: 'StorageSessionPage（会话详情）' },
];

describe('全部路由都能渲染', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it.each(CASES)('$path （$page）渲染正常，当前标签为「$title」', async (routeCase) => {
    const wrapper = await mountRoute(routeCase.path);
    try {
      expect(wrapper.find('.crash').exists(), crashMessage(wrapper)).toBe(false);
      expect(wrapper.find('.tab.on .tab__t').text()).toBe(routeCase.title);
    } finally {
      // 不卸载的话下一次 mount 会与上一棵树共存，queryClient 的 watcher 也在跑
      wrapper.unmount();
    }
  });
});

describe('工作流设计器把 spec 画成图', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  /*
   * 画布是手写的 SVG：列深由 depthOf 现算、线是三次贝塞尔 + 箭头 marker。
   * 这条断言钉的是「spec 里的 nodes / edges 真的被铺到了画布上」——
   * 布局算法写错（入度没减、有环时漏节点、按最短路径分层）时节点数会变，
   * 而 vue-tsc 与纯函数单测都看不见这件事。
   */
  it('节点与连线按 spec 铺到画布上', async () => {
    const wrapper = await mountRoute('/workflows/wf-test');
    try {
      expect(wrapper.findAll('.nbox')).toHaveLength(3);
      expect(wrapper.findAll('.wire')).toHaveLength(3);
      expect(wrapper.text()).toContain('拉取工时');
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 边的声明顺序有语义：condition 节点的出边按这个顺序求值、取第一条成立的，
   * 所以「兜底边排在最后」是正确性要求而不是排版偏好。顺序由后端原样保存，
   * 页面就必须原样呈现 —— 一旦在这里排序或去重，表现是分支被静默跳过，
   * 而画布上完全看不出来。
   */
  it('连线列表保持库里的顺序', async () => {
    const wrapper = await mountRoute('/workflows/wf-test');
    try {
      const edges = wrapper.findAll('.orow__edge').map((item) => item.text());
      expect(edges).toEqual(['step1 → gate', 'gate → step2', 'gate → step1']);
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 「运行入口」必须在页头。
   *
   * 这是 2026-09-24 的真实反馈：「创建好了 workflow，但没有运行的地方」——
   * 那时「运行」只存在于默认不激活的「运行记录」tab 里，页头四个按钮
   * （保存草稿 / 校验 / 发布 / 删除）里没有它。功能是好的，发现路径断了：
   * 非激活 tab 的内容照样在 DOM 里，只是肉眼看不到，所以"有没有"必须靠断言钉住。
   */
  it('页头就有「运行」，已发布且无改动时可点', async () => {
    const wrapper = await mountRoute('/workflows/wf-test');
    try {
      const run = headerRunButton(wrapper);
      expect(run, '页头没有「运行」按钮').toBeTruthy();
      expect(run!.attributes('disabled')).toBeUndefined();
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 草稿一改就不给跑：运行跑的是线上那一版，脏草稿跑出来的是旧内容。
   * 两个按钮一起吃这条判断 —— 只改一处会得到"页头灰着、tab 里还能点"的自相矛盾，
   * 所以两边都断言。
   *
   * 「还没发布过」那一支走的是 publishedVersion，而夹具是已发布的，这里覆盖不到；
   * 它由 workflowRunBlockedReason 的第一个分支负责，清单页那侧另有断言。
   */
  it('有未保存改动时，页头与运行记录里的两个「运行」一起灰掉', async () => {
    const wrapper = await mountRoute('/workflows/wf-test');
    try {
      expect(headerRunButton(wrapper)!.attributes('disabled')).toBeUndefined();

      // 「+ 汇合」加一个节点：最省事的"让草稿变脏"的方式，不必去定位某个输入框
      await clickButton(wrapper, '+ 汇合');

      expect(headerRunButton(wrapper)!.attributes('disabled')).toBeDefined();
      expect(tabRunButton(wrapper)!.attributes('disabled')).toBeDefined();
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 详情已经在缓存里时，草稿也必须被灌进去。
   *
   * 这是 2026-09-24 的真实故障：出数用的是 watch(detail)，而 watch 只在"变化"时才触发。
   * 第二次进入同一个工作流（staleTime 15s 内、或从清单页点回来）时 detail 挂载时就有值，
   * 回调永远不跑 —— 用户看到的是"点进详情，信息是空的"：画布「还是一张空图」、连线 0 条、
   * 标题回落成 workflow-key，页头还挂一个假的「有未保存改动」。
   *
   * 两个细节都是为了真的复刻那个时点：
   *
   * <ol>
   *   <li><b>预置缓存</b>：让 detail 在挂载时就有值；</li>
   *   <li><b>让后续请求永远不返回</b>：测试环境的 staleTime 是 0，预置的那份立刻算过期，
   *       不挡住重取的话 data 会换成一个新对象、watch 又被触发，bug 反而躲过去了 ——
   *       线上之所以会中招，正是因为 15s 内那份是"新鲜"的、根本不会重取。</li>
   * </ol>
   */
  it('详情已在缓存里时（第二次进入），草稿照样被灌进去', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    const wrapper = await mountRoute('/workflows/wf-test', (client) => {
      client.setQueryData(queryKeys.workflow('wf-test'), WORKFLOW_DETAIL);
    });
    try {
      expect(wrapper.find('h1').text()).toBe('冒烟测试工作流');
      expect(wrapper.findAll('.nbox')).toHaveLength(3);
      expect(wrapper.findAll('.orow__edge')).toHaveLength(3);
      expect(wrapper.text()).not.toContain('还是一张空图');
    } finally {
      wrapper.unmount();
    }
  });
});

/*
 * 运行入口也要在清单页 —— 那是进工作流模块的第一屏。
 *
 * 2026-09-24 的反馈连提了两次：「创建好了 workflow，但没有运行的地方」。
 * 第一次只补了设计器页头，而人是从清单页找的，所以还是找不到。
 * 这条走完整条路：点「运行」→ 落到设计器的运行记录 tab → 对话框自己弹开。
 */
describe('工作流清单页的运行入口', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('行操作里有「运行」，点它落到运行记录 tab 并把对话框弹开', async () => {
    const wrapper = await mountRoute('/workflows');
    try {
      await clickRowButton(wrapper, '冒烟测试工作流', '运行');
      // 跳过去之后设计器还要取一次详情，再决定弹不弹
      await settle();

      // 落点必须是运行记录 tab，而不是设计器默认的「设计」
      expect(wrapper.find('#pane-runs').exists(), '没落到运行记录 tab').toBe(true);

      // 对话框只在打开时才会被渲染（destroy-on-close），所以 exists 就是"弹开了"的证据
      const dialog = wrapper.find('.el-dialog');
      expect(dialog.exists(), `没有弹出运行对话框${crashMessage(wrapper)}`).toBe(true);
      expect(dialog.find('.el-dialog__title').text()).toBe('运行一次');

      // run 参数用过就清掉：留着的话刷新或按后退会再弹一次，而用户并没有想再跑一遍
      expect(router.currentRoute.value.query.tab).toBe('runs');
      expect(router.currentRoute.value.query.run).toBeUndefined();
    } finally {
      wrapper.unmount();
    }
  });
});

describe('今天改过的那几处仍在正确位置', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  /*
   * 技能策略三项（dynamicSkillsEnabled / skillCodeExecutionEnabled / skillWorkDir）
   * 2026-09-22 从 md_agent_workspace 迁到 md_agent_runtime。
   * 它们曾经落在 HARNESS 专有的「工作区」页里，于是 REACT agent 根本够不着
   * （那个 tab 挂着 v-if="isHarness"）。这条断言钉的是「REACT 打开运行时页就能看到它」。
   */
  it('REACT 的「运行时」页有技能策略三项', async () => {
    const wrapper = await mountRoute('/agents/test_agent?tab=runtime');
    try {
      expect(wrapper.text()).toContain('技能策略（REACT 专有）');
      expect(wrapper.text()).toContain('skill-work-dir');
    } finally {
      wrapper.unmount();
    }
  });

  /* 反方向：HARNESS 不该看到 REACT 专有的那几项，配了也不生效。 */
  it('HARNESS 的「运行时」页不出现 REACT 专有项', async () => {
    const wrapper = await mountRoute('/harness/smoke_harness?tab=runtime');
    try {
      expect(wrapper.text()).not.toContain('技能策略（REACT 专有）');
      expect(wrapper.text()).not.toContain('冲突策略（REACT 专有）');
    } finally {
      wrapper.unmount();
    }
  });

  /* 编排三域只属于 HARNESS：REACT 打开同一个组件时不该冒出来。 */
  it('REACT 详情页没有编排三域的 tab', async () => {
    const wrapper = await mountRoute('/agents/test_agent');
    try {
      const tabs = wrapper.findAll('.el-tabs__item').map((item) => item.text());
      expect(tabs).toContain('运行时');
      expect(tabs).not.toContain('工作区');
      expect(tabs).not.toContain('子 Agent');
    } finally {
      wrapper.unmount();
    }
  });

  it('HARNESS 详情页有编排三域的 tab', async () => {
    const wrapper = await mountRoute('/harness/smoke_harness');
    try {
      const tabs = wrapper.findAll('.el-tabs__item').map((item) => item.text());
      expect(tabs).toContain('上下文与记忆');
      expect(tabs).toContain('工作区');
      expect(tabs).toContain('子 Agent');
    } finally {
      wrapper.unmount();
    }
  });
});

/*
 * 两个列表页各管各的类型。
 *
 * <p>夹具里刻意放了一个 REACT 和一个 HARNESS：数组里都有，"少渲染了谁"才看得出来。
 * 只放一种的话，页面即使把筛选写反了也照样绿。
 */
describe('两个列表页面各管各的类型', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('Agents（能力型）只列 REACT', async () => {
    const wrapper = await mountRoute('/agents');
    try {
      expect(wrapper.text()).toContain('test_agent');
      expect(wrapper.text()).not.toContain('smoke_harness');
    } finally {
      wrapper.unmount();
    }
  });

  it('Harness 工作台只列 HARNESS', async () => {
    const wrapper = await mountRoute('/harness');
    try {
      expect(wrapper.text()).toContain('smoke_harness');
      expect(wrapper.text()).not.toContain('test_agent');
    } finally {
      wrapper.unmount();
    }
  });
});

/*
 * 设计器页面上有两个运行按钮：页头叫「运行」，「运行记录」里叫「运行一次」。
 * 所以定位一律用文字<b>精确</b>匹配 —— 用 includes('运行') 会先撞上先渲染的那个，
 * 而"页头到底有没有"正是要断言的事，认错了按钮整条断言就失去意义。
 */
function headerRunButton(wrapper: VueWrapper): DOMWrapper<Element> | undefined {
  return wrapper.findAll('button').find((item) => item.text() === '运行');
}

function tabRunButton(wrapper: VueWrapper): DOMWrapper<Element> | undefined {
  return wrapper.findAll('button').find((item) => item.text() === '运行一次');
}

/** 按可见文字点一个 button（el-button 渲染出来就是 <button>，文案在里面）。 */
async function clickButton(wrapper: VueWrapper, label: string): Promise<void> {
  const target = wrapper.findAll('button').find((item) => item.text().includes(label));
  expect(target, `页面上找不到「${label}」按钮`).toBeTruthy();
  await target!.trigger('click');
  await settle();
}

/** 点某一行的某个按钮：先按行的文字定位，再在行内找按钮。 */
async function clickRowButton(wrapper: VueWrapper, rowText: string, label: string): Promise<void> {
  const row = wrapper.findAll('.el-table__row').find((item) => item.text().includes(rowText));
  expect(row, `表格里找不到包含「${rowText}」的行`).toBeTruthy();
  const target = row!.findAll('button').find((item) => item.text().includes(label));
  expect(target, `「${rowText}」那一行找不到「${label}」按钮`).toBeTruthy();
  await target!.trigger('click');
  await settle();
}

/*
 * 渠道表单的「行为参数」按类型显示。
 *
 * <p>dmScope 与回复风格是渠道表上的全局列，但并非每个类型都会读它们：
 * 回调式的回复由官方 outbound 渲染（不看回复风格），长连接机器人的会话由本项目渲染器自己算
 * （不看 dmScope，配了只进一行日志）。这两条断言钉的是「页面上不再出现填了不生效的控件」——
 * 之前它们对所有类型都渲染，用户只能去读源码才知道该不该填。
 */
describe('渠道表单按类型决定给哪些参数', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('长连接机器人：dmScope 不适用，回复风格只剩它那一种', async () => {
    const wrapper = await mountRoute('/channels');
    try {
      // 夹具里第一个类型就是 wecom-bot，所以「接入渠道」开出来就是长连接机器人
      await clickButton(wrapper, '接入渠道');
      const text = wrapper.text();
      // 标签后面紧跟的就是"该类型不适用"—— 钉的是"消失的正好是 dmScope 这一项"
      expect(text).toContain('单聊会话范围（dmScope）该类型不适用');
      // 原因说明属于解释性小字，不在表单里平铺
      expect(text).not.toContain('长连接机器人的会话由聊天窗口决定');
      // 唯一可选的回复风格被预填，用户不必再点一次下拉去选它
      expect(text).toContain('WECOM_THINK');
      // 绑定表里的「会话范围」列同样不出现（绑定的 sessionScope 与渠道级 dmScope 同源）
      const headers = wrapper.findAll('th').map((item) => item.text());
      expect(headers).not.toContain('会话范围');
    } finally {
      wrapper.unmount();
    }
  });

  it('回调式：dmScope 照常出现，回复风格不适用', async () => {
    const wrapper = await mountRoute('/channels');
    try {
      await clickRowButton(wrapper, 'wecom-main', '编辑');
      const text = wrapper.text();
      expect(text).toContain('回复风格该类型不适用');
      expect(text).not.toContain('回复由官方 outbound 发送');
      // 回调式支持 dmScope，所以绑定表的「会话范围」列要在
      const headers = wrapper.findAll('th').map((item) => item.text());
      expect(headers).toContain('会话范围');
    } finally {
      wrapper.unmount();
    }
  });
});

/*
 * 状态存储：列表 → 表详情 → 会话详情，三级。
 *
 * 这一块 2026-09-22 从「部署形态盘点」改成了真实的状态管理器：旧版把
 * 「状态在本地文件、MySQL 只给工具用」写死在前端文案里，那是当时的事实，
 * 一旦状态搬进 md_agent_state 就变成一句理直气壮的假话。
 * 2026-09-23 又把原来「一页两栏 + 抽屉」拆成三级页面，于是多出两类要钉的东西：
 *
 * <ol>
 *   <li><b>每一级只放自己那一级的东西</b>。列表页只列表、不列会话 ——
 *       两件事混在一页上时，「某张表有没有数据」与「某个会话里有什么」会互相干扰。
 *       这条最容易在重构里悄悄退回去（把会话表搬回列表页，页面看起来照样正常）。</li>
 *   <li><b>地址仍然对得上</b>。表进路径（/storage/X）、会话 ID 进关键字，
 *       还有老地址 /storage?table=X 的原地换址 —— 三者任一断掉，用户手上已有的
 *       书签与别处贴过的链接就会静默落到错的页面上。</li>
 * </ol>
 */
describe('状态存储页读的是库里的状态', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('列表页只显示状态表清单，会话不再出现在这一级', async () => {
    const wrapper = await mountRoute('/storage');
    try {
      const text = wrapper.text();
      expect(text).not.toContain('md_agent_state');
      expect(text).toContain('test_agent');
      /* 声明了状态存储但表还没被框架建出来的 agent 也要在清单里，否则用户以为配置没生效 */
      expect(text).toContain('new_agent');
      expect(text).toContain('尚未创建');
      /* 列表的单位是「表」：两张表各一行 */
      expect(wrapper.findAll('.el-table__row').length, '两张状态表各一行').toBe(2);
      /* 会话属于下一级：混在列表页上会让「哪些表」和「某会话里有什么」两件事互相干扰 */
      expect(text).not.toContain('conv-basic');
    } finally {
      wrapper.unmount();
    }
  });

  it('点「查看」进表详情，会话清单与状态表信息都来自接口', async () => {
    const wrapper = await mountRoute('/storage');
    try {
      await clickRowButton(wrapper, 'test_agent', '查看');
      expect(router.currentRoute.value.path).toBe('/storage/test_agent');
      const text = wrapper.text();
      expect(text).toContain('test_agent');
      expect(text).toContain('conv-basic');
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 原文必须是「点了才拉」。
   *
   * MB 级的 state_data 跟详情一起拉，等于每点一次详情就传一份完整上下文；
   * 这条断言钉的是那个按钮真的在做事，而不是只渲染了一个装饰性的按钮。
   */
  it('会话详情页里，点「读取原文」才去拉原始 JSON，并渲染出来', async () => {
    const wrapper = await mountRoute('/storage/test_agent/codex:conv-basic');
    try {
      /*
       * 刚进页面时原文请求根本不该发出去：它是 MB 级字段，跟摘要一起拉等于
       * 每进一次会话就传一份完整上下文，而多数时候没人看它。
       */
      expect(wrapper.find('pre.j').exists()).toBe(false);

      await clickButton(wrapper, '读取原文');
      const pre = wrapper.find('pre.j');
      expect(pre.exists()).toBe(true);
      /* 夹具走 JSON.stringify 出去，原文里的引号是转义形态，断言只钉"这段文本来自夹具"。 */
      expect(pre.text()).toContain('conv-basic');
      expect(pre.text().length).toBeGreaterThan(20);
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 深链：/storage?table=X&keyword=Y。
   *
   * 「会话记录」页的「查看记忆」就是这样跳过来的 —— 那一页知道这条会话的记忆落在哪张表里。
   * 不读这两个参数的话，页面会按默认规则选中「第一张有数据的表」，
   * 于是用户从某条会话点过来、看到的是另一个 agent 的记忆，而地址栏里明明写着 table。
   * 夹具里默认会选中的是有数据的 test_agent，所以这里特意指定 new_agent（那张还没建出来的表），
   * 两者不同才能分辨"参数被用上了"和"恰好撞上默认值"。
   */
  it('深链：表进路径、关键字进查询串，两者都被直接用上', async () => {
    const wrapper = await mountRoute('/storage/new_agent?keyword=conv-basic');
    try {
      const url = lastStorageSessionsRequest();
      expect(url).toContain('table=new_agent');
      expect(url).toContain('keyword=conv-basic');
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 老地址 /storage?table=X 要跳到新路径 /storage/X。
   *
   * 书签与别处贴过的链接不会自己跟着改：不跳的话它们会静默落在列表页上，
   * 用户只会得出「跳转坏了」。这里断言 replace 之后的地址 ——
   * 顺带钉住「用 replace 而不是 push」（老地址不该在历史里留一格，
   * 否则用户点返回会回到它、又被弹回详情页，退不出去）。
   */
  it('老地址 /storage?table=X&keyword=Y 会原地换成 /storage/X?keyword=Y', async () => {
    const wrapper = await mountRoute('/storage?table=new_agent&keyword=conv-basic');
    try {
      expect(router.currentRoute.value.path).toBe('/storage/new_agent');
      expect(router.currentRoute.value.query.keyword).toBe('conv-basic');
      expect(lastStorageSessionsRequest()).toContain('table=new_agent');
    } finally {
      wrapper.unmount();
    }
  });
});

/** 最近一次打到会话列表接口的请求 URL —— 用来验「筛选是在服务端做的」。 */
function lastSessionsRequest(): string {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const urls = calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/sessions'));
  return urls[urls.length - 1] ?? '';
}

/** 最近一次打到状态会话列表接口的请求 URL；用 ? 把同前缀的 /detail 那条路径排除掉。 */
function lastStorageSessionsRequest(): string {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const urls = calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/state/sessions?'));
  return urls[urls.length - 1] ?? '';
}

/*
 * 会话记录页。
 *
 * <p>这一页是把「执行链路」与「状态存储」串起来的第三层，它的数据完全来自
 * md_agent_run 按 (user_id, session_id) 的聚合 —— 页面上任何一项都不该是前端编的。
 * 三条断言分别钉三件容易静默出错的事：
 *
 * <ol>
 *   <li><b>agent 是列表不是单选</b>。同一条会话被两个 agent 服务过时两个都要出现
 *       （实测：企微同一条会话先交给 workwx_batch_agent 又交给 deployment_agent，
 *       sessionId 没变）。写成「取第一个」页面看起来照样正常。</li>
 *   <li><b>空值要有个说法</b>。user_id 为 NULL 显示「（未分区）」，没有来源显示「未标注」——
 *       留白会被读成「页面坏了」，而这两种都是库里的正常状态。</li>
 *   <li><b>筛选在服务端</b>。「有 / 无记忆」改成在前端筛当页，页面长得一模一样，
 *       但「共 N 个会话、筛出 M 条」会开始说谎 —— 请求 URL 上带着 hasState
 *       是这件事唯一能被机器验到的证据。</li>
 * </ol>
 */
describe('会话记录页读的是 run 表的聚合', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('同一条会话服务过的多个 agent 都来自接口', async () => {
    const wrapper = await mountRoute('/sessions');
    try {
      const text = wrapper.text();
      /* 用户与会话：库里的原值 */
      expect(text).toContain('wo7U1');
      expect(text).toContain('single-abc');
      /* 两个 agent 都必须在场 —— 少一个就是「agent 是归属维度」那个错误认知 */
      expect(text).toContain('workwx_batch_agent');
      expect(text).toContain('deployment_agent');
      /* user_id 为 NULL 的会话不能显示成空白 */
      expect(text).toContain('（未分区）');
      /* 来源、记忆、执行统计都收进详情，不在清单里平铺 */
      const headers = wrapper.findAll('th').map((item) => item.text());
      expect(headers).not.toContain('来源');
      expect(headers).not.toContain('记忆');
      expect(headers).not.toContain('成功率');
      expect(headers).not.toContain('Token');
    } finally {
      wrapper.unmount();
    }
  });

  it('点详情打开抽屉，时间线与记忆清单都来自 /api/sessions/detail', async () => {
    const wrapper = await mountRoute('/sessions');
    try {
      await clickRowButton(wrapper, 'single-abc', '详情');
      const text = wrapper.text();
      expect(text).toContain('执行时间线');
      expect(text).toContain('成功');
      expect(text).toContain('失败');
      /* 失败原因必须能读到，只给一个「失败」徽标等于没说 */
      expect(text).toContain('Insufficient Balance');
      /* 记忆清单：状态表名与归属 agent */
      expect(text).toContain('记忆（状态存储）');
      expect(text).toContain('test_agent');
    } finally {
      wrapper.unmount();
    }
  });

  it('「有记忆 / 无记忆」chip 走的是服务端筛选', async () => {
    const wrapper = await mountRoute('/sessions');
    try {
      /* 打开页面时还没筛过，请求里不该出现 hasState */
      expect(lastSessionsRequest()).not.toContain('hasState');

      await clickButton(wrapper, '有记忆');
      expect(lastSessionsRequest()).toContain('hasState=true');

      /* false 不能被当成「没传」丢掉 —— 这是三态里最容易写错的那一档 */
      await clickButton(wrapper, '无记忆');
      expect(lastSessionsRequest()).toContain('hasState=false');
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 「查看记忆」这一跳是两层页面之间唯一的接口。
   *
   * 会话页知道「这条会话的记忆落在哪张表里」（来自详情的 states），状态页知道 slotId 的拼法。
   * 跳过去不带参数，用户就得自己在另一页重新找一遍 —— 而那一页默认选中的还是另一张表。
   */
  it('「查看记忆」带着表名与会话 ID 跳到状态存储页', async () => {
    const wrapper = await mountRoute('/sessions');
    try {
      await clickRowButton(wrapper, 'single-abc', '详情');
      await clickButton(wrapper, '查看记忆');
      /* 表进路径、会话 ID 进关键字：跳过去之后是一个可以刷新、可以贴给别人的地址 */
      expect(router.currentRoute.value.path).toBe('/storage/test_agent');
      expect(router.currentRoute.value.query.keyword).toBe('single-abc');
    } finally {
      wrapper.unmount();
    }
  });
});

/*
 * 概览页与模型页读的是真接口 —— 这一组钉的是"页面上不再有编出来的数字"。
 *
 * 前一版这两页是照原型页写死的演示数据（今日执行 128 次、缓存命中 61%、
 * 最慢 agent workwx_batch_agent）。那种页面的危害不是"不准确"，
 * 而是让人对着假数字排查真问题 —— 所以这里对"数字从哪来"下断言：
 * 增量由页面自己算（后端只给 today.total 与 yesterdayTotal），
 * 模型卡的每一个值都来自 /api/models 的夹具。
 */
describe('概览页与模型页读的是真接口', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  /* 6 vs 昨日 4 → 页面自己算成 +50%；这个数字在夹具里没有，只能算出来 */
  it('概览页自己算今日 vs 昨日的增量，并如实显示默认模型', async () => {
    const wrapper = await mountRoute('/');
    try {
      const text = wrapper.text();
      expect(text).toContain('较昨日 +50%');
      expect(text).toContain('1.82M');
      /* 「需要关注」来自接口的 attention 数组，不是页面上写死的文案 */
      expect(text).toContain('test_agent 已启用但从未发布');
      /* 默认模型的 key 以徽标显示，不再平铺第二行说明 */
      expect(text).toContain('ds-flash');
      expect(text).not.toContain('默认 ds-flash · 启用 1');
    } finally {
      wrapper.unmount();
    }
  });

  /* 有引用 / 有默认标记的那条必须显示出来：它是"改这个会波及谁"的唯一线索 */
  it('模型页的清单来自 /api/models', async () => {
    const wrapper = await mountRoute('/models');
    try {
      const text = wrapper.text();
      expect(text).toContain('DeepSeek V4 Flash');
      expect(text).toContain('ds-flash');
      /* 引用数、端点与更新时间属于详情，不在清单卡片上平铺 */
      expect(text).not.toContain('3 个 agent 指定');
      expect(text).not.toContain('兜底 4 个');
      expect(text).toContain('默认');
    } finally {
      wrapper.unmount();
    }
  });
});

/*
 * 工作区：列表（agent）→ 详情（文件与编辑器），两级。
 *
 * 钉三条规则，它们都是这一块能存在的前提：
 *
 * 1. 列表页的单位是 agent，不是文件。文件清单必须留在详情页 ——
 *    先看见"有哪些 agent 的工作区可维护"，再决定进哪一个，是这一页存在的理由。
 * 2. 「能写什么」完全按后端的 writable 走。夹具里 memory/ 是只读的，它那一行就不该有删除按钮；
 *    前端另抄一份白名单必然会与后端漂移，而漂移的表现是「前端说能写、后端 400」。
 * 3. 打开文件时内容来自 /api/workspace/file，且没改过时保存是禁用的 ——
 *    否则一次误点就把库里的文件原样覆盖一遍，界面报「已保存」却什么都没变。
 */
describe('工作区页读的是后端的工作区接口', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('列表页列 agent 与文件后端（不列文件），点「查看文件」进详情', async () => {
    const wrapper = await mountRoute('/workspace');
    try {
      const text = wrapper.text();
      expect(text).toContain('smoke_harness');
      /* 列表只保留配置的 fsBackend；生效文件系统与路径进详情 */
      expect(text).toContain('MySQL');
      expect(text).not.toContain('CompositeFilesystem');

      expect(wrapper.findAll('.el-table__row').length, '列表的单位是 agent，一个 agent 一行').toBe(1);
      /* 文件清单属于详情页：这一级混进来会让「有哪几个 agent」和「某个 agent 里有什么」互相干扰 */
      expect(wrapper.find('.ent__n').exists(), '文件清单不该出现在列表页上').toBe(false);

      await clickRowButton(wrapper, 'smoke_harness', '查看文件');
      expect(router.currentRoute.value.path).toBe('/workspace/smoke_harness');
    } finally {
      wrapper.unmount();
    }
  });

  it('详情页按 writable 给写入口：只读条目不渲染删除按钮', async () => {
    const wrapper = await mountRoute('/workspace/smoke_harness');
    try {
      expect(wrapper.findAll('.el-table__row').length).toBe(3);
      /* 三行里只有两条可写：AGENTS.md 与 knowledge。memory/ 属只读档。 */
      const deleteButtons = wrapper.findAll('button').filter((item) => item.text() === '删除');
      expect(deleteButtons.length, '只读条目不该渲染删除按钮').toBe(2);
    } finally {
      wrapper.unmount();
    }
  });

  it('点「打开」进编辑器，内容来自 /api/workspace/file，未改动时不能保存', async () => {
    const wrapper = await mountRoute('/workspace/smoke_harness');
    try {
      await clickRowButton(wrapper, 'AGENTS.md', '打开');
      /*
       * 内容要断言 textarea 的 value，而不是页面文字：<textarea> 的内容是 property，
       * wrapper.text() 里根本读不到它 —— 那样写出来的断言会"永远失败"或"永远通过"。
       */
      const editor = wrapper.find('textarea');
      expect(editor.exists(), '没有打开编辑器').toBe(true);
      expect((editor.element as HTMLTextAreaElement).value).toBe('# smoke harness');

      const save = wrapper.findAll('button').find((item) => item.text() === '保存');
      expect(save, '编辑器里没有保存按钮').toBeTruthy();
      expect(save!.attributes('disabled'), '没改过就不该能保存').toBeDefined();
    } finally {
      wrapper.unmount();
    }
  });

  /*
   * 隔离维度从手输框改成下拉框之后，要钉住的是三件事：
   *
   *   1. 候选值来自 /api/workspace/users（不是前端拼的角色名，也不是写死的 console）；
   *   2. 基线层是列表里的第一项 —— 它是合法视图而不是"没选"，所以清空控件与选中它等价；
   *   3. allow-create 还在：没跑过的 ID 必须能输进去，否则新用户第一次对话之前无路可走。
   *
   * 断言选的是"打开下拉再看文档里有什么"，而不是去读组件的 props：
   * 候选值是通过 el-option 的插槽渲染的，只读 props 的话，"列表是空的但代码看起来对"
   * 这种情况照样能通过。
   */
  it('隔离维度是下拉框：候选值来自 /api/workspace/users，基线层排第一，且允许手输', async () => {
    const wrapper = await mountRoute('/workspace/smoke_harness');
    try {
      const select = wrapper.findComponent({ name: 'ElSelect' });
      expect(select.exists(), '隔离维度不是下拉框').toBe(true);
      /*
       * 默认落在基线层，且控件上要**看得见**这四个字：基线层用的是哨兵值而不是空串，
       * 否则 el-select 会把它当成"没选"、只显示占位符 —— 而这一页最需要让人看明白的
       * 恰恰是"现在看的是不是基线层"。
       */
      expect(select.text(), '选中项要显示基线层').toContain('基线层');
      expect(select.props('allowCreate'), '没跑过的 ID 也要能输进去').toBe(true);

      await select.trigger('click');
      await settle();

      const dropdown = document.querySelector('.el-select-dropdown');
      expect(dropdown, '下拉框没有展开').toBeTruthy();
      const options = Array.from(dropdown!.querySelectorAll('.el-select-dropdown__item')).map(
        (item) => item.textContent ?? '',
      );
      expect(options[0], '基线层要排第一').toContain('基线层');
      expect(options.join('|')).toContain('console');
      expect(options.join('|')).toContain('wo7U1ZEQAApziTCwT6jow9UKLs0xrqlw');
      /* 次行是"日常在用"与"只留了一条历史"的唯一区分手段（9 次 vs 1 次） */
      expect(options.join('|')).toContain('9 次');
      expect(options.join('|')).toContain('1 次');
    } finally {
      wrapper.unmount();
      /* 下拉是被 teleport 到 body 上的：不收拾掉会漏进下一个用例的断言 */
      document.querySelectorAll('.el-select-dropdown').forEach((node) => node.remove());
    }
  });
});

/*
 * 环境页：分组定义模板，环境选择实例，键值在实例弹窗里按环境维护。
 *
 * 这一页的层级必须真的落到 DOM 上，而不是只存在数据结构里：
 *   - 清单按分组汇总，缺项要点名「访问令牌」而不是笼统的「缺 1 项」；
 *   - 环境抽屉只选分组与实例，键值输入收进实例编辑弹窗；
 *   - 分组编辑器能自由加分组/加键，但内置分组里的工具引用键锁死。
 *
 * 为什么这些只能靠真渲染：状态配色、分组归属、禁用态都由计算属性与模板共同决定，
 * vue-tsc 只能保证类型对，纯函数单测又碰不到组件树。
 */
describe('环境页：环境选择实例，实例自己维护固定键值', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('环境清单只展示配置概览，不展开分组和键的明细', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      const headers = wrapper.findAll('.el-table__header th').map((item) => item.text());
      expect(headers).toContain('环境');
      expect(headers, '清单只保留一列配置概览，不展开分组明细').toContain('配置概览');
      expect(headers).not.toContain('变量分组');
      expect(headers).not.toContain('必填完整度');
      expect(headers, '国家列已移除').not.toContain('国家');
      expect(headers, '阶段列已移除').not.toContain('阶段');
      expect(headers, '更新信息不进清单').not.toContain('更新');
      expect(headers, '键值已经归到分组里，页面不该再出现命名空间这一层').not.toContain('命名空间');

      const row = wrapper
        .findAll('.el-table__row')
        .find((item) => item.text().includes('加纳 UAT'));
      expect(row, '没有渲染加纳 UAT 那一行').toBeTruthy();
      const envCell = row!.findAll('td')[0];
      expect(envCell.find('.env-code').exists(), '环境名下不再挂编码小字').toBe(false);
      expect(
        row!.text(),
        '环境行不能再展开分组名称或键，只留一个数量概览',
      ).not.toContain('Kubernetes');
      expect(row!.text()).not.toContain('Magic');
      expect(row!.text()).toContain('2 / 4');
      expect(row!.find('.summary__meta').exists(), '分组数量不再平铺在清单里').toBe(false);

      /* 列序：环境 / 配置概览 / 操作 */
      const completenessBadge = (rowText: string): DOMWrapper<Element> => {
        const target = wrapper
          .findAll('.el-table__row')
          .find((item) => item.text().includes(rowText));
        expect(target, `没有渲染 ${rowText} 那一行`).toBeTruthy();
        return target!.findAll('td')[1].find('.bdg');
      };
      expect(completenessBadge('喀麦隆 UAT').classes()).toContain('ok');
      expect(completenessBadge('加纳 UAT').classes()).toContain('wait');
      expect(completenessBadge('加纳生产环境').classes()).toContain('off');

      const empty = wrapper
        .findAll('.el-table__row')
        .find((item) => item.text().includes('加纳生产环境'));
      expect(empty!.text()).toContain('0 / 4');
      expect(empty!.text()).toContain('已停用');
    } finally {
      wrapper.unmount();
    }
  });

  it('新增环境时先选分组、再选实例，不需要重复建实例', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      const createButton = wrapper
        .findAll('button')
        .find((item) => item.text() === '+ 新增环境');
      expect(createButton, '页面缺少「+ 新增环境」入口').toBeTruthy();
      await createButton!.trigger('click');
      await settle();

      const drawer = wrapper
        .findAll('.el-drawer')
        .find((item) => item.text().includes('新增环境'));
      expect(drawer, '新增环境抽屉没有打开').toBeTruthy();
      expect(drawer!.findAll('.vg').length, '新环境默认不带任何分组').toBe(0);
      expect(drawer!.text(), '空环境要提示从添加分组开始').toContain('还没有选择分组');

      const addGroup = drawer!.find('.vars__add-group');
      expect(addGroup.exists(), '空环境缺少「添加分组」按钮').toBe(true);
      await addGroup.trigger('click');
      await settle();

      const groupDialog = wrapper
        .findAll('.el-dialog')
        .find((item) => item.text().includes('添加分组'));
      expect(groupDialog, '点击添加分组后没有打开选择弹窗').toBeTruthy();
      const groupSelect = groupDialog!.findComponent({ name: 'ElSelect' });
      groupSelect.vm.$emit('update:modelValue', 'k8s');
      await settle();
      await groupDialog!
        .findAll('button')
        .find((item) => item.text() === '添加')!
        .trigger('click');
      await settle();

      const k8sGroup = drawer!
        .findAll('.vg')
        .find((item) => item.text().includes('Kubernetes'));
      expect(k8sGroup, '选中分组后应出现 Kubernetes 分组').toBeTruthy();
      expect(k8sGroup!.text(), '分组行先展示实例数量').toContain('0 个实例');

      await k8sGroup!
        .findAll('button')
        .find((item) => item.text() === '实例')!
        .trigger('click');
      await settle();
      const instanceDialog = wrapper
        .findAll('.el-dialog')
        .find((item) => item.text().includes('选择实例') && item.text().includes('Kubernetes'));
      expect(instanceDialog, '点击实例按钮后没有打开实例弹窗').toBeTruthy();
      const instanceSelect = instanceDialog!.findComponent({ name: 'ElSelect' });
      expect(instanceSelect.exists(), '分组下应能多选实例').toBe(true);
      expect(instanceSelect.props('multiple'), '实例选择必须是多选').toBe(true);
      instanceSelect.vm.$emit('update:modelValue', ['default']);
      await settle();
      expect(instanceSelect.props('modelValue'), '选中的实例即完成绑定').toEqual(['default']);
      await instanceDialog!
        .findAll('button')
        .find((item) => item.text() === '确定')!
        .trigger('click');
      await settle();

      const updatedGroup = drawer!
        .findAll('.vg')
        .find((item) => item.text().includes('Kubernetes'));
      expect(updatedGroup!.text(), '确认后分组行只展示实例数量').toContain('1 个实例');
      expect(updatedGroup!.text(), '分组行不再平铺实例名称').not.toContain('默认');
    } finally {
      wrapper.unmount();
    }
  });

  it('环境抽屉只做分组与实例的绑定选择，不提供实例配置', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      await clickRowButton(wrapper, '喀麦隆 UAT', '编辑');
      const drawer = wrapper
        .findAll('.el-drawer')
        .find((item) => item.text().includes('编辑环境'));
      expect(drawer, '编辑环境抽屉没有打开').toBeTruthy();

      expect(drawer!.findAll('.vg').length, '只展示当前环境选中的分组').toBe(4);
      expect(
        drawer!.findAll('.vg__count').length,
        '每个分组都展示实例数量',
      ).toBe(4);
      const k8sSection = drawer!
        .findAll('.vg')
        .find((item) => item.text().includes('Kubernetes'))!;
      expect(k8sSection.text(), '分组行展示已绑定实例数量').toContain('2 个实例');
      expect(k8sSection.findAll('.el-tag').length, '分组行不再平铺实例标签').toBe(0);
      expect(wrapper.find('#env-instances').exists(), '首页不再平铺实例表').toBe(false);
      const groupCard = wrapper.find('#env-groups');
      expect(groupCard.text(), '实例明细收进管理抽屉').not.toContain('备用集群');
      expect(groupCard.text(), '实例编码不在首页平铺').not.toContain('backup');

      const inlineValueInputs = drawer!.findAll('input').filter((item) =>
        ['填写值', '填写凭据'].includes(item.attributes('placeholder') ?? ''));
      expect(inlineValueInputs.length, '环境抽屉不出现任何键值输入').toBe(0);
      expect(drawer!.findAll('.ic__row').length, '环境抽屉不带实例配置区').toBe(0);
      for (const label of ['配置实例', '管理实例']) {
        expect(
          drawer!.findAll('button').some((item) => item.text() === label),
          `环境抽屉不应出现「${label}」`,
        ).toBe(false);
      }
      expect(drawer!.text(), '环境抽屉不展示配置完整度').not.toContain('项已配置');

      const k8sGroup = drawer!
        .findAll('.vg')
        .find((item) => item.text().includes('Kubernetes'));
      expect(k8sGroup, '环境抽屉里缺少 Kubernetes 分组').toBeTruthy();
      expect(k8sGroup!.text(), '分组块不展开组内键').not.toContain('集群地址');
      expect(k8sGroup!.text(), '分组块不展开实例名称').not.toContain('默认');
      await k8sGroup!
        .findAll('button')
        .find((item) => item.text() === '实例')!
        .trigger('click');
      await settle();
      const instanceDialog = wrapper
        .findAll('.el-dialog')
        .find((item) => item.text().includes('选择实例') && item.text().includes('Kubernetes'));
      expect(instanceDialog, '实例按钮没有打开多选弹窗').toBeTruthy();
      const k8sSelect = instanceDialog!.findComponent({ name: 'ElSelect' });
      expect(
        k8sSelect.props('modelValue'),
        '实例弹窗直接反映已绑定实例',
      ).toEqual(['default', 'backup']);
      expect(
        instanceDialog!.findAll('.el-tag').map((item) => item.text()),
        '实例弹窗里展示已绑定实例名称',
      ).toEqual(['默认（default）', '备用集群（backup）']);
    } finally {
      wrapper.unmount();
    }
  });

  it('实例编辑弹窗直接读取并保存实例固定配置', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      await clickRowButton(wrapper, 'Kubernetes', '管理');
      const manager = wrapper
        .findAll('.el-drawer')
        .find((item) => item.text().includes('实例管理'));
      expect(manager, '实例管理抽屉没有打开').toBeTruthy();

      const defaultRow = manager!
        .findAll('.el-table__row')
        .find((item) => item.text().includes('默认'));
      expect(defaultRow, '实例管理里缺少默认实例').toBeTruthy();
      const edit = defaultRow!.findAll('button').find((item) => item.text() === '编辑');
      expect(edit, '实例行缺少编辑入口').toBeTruthy();
      await edit!.trigger('click');
      await settle();

      const dialog = wrapper
        .findAll('.el-dialog')
        .find((item) => item.text().includes('编辑实例'));
      expect(dialog, '没有打开实例编辑弹窗').toBeTruthy();
      expect(dialog!.findAll('.ic__row').length, '按分组模板展示全部键').toBe(3);
      expect(dialog!.text()).toContain('访问令牌');
      expect(dialog!.text(), '实例配置不再要求选择环境').not.toContain('配置环境');
      expect(dialog!.find('.ic__env').exists(), '实例弹窗不再有配置环境下拉').toBe(false);

      const rowInput = (label: string): DOMWrapper<Element> => {
        const row = dialog!
          .findAll('.ic__row')
          .find((item) => item.text().includes(label));
        expect(row, `实例配置里没有 ${label} 这一项`).toBeTruthy();
        return row!.find('input');
      };
      expect(
        (rowInput('集群地址').element as HTMLInputElement).value,
        '实例固定值要直接回填',
      ).toContain('cmr-uat-k8s');
      expect(
        (rowInput('集群名').element as HTMLInputElement).value,
        '未配置的键以空输入框展示',
      ).toBe('');
      expect(rowInput('访问令牌').attributes('type'), '凭据必须用密码框').toBe('password');

      await rowInput('集群地址').setValue('https://fixed-k8s.example');
      const save = dialog!.findAll('button').find((item) => item.text() === '保存');
      expect(save, '实例编辑弹窗缺少保存按钮').toBeTruthy();
      await save!.trigger('click');
      await settle();

      const putCalls = vi.mocked(fetch).mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCalls.length, '保存实例只发一次 PUT，不再额外写环境').toBe(1);
      expect(
        new URL(String(putCalls[0][0]), 'http://localhost').pathname,
        '配置值随实例接口一起保存',
      ).toBe('/api/env-groups/k8s/instances/default');
      const body = JSON.parse(String((putCalls[0][1] as RequestInit).body)) as {
        values: Record<string, string>;
      };
      expect(body.values.url).toBe('https://fixed-k8s.example');
    } finally {
      wrapper.unmount();
    }
  });

  it('环境抽屉通过实例弹窗解绑，并在同组重新绑定', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      await clickRowButton(wrapper, '喀麦隆 UAT', '编辑');
      const drawer = wrapper
        .findAll('.el-drawer')
        .find((item) => item.text().includes('编辑环境'));
      expect(drawer, '编辑环境抽屉没有打开').toBeTruthy();

      const k8sGroup = drawer!
        .findAll('.vg')
        .find((item) => item.text().includes('Kubernetes'));
      expect(k8sGroup, '环境抽屉里缺少 Kubernetes 分组').toBeTruthy();

      await k8sGroup!
        .findAll('button')
        .find((item) => item.text() === '实例')!
        .trigger('click');
      await settle();
      let instanceDialog = wrapper
        .findAll('.el-dialog')
        .find((item) => item.text().includes('选择实例') && item.text().includes('Kubernetes'));
      expect(instanceDialog, '实例按钮没有打开多选弹窗').toBeTruthy();
      let instanceSelect = instanceDialog!.findComponent({ name: 'ElSelect' });
      expect(instanceSelect.props('modelValue')).toEqual(['default', 'backup']);

      instanceSelect.vm.$emit('update:modelValue', ['backup']);
      await settle();
      expect(
        instanceSelect.props('modelValue'),
        '取消勾选即解绑',
      ).toEqual(['backup']);
      await instanceDialog!
        .findAll('button')
        .find((item) => item.text() === '确定')!
        .trigger('click');
      await settle();

      let updatedGroup = drawer!
        .findAll('.vg')
        .find((item) => item.text().includes('Kubernetes'));
      expect(updatedGroup!.text(), '确认后分组只剩一个实例').toContain('1 个实例');

      await updatedGroup!
        .findAll('button')
        .find((item) => item.text() === '实例')!
        .trigger('click');
      await settle();
      instanceDialog = wrapper
        .findAll('.el-dialog')
        .find((item) => item.text().includes('选择实例') && item.text().includes('Kubernetes'));
      instanceSelect = instanceDialog!.findComponent({ name: 'ElSelect' });
      expect(instanceSelect.props('modelValue'), '弹窗重新打开时反映当前绑定').toEqual(['backup']);

      instanceSelect.vm.$emit('update:modelValue', ['default', 'backup']);
      await settle();
      expect(
        instanceSelect.props('modelValue'),
        '重新勾选即恢复绑定',
      ).toEqual(['default', 'backup']);
      await instanceDialog!
        .findAll('button')
        .find((item) => item.text() === '确定')!
        .trigger('click');
      await settle();
      updatedGroup = drawer!
        .findAll('.vg')
        .find((item) => item.text().includes('Kubernetes'));
      expect(updatedGroup!.text(), '确认后恢复两个实例').toContain('2 个实例');
    } finally {
      wrapper.unmount();
    }
  });

  it('环境里解绑实例只移除当前环境绑定，不删除实例数据', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      await clickRowButton(wrapper, '喀麦隆 UAT', '编辑');
      const drawer = wrapper
        .findAll('.el-drawer')
        .find((item) => item.text().includes('编辑环境'));
      expect(drawer, '编辑环境抽屉没有打开').toBeTruthy();

      const k8sGroup = drawer!
        .findAll('.vg')
        .find((item) => item.text().includes('Kubernetes'));
      expect(k8sGroup, '环境抽屉里缺少 Kubernetes 分组').toBeTruthy();
      await k8sGroup!
        .findAll('button')
        .find((item) => item.text() === '实例')!
        .trigger('click');
      await settle();
      const instanceDialog = wrapper
        .findAll('.el-dialog')
        .find((item) => item.text().includes('选择实例') && item.text().includes('Kubernetes'));
      expect(instanceDialog, '实例按钮没有打开多选弹窗').toBeTruthy();
      const instanceSelect = instanceDialog!.findComponent({ name: 'ElSelect' });
      instanceSelect.vm.$emit('update:modelValue', ['backup']);
      await settle();
      await instanceDialog!
        .findAll('button')
        .find((item) => item.text() === '确定')!
        .trigger('click');
      await settle();

      const fetchMock = vi.mocked(fetch);
      const methodsBeforeSave = fetchMock.mock.calls.map(([, init]) =>
        (init as RequestInit | undefined)?.method ?? 'GET');
      expect(methodsBeforeSave, '解绑只改草稿，不立刻调接口').not.toContain('PUT');
      expect(methodsBeforeSave, '解绑不能调用删除实例接口').not.toContain('DELETE');

      const save = drawer!.findAll('button').find((item) => item.text() === '保存');
      expect(save, '环境抽屉缺少保存按钮').toBeTruthy();
      await save!.trigger('click');
      await settle();

      const methodsAfterSave = fetchMock.mock.calls.map(([, init]) =>
        (init as RequestInit | undefined)?.method ?? 'GET');
      expect(methodsAfterSave, '解绑通过环境保存接口落库').toContain('PUT');
      expect(methodsAfterSave, '解绑仍然不能删除实例').not.toContain('DELETE');

      const putCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall, '没有发出环境保存请求').toBeTruthy();
      const body = JSON.parse(String((putCall![1] as RequestInit).body)) as {
        bindings: Record<string, string[]>;
      };
      expect(body.bindings.k8s, '其它分组的绑定不能丢').toBeTruthy();
      expect(body.bindings.k8s, '解绑的实例不再提交').not.toContain('default');
      expect(body.bindings.k8s, '同组其它实例不受影响').toContain('backup');
      expect(body.bindings.magic, '未动过的分组保留').toBeTruthy();
    } finally {
      wrapper.unmount();
    }
  });

  it('分组管理只展示分组摘要，实例在管理抽屉里维护', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      const groupCard = wrapper.find('#env-groups');
      expect(groupCard.exists(), '页面缺少分组管理卡片').toBe(true);
      expect(
        groupCard.findAll('th').map((item) => item.text()),
        '分组列表只保留分组级摘要',
      ).toEqual(['分组', '分组编码', '实例', '组内键', '操作']);
      expect(groupCard.text(), '首页不能平铺实例名').not.toContain('备用集群');
      expect(groupCard.text(), '首页不能平铺实例编码').not.toContain('backup');

      const rows = groupCard.findAll('.el-table__row');
      expect(rows.length, '四个分组各占一行').toBe(4);
      for (const row of rows) {
        expect(
          row.findAll('button').map((item) => item.text()),
          '每行只保留一个管理入口',
        ).toEqual(['管理']);
      }

      await clickRowButton(wrapper, 'Kubernetes', '管理');
      const manager = wrapper
        .findAll('.el-drawer')
        .find((item) => item.text().includes('实例管理'));
      expect(manager, '点管理没有打开实例抽屉').toBeTruthy();
      expect(manager!.text(), '抽屉里能看到该分组的第二套实例').toContain('备用集群');
      expect(manager!.text(), '实例编码用于工具取值').toContain('backup');
      expect(manager!.text(), '抽屉里要有新增实例入口').toContain('+ 新增实例');
      expect(
        manager!.findAll('th').map((item) => item.text()),
        '管理抽屉只维护实例元数据',
      ).toEqual(['实例', '状态', '操作']);

      const addInstance = manager!
        .findAll('button')
        .find((item) => item.text() === '+ 新增实例');
      expect(addInstance, '管理抽屉缺少新增实例按钮').toBeTruthy();
      await addInstance!.trigger('click');
      await settle();

      const dialog = wrapper
        .findAll('.el-dialog')
        .find((item) => item.text().includes('新增实例'));
      expect(dialog, '新增实例对话框没有打开').toBeTruthy();
      expect(dialog!.text(), '从分组进入时分组已预选').toContain('Kubernetes');
      const groupSelect = dialog!.findComponent({ name: 'ElSelect' });
      expect(groupSelect.exists(), '新增实例表单缺少分组选择器').toBe(true);
      expect(
        groupSelect.props('disabled'),
        '从分组进入时不允许把实例建到别的分组',
      ).toBe(true);
      expect(dialog!.text(), '实例编辑里包含按环境维护的配置值').toContain('配置值');
      expect(
        dialog!.findAll('.ic__row').length,
        '新增实例时按分组模板展示待填写的键',
      ).toBe(3);
    } finally {
      wrapper.unmount();
    }
  });

  it('分组编辑里维护键，内置分组的工具引用键锁定且不可删除', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      const groupCard = wrapper.find('#env-groups');
      const groupRow = (text: string): DOMWrapper<Element> | undefined =>
        groupCard.findAll('.el-table__row').find((item) => item.text().includes(text));

      expect(wrapper.text()).toContain('分组管理');
      expect(groupRow('Kubernetes')!.findAll('td')[1].text()).toContain('k8s');
      expect(groupRow('Kubernetes')!.text()).toContain('3 个');
      expect(
        groupRow('Kubernetes')!.text(),
        '分组列表只给数量，键的明细要等点编辑才展示',
      ).not.toContain('集群地址');

      await clickRowButton(wrapper, 'Kubernetes', '管理');
      await clickButton(wrapper, '编辑分组');
      expect(wrapper.text()).toContain('编辑变量分组');

      const deleteButton = wrapper
        .findAll('button')
        .find((item) => item.text() === '删除分组');
      expect(
        deleteButton!.attributes('disabled'),
        '内置分组被工具代码引用，删除必须禁用',
      ).toBeDefined();

      const keyCodeInputs = wrapper
        .findAll('input')
        .filter((item) => item.attributes('placeholder') === '如 serverAddr');
      expect(keyCodeInputs.length, 'Kubernetes 组里有 3 个键').toBe(3);
      expect(
        keyCodeInputs.map((item) => (item.element as HTMLInputElement).value),
        '点编辑后才看到组内键的明细',
      ).toEqual(['url', 'token', 'clusterName']);
      expect(
        keyCodeInputs.filter((item) => item.attributes('disabled') !== undefined).length,
        'url / token 被工具代码引用，键名输入框必须锁上',
      ).toBe(2);

      const removeButtons = wrapper
        .findAll('.kg__row')
        .map((row) => row.findAll('button').find((item) => item.text() === '移除'));
      expect(removeButtons.length).toBe(3);
      expect(
        removeButtons.filter((item) => item!.attributes('disabled') !== undefined).length,
        '引用键不能移除；clusterName 是后加的，能移除',
      ).toBe(2);
    } finally {
      wrapper.unmount();
    }
  });

  it('新增分组时先定义键；键名空着不能保存', async () => {
    const wrapper = await mountRoute('/environments');
    try {
      await clickButton(wrapper, '+ 新增分组');
      expect(wrapper.text()).toContain('新增变量分组');

      const save = (): DOMWrapper<Element> | undefined =>
        wrapper.findAll('button').find((item) => item.text() === '保存分组');
      expect(
        save()!.attributes('disabled'),
        '默认那行键还是空的，此时不该允许保存',
      ).toBeDefined();

      const fill = async (placeholder: string, value: string): Promise<void> => {
        const input = wrapper
          .findAll('input')
          .find((item) => item.attributes('placeholder') === placeholder);
        expect(input, `找不到占位提示为「${placeholder}」的输入框`).toBeTruthy();
        await input!.setValue(value);
        await settle(20);
      };
      await fill('如 k8s / biz', 'probe_check');
      await fill('如 Kubernetes', '探针校验');
      await fill('如 serverAddr', 'probeKey');
      await fill('如 集群地址', '探针字段');
      expect(
        save()!.attributes('disabled'),
        '分组与键都填齐后，保存应可点',
      ).toBeUndefined();
    } finally {
      wrapper.unmount();
    }
  });
});

describe('执行链路详情页的父子入口', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  /*
   * 异步子 agent 的 run 在列表里是孤立的一条（父 run 收口之后它才开跑、于是自己开了一条 run），
   * 页面必须给出「回到父链路」的入口，否则人只能拿着 runId 去列表里翻。
   * 夹具里的 parentRunId 是空的（那是"用户直接发起"的常态），所以这一条就地改一份带父 run 的。
   */
  it('父 run 与后台任务号有值时就地给出入口与任务号', async () => {
    const original = RESPONSES['/api/traces/smoke-run-1'] as TraceRunInfo;
    RESPONSES['/api/traces/smoke-run-1'] = {
      ...original,
      parentRunId: 'smoke-parent-run',
      taskId: 'task_smoke_1',
    };
    let wrapper: VueWrapper | undefined;
    try {
      wrapper = await mountRoute('/traces/smoke-run-1');
      expect(wrapper.text()).toContain('回到父链路');
      expect(wrapper.text()).toContain('smoke-parent-run');
      expect(wrapper.text()).toContain('task_smoke_1');
    } finally {
      RESPONSES['/api/traces/smoke-run-1'] = original;
      wrapper?.unmount();
    }
  });

  /* 反方向：入口直接发起的 run 不该凭空多出一个"回到父链路"，那是条点过去就 404 的死链。 */
  it('没有父 run 时不出现这个入口', async () => {
    const wrapper = await mountRoute('/traces/smoke-run-1');
    try {
      expect(wrapper.text()).not.toContain('回到父链路');
    } finally {
      wrapper.unmount();
    }
  });
});

/*
 * 对话页左侧的「最近会话」。
 *
 * <p>这一栏回答的是"我刚才是跟它聊到哪了"，所以两条断言分别钉：
 * <ol>
 *   <li><b>清单来自 /api/sessions?agentId=</b>（run 表按 (user_id, session_id) 的聚合），
 *       不是前端编的、也不是状态存储那份"只有还有记忆的"。请求 URL 上带着 agentId
 *       是这件事唯一能被机器验到的证据。</li>
 *   <li><b>点一条 = 接着那条会话继续</b>：会话说到底就是 (userId, sessionId) 两个值，
 *       点完之后页头显示的是这条会话的键，而页面上的内容是这条会话的历史 ——
 *       两件事都对才算"接上了"。</li>
 * </ol>
 */
describe('对话页左侧的最近会话', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('清单按 agentId 去后端的会话列表拿，而不是前端自己编', async () => {
    const wrapper = await mountRoute('/chat/test_agent');
    try {
      const rows = wrapper.findAll('.rail .sc');
      /* 夹具里两条会话，两条都要在：一栏只会显示"第一条"是最容易犯的错 */
      expect(rows, `左栏条数不对${crashMessage(wrapper)}`).toHaveLength(2);
      expect(lastSessionsRequest()).toContain('agentId=test_agent');

      const text = wrapper.text();
      expect(text).toContain('single-abc');
      expect(text).toContain('console-7cc8d068');
      /* userId 必须露出来：同一个 agent 有很多人在聊，只看会话键分不出是谁的上下文 */
      expect(text).toContain('wo7U1');
    } finally {
      wrapper.unmount();
    }
  });

  it('点一条历史会话即接着它继续：会话键换成它，消息来自 /api/state/sessions/messages', async () => {
    const wrapper = await mountRoute('/chat/test_agent');
    try {
      await wrapper.findAll('.rail .sc')[0].trigger('click');
      await settle();

      /* 会话键与生效用户都换成了这条会话的（页头把两个值都露着） */
      expect(wrapper.text()).toContain('single-abc');
      expect(wrapper.find('.rail .sc.on').text()).toContain('single-abc');

      /* 历史消息铺上来了：两条 assistant + 一条 user，正文按 Markdown 渲染 */
      expect(wrapper.findAll('.stream .msg')).toHaveLength(3);
      const thread = wrapper.find('.stream').text();
      expect(thread).toContain('帮我看下昨天日报');
      expect(thread).toContain('任务列表');
      expect(thread).toContain('昨天的日报已经生成。');

      /* 工具调用留了一行提示，而思考默认是收起的（长会话全展开能滚出好几屏） */
      expect(thread).toContain('调用过 taskList');
      const think = wrapper.find('.think');
      expect(think.exists()).toBe(true);
      expect(think.find('.think__hd').attributes('aria-expanded')).toBe('false');
    } finally {
      wrapper.unmount();
    }
  });

  it('取数走的是状态表名与会话槽位键，不是 agentId 与 sessionId 硬拼', async () => {
    const wrapper = await mountRoute('/chat/test_agent');
    try {
      await wrapper.findAll('.rail .sc')[0].trigger('click');
      await settle();

      const url = lastStateMessagesRequest();
      /*
       * table 是状态表名（不等于 agentId 的 agent 也有 —— 表名取运行时声明的 state_table，
       * 为空才回落 agent 名）；slotId 是框架的槽位键 <userId>:<sessionId>，含冒号。
       */
      expect(url).toContain('table=test_agent');
      expect(url).toContain('slotId=wo7U1%3Asingle-abc');
    } finally {
      wrapper.unmount();
    }
  });
});

/** 最近一次打到会话回放接口的请求 URL。 */
function lastStateMessagesRequest(): string {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const urls = calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/state/sessions/messages'));
  return urls[urls.length - 1] ?? '';
}

/*
 * 顶栏的两颗按钮。
 *
 * <p>它们跳的都是**别的应用**，所以能测的只有"入口在不在、列的是不是门户登记的
 * 那几个平台"——真的跳转由浏览器承担（单测里点下去只会让 jsdom 报 Not implemented）。
 * 这里刻意不断言"点了会跳到哪里"：那需要 mock window.location，而 mock 掉之后
 * 断言的是 mock 自己，不是代码。
 */
describe('顶栏的平台切换与返回门户', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('切换面板是从左侧滑出的抽屉，列出其它子平台与门户，不含自己那一项', async () => {
    const wrapper = await mountRoute('/');
    try {
      /* 没点之前不该渲染 —— 面板是懒渲染的，这一点顺带被钉住 */
      expect(wrapper.find('.plat').exists()).toBe(false);

      await wrapper.find('.switchbtn').trigger('click');
      await settle(60);

      /*
       * 形态钉死成「从左侧滑出的抽屉」。
       *
       * 触发器钉在左上角品牌区，面板就从同一条边上出来 —— 动作与结果要挨着
       * （见 AppShell 模板里的注释）。换回居中弹窗、或把方向改掉，下面三条会直接红，
       * 这正是它们存在的意义：这一条是需求，不是实现细节。
       */
      const panel = wrapper.find('.el-drawer');
      expect(panel.exists()).toBe(true);
      expect(panel.classes()).toContain('ltr');
      expect(wrapper.find('.el-dialog').exists()).toBe(false);

      const names = wrapper.findAll('.plat .plat__tx b').map((node) => node.text());
      expect(names).toEqual(['数据平台', '行政管理平台', '统一门户']);
      /* 当前平台不该出现在切换列表里 */
      expect(names).not.toContain('Agent 智能平台');
    } finally {
      wrapper.unmount();
    }
  });

  it('顶栏有回到统一门户的按钮，而且它必须是可点的', async () => {
    const wrapper = await mountRoute('/');
    try {
      const portal = wrapper.find('.portbtn');
      expect(portal.exists()).toBe(true);
      expect(portal.text()).toContain('门户');
      /*
       * 「不灰」在这里是需求而不是实现细节：曾经按 portalIsSelf 把它禁掉过 ——
       * 顶栏常驻一颗永久灰着的按钮，比"点了之后没跳远"更像坏了（灰是在渲染前
       * 就宣告此路不通，而通不通取决于部署形态，用户看不到那个条件）。
       */
      expect(portal.attributes('disabled')).toBeUndefined();
    } finally {
      wrapper.unmount();
    }
  });
});

describe('页面标签栏', () => {
  beforeEach(() => {
    installFetchStub();
    warnSpy = spyOnWarnings();
  });

  afterEach(() => {
    verifyNoUnresolvedComponents(warnSpy);
    vi.unstubAllGlobals();
  });

  it('切换页面只新增或激活标签，关闭当前标签后回到相邻页', async () => {
    const wrapper = await mountRoute('/tools');
    const titles = () => wrapper.findAll('.tab__t').map((node) => node.text());
    try {
      expect(titles()).toEqual(['工具']);
      expect(wrapper.find('.tab.on .tab__t').text()).toBe('工具');

      await router.push('/skills');
      await settle();
      expect(titles()).toEqual(['工具', 'Skills']);
      expect(wrapper.find('.tab.on .tab__t').text()).toBe('Skills');

      const toolsTab = wrapper.findAll('.tab').find((tab) => tab.text().includes('工具'));
      expect(toolsTab).toBeTruthy();
      await toolsTab!.trigger('click');
      await settle();

      /* 切回来时标签仍在，说明点击别的页面没有把当前页关掉 */
      expect(titles()).toEqual(['工具', 'Skills']);
      expect(router.currentRoute.value.path).toBe('/tools');
      expect(wrapper.find('.tab.on .tab__t').text()).toBe('工具');

      await wrapper.find('.tab.on .tab__x').trigger('click');
      await settle();
      expect(titles()).toEqual(['Skills']);
      expect(router.currentRoute.value.path).toBe('/skills');
    } finally {
      wrapper.unmount();
    }
  });

  it('左上角不再出现命名空间入口', async () => {
    const wrapper = await mountRoute('/');
    try {
      expect(wrapper.find('.ns').exists()).toBe(false);
      expect(wrapper.find('.scope').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('命名空间');
    } finally {
      wrapper.unmount();
    }
  });
});
