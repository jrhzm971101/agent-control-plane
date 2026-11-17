/*
 * 控制面数据访问层 —— 与后端 controller/controlplane + controller/agent 一一对应。
 *
 * 与 api/*.ts 那批老模块的两点差别：
 *
 * 1. 不做 mock 分叉。DB 已经取代 Nacos + 本地 md 成为唯一真相，页面读到的就是库里
 *    存着的东西；老模块的 mock 分叉保留给尚未接后端的页面（概览 / 工作流 / 渠道…）。
 *    在这里保留 mock 只会有一种后果：页面显示得挺好，但和库里的数据毫无关系。
 *
 * 2. 每个写操作都带 X-Operator 头。这次不做登录，但不留空 ——
 *    审计列（created_by / updated_by）一旦允许为空，后面再想补「谁改的」就永远补不回来了。
 *
 * 另外：路径里的资源名一律 encodeURIComponent。prompt-key 与 agent 名是人工输入的，
 * 不能赌它不含斜杠或空格。
 */
import { ApiError, apiJson, buildUrl } from '@/lib/apiClient';
import type {
  AgentDefinitionBundle,
  AgentRow,
  ChannelTypeDescriptor,
  ChannelUpsert,
  ChannelView,
  ConnectionTest,
  EnvDetail,
  EnvGroupSaveRequest,
  EnvGroupSaveResult,
  EnvGroupTemplate,
  EnvInstanceDetail,
  EnvInstanceRow,
  EnvInstanceSaveRequest,
  EnvRow,
  EnvSaveRequest,
  GatewayView,
  McpServerEntity,
  MiddlewareChainInfo,
  ModelDefaults,
  ModelDetail,
  ModelEntity,
  ModelRow,
  MiddlewareMeta,
  ManagedGateway,
  PromptEntity,
  PublishResult,
  ResourceVersionInfo,
  SkillDetail,
  SkillMetaEntity,
  SkillUpsert,
  ToolMeta,
  WorkflowEntity,
  WorkflowRow,
  WorkflowRunDetail,
  WorkflowRunRow,
  WorkflowSpec,
  WorkflowValidation,
  WorkspaceAgentRow,
  WorkspaceDeleteResult,
  WorkspaceDirView,
  WorkspaceFileView,
  WorkspaceUserRow,
} from './types';

/** 审计身份。见文件头第 2 条。 */
const OPERATOR = 'console';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * 唯一的发请求出口。
 *
 * body 为 undefined 时不带 Content-Type（apiClient 只在有 body 时补），
 * 于是「POST 一个空体的 publish」与「PUT 一个实体」共用同一条路径，不必写两套。
 */
function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return apiJson<T>(buildUrl(path), {
    method,
    headers: { 'X-Operator': OPERATOR },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const enc = encodeURIComponent;

/**
 * 从 409 里取出「谁在引用它」。
 *
 * 后端删除保护回 { error, referencingAgents }。页面要据此列出引用方，而不是只显示
 * 一句「删不掉」——后者让人只能靠猜。非 409 / 结构不符时回空数组，调用方就不必
 * 每处都判 status，统一走「有清单就列出来」这一个分支。
 */
export function referencingAgentsOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const detail = error.detail as { referencingAgents?: unknown } | null;
  const list = detail?.referencingAgents;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 从 400 里取出校验问题清单。
 *
 * 后端的校验是「收集式」的：一次返回全部问题，用户改一遍就能提交成功。
 * 页面必须把每一条都展示出来，否则那个收集能力就白费了 —— 只显示第一条
 * 会让人来回提交三四次。
 */
export function violationsOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const detail = error.detail as { violations?: unknown } | null;
  const list = detail?.violations;
  return Array.isArray(list) ? list.map((item) => String(item)) : [];
}

// ==================================================================================
// Prompt（md_prompt）
// ==================================================================================

export const listPrompts = () => request<PromptEntity[]>('GET', '/api/resources/prompts');

export const getPrompt = (key: string) => request<PromptEntity>('GET', `/api/resources/prompts/${enc(key)}`);

export const createPrompt = (prompt: PromptEntity) =>
  request<PromptEntity>('POST', '/api/resources/prompts', prompt);

/** 路径上的 key 是权威：body 里的 promptKey 只用于展示。 */
export const savePrompt = (key: string, prompt: PromptEntity) =>
  request<PromptEntity>('PUT', `/api/resources/prompts/${enc(key)}`, prompt);

export const deletePrompt = (key: string) =>
  request<{ deleted: string }>('DELETE', `/api/resources/prompts/${enc(key)}`);

export const publishPrompt = (key: string, changeNote?: string) =>
  request<PublishResult>('POST', `/api/resources/prompts/${enc(key)}/publish`, {
    changeNote: changeNote ?? null,
  });

export const rollbackPrompt = (key: string, version: number) =>
  request<unknown>('POST', `/api/resources/prompts/${enc(key)}/rollback`, { version });

export const promptVersions = (key: string) =>
  request<ResourceVersionInfo[]>('GET', `/api/resources/prompts/${enc(key)}/versions`);

// ==================================================================================
// Skill（治理元数据在 md_skill_meta，正文在官方表）
// ==================================================================================

/** 列表只回治理元数据；正文要回查官方表，列表页不需要。 */
export const listSkills = () => request<SkillMetaEntity[]>('GET', '/api/resources/skills');

export const getSkill = (name: string) => request<SkillDetail>('GET', `/api/resources/skills/${enc(name)}`);

export const createSkill = (payload: SkillUpsert) =>
  request<SkillUpsert>('POST', '/api/resources/skills', payload);

export const saveSkill = (name: string, payload: SkillUpsert) =>
  request<SkillUpsert>('PUT', `/api/resources/skills/${enc(name)}`, payload);

export const deleteSkill = (name: string) =>
  request<{ deleted: string }>('DELETE', `/api/resources/skills/${enc(name)}`);

export const publishSkill = (name: string, changeNote?: string) =>
  request<PublishResult>('POST', `/api/resources/skills/${enc(name)}/publish`, {
    changeNote: changeNote ?? null,
  });

export const rollbackSkill = (name: string, version: number) =>
  request<unknown>('POST', `/api/resources/skills/${enc(name)}/rollback`, { version });

export const skillVersions = (name: string) =>
  request<ResourceVersionInfo[]>('GET', `/api/resources/skills/${enc(name)}/versions`);

// ==================================================================================
// MCP（md_mcp_server）
// ==================================================================================

export const listMcpServers = () => request<McpServerEntity[]>('GET', '/api/resources/mcp');

export const createMcpServer = (server: McpServerEntity) =>
  request<McpServerEntity>('POST', '/api/resources/mcp', server);

export const saveMcpServer = (name: string, server: McpServerEntity) =>
  request<McpServerEntity>('PUT', `/api/resources/mcp/${enc(name)}`, server);

export const deleteMcpServer = (name: string) =>
  request<{ deleted: string }>('DELETE', `/api/resources/mcp/${enc(name)}`);

/**
 * 发布 MCP 服务。
 *
 * 后端在重建 agent 之前会先失效这个 MCP 的连接缓存（DbMcpClientFactory.invalidate），
 * 否则端点改了也还连着旧会话 —— 所以「改完端点必须发布」不是流程洁癖，是唯一生效路径。
 */
export const publishMcpServer = (name: string, changeNote?: string) =>
  request<PublishResult>('POST', `/api/resources/mcp/${enc(name)}/publish`, {
    changeNote: changeNote ?? null,
  });

export const rollbackMcpServer = (name: string, version: number) =>
  request<unknown>('POST', `/api/resources/mcp/${enc(name)}/rollback`, { version });

export const mcpServerVersions = (name: string) =>
  request<ResourceVersionInfo[]>('GET', `/api/resources/mcp/${enc(name)}/versions`);

// ==================================================================================
// 模型（md_model）
// ==================================================================================

/** 列表：密钥打码 + 引用它的 agent 数 + 近 7 日用量。 */
export const listModels = () => request<ModelRow[]>('GET', '/api/models');

/**
 * 调用参数默认值 —— 「没配的那部分去哪了」的答案。
 *
 * 内容是随"有没有默认模型"变的：有默认模型就显示它的端点与参数，没有就显示
 * application.yml 里那个兜底 Bean 的配置，并把来源标出来。
 */
export const modelDefaults = () => request<ModelDefaults>('GET', '/api/models/defaults');

/**
 * 详情 —— 与列表的差别只有一处：<b>密钥是明文</b>。
 *
 * 编辑表单要回填，打码值回传会把真密钥覆盖成六个星号（见 types.ts 里 ModelEntity 的注释）。
 * 列表之所以打码，是因为它是"扫一眼 / 截屏"的场景。
 */
export const getModel = (modelKey: string) =>
  request<ModelDetail>('GET', `/api/models/${enc(modelKey)}`);

export const createModel = (model: ModelEntity) => request<ModelEntity>('POST', '/api/models', model);

/** 路径上的 key 是权威：body 里那份的 modelKey 会被后端覆盖（改名 = 删除 + 新建）。 */
export const saveModel = (modelKey: string, model: ModelEntity) =>
  request<ModelEntity>('PUT', `/api/models/${enc(modelKey)}`, model);

export const deleteModel = (modelKey: string) =>
  request<{ deleted: string }>('DELETE', `/api/models/${enc(modelKey)}`);

/**
 * 发布 = 落快照 + 重建引用它的 agent。
 *
 * 注意重建范围比"引用反查"更大：没声明 model-ref 的 agent 用的就是默认模型，
 * 它们不出现在反查结果里，但换了默认模型同样要重建（后端已处理，这里只是提醒）。
 * 所以改端点必须发布才生效 —— 保存只落草稿。
 */
export const publishModel = (modelKey: string, changeNote?: string) =>
  request<PublishResult>('POST', `/api/models/${enc(modelKey)}/publish`, {
    changeNote: changeNote ?? null,
  });

/** 回滚只写库、不热装配，而且<b>不动 is-default</b>：默认标记是运维开关，不是模型内容。 */
export const rollbackModel = (modelKey: string, version: number) =>
  request<unknown>('POST', `/api/models/${enc(modelKey)}/rollback`, { version });

export const modelVersions = (modelKey: string) =>
  request<ResourceVersionInfo[]>('GET', `/api/models/${enc(modelKey)}/versions`);

/**
 * 连通性探测：真发一次 GET {baseUrl}/models。
 *
 * 只探测、不落库 —— 它是一次"现在通不通"的现场检查（例如刚填完密钥想确认），
 * 而不是模型内容的一部分。所以它没有草稿/发布的概念，也不会写任何一列。
 */
export const testModelConnection = (modelKey: string) =>
  request<ConnectionTest>('POST', `/api/models/${enc(modelKey)}/test`);

// ==================================================================================
// Agent（md_agent 主表 + 5 张关联表）
// ==================================================================================

export const listAgents = () => request<AgentRow[]>('GET', '/api/agents');

/** 详情返回整束行，页面拿它直接回显表单与下拉。 */
export const getAgent = (name: string) =>
  request<AgentDefinitionBundle>('GET', `/api/agents/${enc(name)}`);

export const createAgent = (bundle: AgentDefinitionBundle) =>
  request<AgentDefinitionBundle>('POST', '/api/agents', bundle);

/** 路径上的 name 是权威：改名要新建，不能靠保存实现隐式「另存为」。 */
export const saveAgent = (name: string, bundle: AgentDefinitionBundle) =>
  request<AgentDefinitionBundle>('PUT', `/api/agents/${enc(name)}`, bundle);

export const deleteAgent = (name: string) =>
  request<{ deleted: string }>('DELETE', `/api/agents/${enc(name)}`);

/** 发布 = 把库里这份内容装配成实例。保存只落库，不改变 agent 行为。 */
export const publishAgent = (name: string, changeNote?: string) =>
  request<PublishResult>('POST', `/api/agents/${enc(name)}/publish`, {
    changeNote: changeNote ?? null,
  });

/** 回滚只写库、不热装配：回滚后的内容要等下一次发布才生效。 */
export const rollbackAgent = (name: string, version: number) =>
  request<unknown>('POST', `/api/agents/${enc(name)}/rollback`, { version });

export const agentVersions = (name: string) =>
  request<ResourceVersionInfo[]>('GET', `/api/agents/${enc(name)}/versions`);

/** 只重建实例（DB 内容不变）。实例跑脏、MCP 会话断了时用它复位。 */
export const reloadAgent = (name: string) =>
  request<{ reloaded: string }>('POST', `/api/agents/${enc(name)}/reload`);

export const reloadAllAgents = () =>
  request<{ agentCount: number }>('POST', '/api/agents/reload-all');

// ==================================================================================
// 只读目录（工具与中间件不落库）
// ==================================================================================

/** 工具目录。注意返回的 beanName 才是 md_agent_ref.tools 里要填的值。 */
export const listToolCatalog = () => request<ToolMeta[]>('GET', '/api/agents/tools/available');

/** 中间件 bean 目录。 */
export const listMiddlewareCatalog = () =>
  request<MiddlewareMeta[]>('GET', '/api/resources/middleware/catalog');

/** 全局中间件链（很短；其余按 agent 声明挂载）。 */
export const getMiddlewareChain = () =>
  request<MiddlewareChainInfo>('GET', '/api/resources/middleware');
// ==================================================================================
// 渠道（md_channel + md_channel_binding）
// ==================================================================================

/** 渠道列表 = 库内容 + 运行时状态（敏感凭据已打码）。 */
export const listChannels = () => request<ChannelView[]>('GET', '/api/channels');

/**
 * 渠道类型清单 —— 类型下拉与凭据表单的唯一来源。
 *
 * 每种类型自带它需要的凭据字段（key / 中文标签 / 是否必填 / 是否敏感），
 * 所以「加一个平台」在这个页面上是零改动：后端多返回一条描述即可。
 * 这个查询几乎不变（只随后端代码变），页面里给它设长一点的 staleTime 也没问题。
 */
export const listChannelTypes = () =>
  request<ChannelTypeDescriptor[]>('GET', '/api/channels/types');

/**
 * 渠道详情。
 *
 * 与列表的差别只有一处：**敏感凭据是明文**。编辑表单要回填，打码值回传会把真密钥覆盖成 ******，
 * 那是一次保存就永久损坏凭据的事故。列表之所以打码，是因为它是"扫一眼/截屏"的场景。
 */
export const getChannel = (channelId: string) =>
  request<ChannelView>('GET', `/api/channels/${enc(channelId)}`);

export const createChannel = (body: ChannelUpsert) =>
  request<ChannelView>('POST', '/api/channels', body);

/** 路径上的 channelId 是权威，body 里那份会被后端覆盖（改名=删除+新建，不是保存）。 */
export const saveChannel = (channelId: string, body: ChannelUpsert) =>
  request<ChannelView>('PUT', `/api/channels/${enc(channelId)}`, body);

export const deleteChannel = (channelId: string) =>
  request<{ deleted: string }>('DELETE', `/api/channels/${enc(channelId)}`);

/**
 * 发布 = 落快照 + 置 PUBLISHED + <b>立刻热生效</b>。
 *
 * 注意返回体不是 PublishResult：渠道没有"引用它的 agent"要重建，
 * 它自己就是被生效的对象，所以后端回的是发布后的渠道行（含最新的运行时状态）。
 * 装配失败不会让发布失败 —— 错误挂在返回体的 runtime.error 上，页面要把那行红字显示出来。
 */
export const publishChannel = (channelId: string, changeNote?: string) =>
  request<ChannelView>('POST', `/api/channels/${enc(channelId)}/publish`, {
    changeNote: changeNote ?? null,
  });

/** 回滚只写库、置回草稿，不触发热生效：线上仍是原版本，要再发一次才切。 */
export const rollbackChannel = (channelId: string, version: number) =>
  request<{ note: string; channel: ChannelView }>(
    'POST',
    `/api/channels/${enc(channelId)}/rollback`,
    { version },
  );

export const channelVersions = (channelId: string) =>
  request<ResourceVersionInfo[]>('GET', `/api/channels/${enc(channelId)}/versions`);

/** 重新装配一个渠道：读库 + 指纹比对，必要时重启（实例不健康时点它就够）。 */
export const reloadChannel = (channelId: string) =>
  request<ChannelView>('POST', `/api/channels/${enc(channelId)}/reload`);

/** 全量重载：重建网关 + 路由表 + 按需重启全部通道。返回里的 channels 是重载后的列表。 */
export const reloadAllChannels = () =>
  request<{ gateway: ManagedGateway; channels: ChannelView[] }>(
    'POST',
    '/api/channels/reload-all',
  );

// ==================================================================================
// 网关（md_gateway，单行）
// ==================================================================================

export const getGateway = () => request<GatewayView>('GET', '/api/gateway');

/**
 * 保存主 agent 并立刻重新装配。
 *
 * 不提供"只落库不生效"的选项：网关改了不重新装配，只会让页面与线上差一拍，
 * 而那正是最难排查的一类问题。所以这个写操作永远带上重装配。
 */
export const saveGateway = (mainAgentId: string | null, description?: string | null) =>
  request<GatewayView>('PUT', '/api/gateway', { mainAgentId, description: description ?? null });

export const reloadGateway = () => request<GatewayView>('POST', '/api/gateway/reload');

// ==================================================================================
// 工作区文件（/api/workspace）
// ==================================================================================

/*
 * 这一组是唯一「直接操作 agent 运行时产物」的接口，其余几组都是元数据治理。
 * 三点与别处不同：
 *
 * 1. 没有 create / update 之分：写只有一种语义 —— PUT 覆盖写（文件不存在则创建）。
 *    重命名由页面用「另存 + 删除」两步完成。后端刻意不提供 rename：多一个接口就多一处
 *    需要过 WorkspacePathGuard 的入口，而安全边界上的入口越少越好。
 *
 * 2. 三个参数 agentName / userId / path 全部走 query，且 userId **为空是有含义的** ——
 *    它表示看「基线层」（agent 出厂模板），而不是「没传这个参数」。
 *    所以拼串时必须把空串丢掉（buildUrl 已经这么做）：传 userId= 过去会被后端当成空串校验，
 *    而漏传等于 null，才是那个合法视图。
 *
 * 3. 删除只允许删可写范围内的**单个文件**或**空目录**。目录非空时后端直接 400，不递归 ——
 *    一次误点带走整个 knowledge/ 是这里最该避免的事故，工作区文件没有回收站。
 */

/** 有工作区的 agent（HARNESS）。页面左侧的 agent 选择器读它。 */
export const listWorkspaceAgents = () =>
  request<WorkspaceAgentRow[]>('GET', '/api/workspace/agents');

/**
 * 「隔离维度」下拉框的候选值。
 *
 * 与 /files 分开请求：候选值只在换 agent 时变，而目录树是随每次下钻重拉的。
 * 合成一次请求之后，每次进目录都会顺带查一遍 run 表，答案却与这次下钻无关。
 */
export const listWorkspaceUsers = (agentName: string) =>
  request<WorkspaceUserRow[]>('GET', buildUrl('/api/workspace/users', { agentName }));
/** 列目录。path 传空串 = 工作区根。 */
export const listWorkspaceFiles = (agentName: string, userId: string, path: string) =>
  request<WorkspaceDirView>('GET', buildUrl('/api/workspace/files', { agentName, userId, path }));

/**
 * 读文件。
 *
 * 返回 JSON 而不是纯文本：页面还要同时拿到 writable 与 truncated 两个判定，
 * 而纯文本响应体无法携带它们（放进自定义响应头也能做，但那样浏览器端读起来更绕）。
 */
export const readWorkspaceFile = (agentName: string, userId: string, path: string) =>
  request<WorkspaceFileView>('GET', buildUrl('/api/workspace/file', { agentName, userId, path }));

/** 覆盖写。用 body 而不是 query：内容可能很长，URL 长度不是拿来放正文的。 */
export const saveWorkspaceFile = (body: {
  agentName: string;
  userId: string;
  path: string;
  content: string;
}) => request<{ path: string; saved: boolean }>('PUT', '/api/workspace/file', body);

/** 删除单个文件或空目录。DELETE 带 query 而不是 body —— 见文件头第 3 条。 */
export const deleteWorkspaceFile = (agentName: string, userId: string, path: string) =>
  request<WorkspaceDeleteResult>(
    'DELETE',
    buildUrl('/api/workspace/file', { agentName, userId, path }),
  );


// ==================================================================================
// 环境目录（/api/environments + /api/env-groups）
// ==================================================================================

/*
 * 这一组与其余几组的三点不同：
 *
 * 1. 没有 mock 分叉（同文件头第 1 条）：环境目录的真相在库里，页面显示得"挺好"但和库无关
 *    是最坏的结果 —— 这页存在的意义就是让人看见真实配置缺了什么。
 *
 * 2. 没有草稿 / 发布 / 回滚：环境目录不参与 agent 装配，改完下一次工具调用就生效。
 *    给它加一层发布只会让"我明明改了地址为什么还在连老的"变成一个需要先想明白才能回答的问题。
 *
 * 3. 「保存」传的是**整份**分组键值。后端按整体替换处理：没出现的键就是没配。
 *    所以页面不需要 diff、不需要逐字段 PATCH —— 清空一个输入框天然等于删掉那一行。
 */

/** 环境列表（每行带分组状态与完整度，不含量）。 */
export const listEnvironments = () => request<EnvRow[]>('GET', '/api/environments');

/** 环境详情（只含主表字段与绑定关系，配置值走实例详情接口）。 */
export const environmentDetail = (envCode: string) =>
  request<EnvDetail>('GET', `/api/environments/${enc(envCode)}`);

export const createEnvironment = (body: EnvSaveRequest) =>
  request<{ envCode: string; created: boolean }>('POST', '/api/environments', body);

/** 保存。路径上的 envCode 是权威 —— 改名不是保存，是删除 + 新建。 */
export const saveEnvironment = (envCode: string, body: EnvSaveRequest) =>
  request<{ envCode: string; saved: boolean }>('PUT', `/api/environments/${enc(envCode)}`, body);

/** 删除。被 agent 的工作区引用时回 409 + referencingAgents，notifyFailure 会列出来。 */
export const deleteEnvironment = (envCode: string) =>
  request<{ deleted: string }>('DELETE', `/api/environments/${enc(envCode)}`);

/** 分组实例清单，供页面单独的实例维护区使用。实例是分组级元数据。 */
export const listEnvInstances = () => request<EnvInstanceRow[]>('GET', '/api/env-instances');

/** 实例详情：元数据 + 该实例自己的固定配置值，供编辑弹窗回填。 */
export const getEnvInstance = (groupCode: string, instanceCode: string) =>
  request<EnvInstanceDetail>(
    'GET',
    `/api/env-groups/${enc(groupCode)}/instances/${enc(instanceCode)}`,
  );

export const createEnvInstance = (
  groupCode: string,
  instanceCode: string,
  body: EnvInstanceSaveRequest,
) =>
  request<{ instanceCode: string; created: boolean }>(
    'POST',
    `/api/env-groups/${enc(groupCode)}/instances/${enc(instanceCode)}`,
    body,
  );

export const saveEnvInstance = (
  groupCode: string,
  instanceCode: string,
  body: EnvInstanceSaveRequest,
) =>
  request<{ instanceCode: string; saved: boolean }>(
    'PUT',
    `/api/env-groups/${enc(groupCode)}/instances/${enc(instanceCode)}`,
    body,
  );

export const deleteEnvInstance = (groupCode: string, instanceCode: string) =>
  request<{ deleted: string }>(
    'DELETE',
    `/api/env-groups/${enc(groupCode)}/instances/${enc(instanceCode)}`,
  );

/** 分组模板列表（含键声明）。列表页的动态列、详情页的分组区块、模板编辑器都读它。 */
export const listEnvGroups = () => request<EnvGroupTemplate[]>('GET', '/api/env-groups');

export const createEnvGroup = (body: EnvGroupSaveRequest) =>
  request<{ groupCode: string; created: boolean }>('POST', '/api/env-groups', body);

/** 保存分组模板。返回里的 removedKeys 是"顺带被清掉值的键"，非空时必须提示用户。 */
export const saveEnvGroup = (groupCode: string, body: EnvGroupSaveRequest) =>
  request<EnvGroupSaveResult>('PUT', `/api/env-groups/${enc(groupCode)}`, body);

/** 删除分组。内置分组（被工具代码引用）后端回 409。 */
export const deleteEnvGroup = (groupCode: string) =>
  request<{ deleted: string }>('DELETE', `/api/env-groups/${enc(groupCode)}`);

// ==================================================================================
// 工作流（/api/workflows + /api/workflow-runs）
// ==================================================================================

/*
 * 工作流是唯一一类「有内容形状」的受治理资源：其余几类的正文是一段文本或几个字段，
 * 它的正文是一张图（nodes + edges）存在 spec_json 里。接口因此比另外几类多两组方法：
 *
 * - validate：单独一个只查问题、不落库的入口。保存不校验（图是分步搭出来的），
 *   但发布和执行前必须过这一关，所以页面需要能"先看看有没有错"；
 * - runs / runDetail：定义之外还有运行层。这两组路径不同前缀（见后端
 *   WorkflowController 的类注释第三节），因为 /workflows/{key}/runs 与
 *   /workflows/runs/{runId} 会构成歧义模式。
 *
 * 删除没有引用保护：工作流是引用方（它引用 agent），没有别的东西引用它。
 * 反过来，删 agent 时后端会检查它是不是被某个已发布的工作流用着。
 */

/** 清单：只回治理字段与节点/边数量，不含 spec。 */
export const listWorkflows = () => request<WorkflowRow[]>('GET', '/api/workflows');

/** 详情：整行含 spec，编辑器用它初始化画布与表单。 */
export const getWorkflow = (workflowKey: string) =>
  request<WorkflowEntity>('GET', `/api/workflows/${enc(workflowKey)}`);

export const createWorkflow = (body: {
  workflowKey: string;
  displayName: string;
  description?: string | null;
  spec?: WorkflowSpec | null;
}) => request<WorkflowEntity>('POST', '/api/workflows', body);

/**
 * 保存草稿。路径上的 key 是权威，body 里的 key 只用于展示。
 *
 * 后端不做完整校验，所以这里可以在图还没画完时随时保存。
 */
export const saveWorkflow = (
  workflowKey: string,
  body: { displayName: string; description?: string | null; spec: WorkflowSpec },
) => request<WorkflowEntity>('PUT', `/api/workflows/${enc(workflowKey)}`, body);

/** 删除定义。历史运行记录不会被删。 */
export const deleteWorkflow = (workflowKey: string) =>
  request<{ deleted: string }>('DELETE', `/api/workflows/${enc(workflowKey)}`);

/**
 * 校验。
 *
 * 传 spec 校验"我正在改的这份"；不传则校验"库里存着的那份草稿"。
 * 回的是 problems 列表而不是抛错 —— 有问题是<b>一次正常的询问结果</b>，
 * 页面不该把它和"接口挂了"混在一起处理。
 */
export const validateWorkflow = (workflowKey: string, spec?: WorkflowSpec | null) =>
  request<WorkflowValidation>('POST', `/api/workflows/${enc(workflowKey)}/validate`, spec ? { spec } : {});

export const publishWorkflow = (workflowKey: string, changeNote?: string) =>
  request<PublishResult>('POST', `/api/workflows/${enc(workflowKey)}/publish`, {
    changeNote: changeNote ?? null,
  });

export const rollbackWorkflow = (workflowKey: string, version: number) =>
  request<PublishResult>('POST', `/api/workflows/${enc(workflowKey)}/rollback`, { version });

export const workflowVersions = (workflowKey: string) =>
  request<ResourceVersionInfo[]>('GET', `/api/workflows/${enc(workflowKey)}/versions`);

/**
 * 跑一次。
 *
 * 这是唯一一个会长时间占着请求的接口：后端同步跑完整条流程才回。页面必须给 loading，
 * 并且允许用户在等待期间离开 —— 运行记录已经落在库里，回来能在运行记录里看到结果。
 */
export const runWorkflow = (
  workflowKey: string,
  body?: { input?: Record<string, unknown>; userId?: string; triggerRef?: string },
) => request<WorkflowRunRow>('POST', `/api/workflows/${enc(workflowKey)}/runs`, body ?? {});

/** 某个工作流最近的执行（不含节点明细）。 */
export const listWorkflowRuns = (workflowKey: string, limit?: number) =>
  request<WorkflowRunRow[]>(
    'GET',
    buildUrl(`/api/workflows/${enc(workflowKey)}/runs`, { limit }),
  );

/** 一次执行的详情：run + 全部节点。 */
export const getWorkflowRun = (runId: string) =>
  request<WorkflowRunDetail>('GET', `/api/workflow-runs/${enc(runId)}`);
