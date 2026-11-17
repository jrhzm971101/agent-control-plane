/*
 * 查询键集中声明。
 *
 * 对齐官方前端做法：所有 queryKey 都在这里定义，失效时按同样的结构调用
 * queryClient.invalidateQueries —— 避免出现「拼接出来的键和失效时用的键不一致」。
 */
/**
 * 会话列表这一族的键前缀。
 *
 * <p>单独抽出来是因为它有两个用处：{@code sessions(filter)} 拼具体的一项，
 * 而"新会话出现了，把列表重拉一遍"要的是**整族**失效（前缀匹配）。
 * 两处各写一份 ['sessions','list'] 的话，将来改了命名只改一处，
 * 失效就会静默失效 —— 现象是"聊完新会话，左边那一栏还是不更新"。
 */
const SESSIONS_LIST = ['sessions', 'list'] as const;

export const queryKeys = {
  overview: ['overview'] as const,
  agents: ['agents'] as const,
  agent: (agentId: string) => ['agents', agentId] as const,
  tools: ['tools'] as const,
  skills: ['skills'] as const,
  skillBody: (skillId: string) => ['skills', skillId, 'body'] as const,
  prompts: ['prompts'] as const,
  mcpServers: ['mcp', 'servers'] as const,
  /*
   * 控制面四类资源（prompt / skill / mcp / agent）的版本快照列表。
   *
   * 共用一个键族是因为它们的接口形状与失效时机完全一致（发布或回滚后要重拉），
   * 分四个键只会让「失效时漏掉一个」变成可能。kind 用后端 ResourceType 的小写名。
   */
  resourceVersions: (kind: string, name: string) => ['versions', kind, name] as const,
  /** skill 详情（meta + 正文 + 附属文件）。与旧的 skillBody 不是一个形状，别复用。 */
  skillDetail: (name: string) => ['skills', name, 'detail'] as const,
  /** 中间件 bean 目录与工具目录：agent 详情页的下拉选项。 */
  toolCatalog: ['catalog', 'tools'] as const,
  middlewareChain: ['middleware', 'chain'] as const,
  middlewareCatalog: ['middleware', 'catalog'] as const,
  middlewareStages: ['middleware', 'stages'] as const,
  /*
   * 接入域：渠道（受治理资源）与网关（单行配置）。
   *
   * 渠道列表与类型清单必须分开两个键：它们来自两个接口，形状也完全不同
   *（ChannelView[] vs ChannelTypeDescriptor[]）。共用一个键会按 key 去重，
   * 谁先挂载谁把值写进缓存，另一个读到对方的形状 —— 这个坑在 traceRuns 上踩过。
   */
  channels: ['channels'] as const,
  channelTypes: ['channels', 'types'] as const,
  /** 单个渠道的详情（含明文凭据）。与列表分开：两者返回的凭据一个是打码的一个是明文。 */
  channelDetail: (channelId: string) => ['channels', channelId, 'detail'] as const,
  gateway: ['gateway'] as const,
  /*
   * 模型（md_model）是第六类受治理资源，三个键的分工与 prompt / mcp 完全一致：
   * 清单、调用参数默认值、单个模型的详情。详情与清单必须分开 ——
   * 清单里的密钥是打码的，详情是明文，共用一个键会让编辑表单回填到一串星号。
   */
  models: ['models'] as const,
  modelDefaults: ['models', 'defaults'] as const,
  model: (modelKey: string) => ['models', modelKey] as const,
  /*
   * 环境目录。
   *
   * 三个键的分工：清单、分组模板、来源诊断。
   *
   * 模板必须与清单分开：清单是按 env 一行、每行带"每个分组的状态"，模板是分组维度的声明
   *（有哪些分组、每组有哪些键）。两者形状完全不同，共用一个键会被按 key 去重互相覆盖 ——
   * 这个坑在 traceRuns 上踩过一次（见下面的注释）。
   *
   * 详情键按 envCode 分片：它带**明文值**，是编辑抽屉回填用的；清单里一个字的值都没有。
   */
  environments: ['environments'] as const,
  envGroups: ['environments', 'groups'] as const,
  envInstances: ['environments', 'instances'] as const,
  environment: (envCode: string) => ['environments', 'detail', envCode] as const,
  /*
   * 会话记录（run 按「用户 + 会话」聚合）。
   *
   * 键里带上一次请求的**全部**输入：筛选四维 + 分页两维，一个都不能少。
   * 少带一维的表现是"改了筛选却还是上一批数据"，而那种现象会被当成后端没生效。
   * 页面把同一个对象同时喂给这个键与 queryFn，就是为了让两者不可能不一致。
   */
  sessions: (filter: {
    agentId: string;
    source: string;
    from: number | null;
    to: number | null;
    keyword: string;
    /* 三态：true 有记忆 / false 无记忆 / null 不限。键里也要带它，
       否则切「有记忆 / 无记忆」时键没变，读到的还是上一批。 */
    hasState: boolean | null;
    limit: number;
    offset: number;
  }) => [...SESSIONS_LIST, filter] as const,
  /** 会话列表整族的前缀，给 invalidateQueries 用（见文件里 SESSIONS_LIST 的注释）。 */
  sessionsList: SESSIONS_LIST,
  /*
   * 会话详情：一次一块，由 (userId, sessionId) 共同决定。
   *
   * 必须带上 userId —— 库里有 user_id 为 NULL 的会话，而 sessionId 本身
   * 不保证全局唯一（各入口自己算）。只用 sessionId 做键会让两条不同用户的
   * 同名会话共用一份缓存，详情抽屉里显示的是另一个人的记录。
   */
  sessionDetail: (userId: string | null, sessionId: string) =>
    ['sessions', 'detail', userId ?? '', sessionId] as const,
  /*
   * 状态存储（会话上下文）。
   *
   * 会话列表的键里带上 table + keyword + offset：这三者共同决定一次请求的结果，
   * 少带任何一个，翻页或换表时都会命中旧缓存、显示上一页的内容。
   * 详情与原文各用一个键族：原文是有体积上限的可选动作，不该因为打开详情就被顺带拉下来。
   */
  stateTables: ['state', 'tables'] as const,
  /** 状态库名。与清单是两个接口、两种形状，共用一个键会被按 key 去重互相覆盖。 */
  stateDatabase: ['state', 'database'] as const,
  stateSessions: (table: string, keyword: string, offset: number) =>
    ['state', 'sessions', table, keyword, offset] as const,
  stateSessionDetail: (table: string, slotId: string) =>
    ['state', 'session', table, slotId] as const,
  stateRaw: (table: string, slotId: string) => ['state', 'raw', table, slotId] as const,
  /*
   * 执行链路的「最近 run 列表」单独一个键，不要图省事复用 overview。
   *
   * OverviewPage 和 TracesPage 都会拉一份 run 列表，但前者拿的是整个
   * OverviewPayload 对象，后者要的是 RunSummary[] 数组。两者共用一个键时
   * vue-query 按 key 去重，谁先挂载谁把值写进缓存，另一个直接读到对方的形状 ——
   * 于是 (runs.value ?? []).map 在对象上抛 TypeError，整个页面渲染中断。
   */
  traceRuns: ['traces', 'runs'] as const,
  traceInfo: (runId: string) => ['traces', 'info', runId] as const,
  /*
   * 对话页的可选 agent 列表。不复用控制面 agents 键：两者形状不同，
   * 本页要的是后端 AgentController 原样返回的 { name, type }。共用一个键会按 key 去重，
   * 谁先挂载谁把值写进缓存，
   * 另一个拿到形状不对的对象 —— 同一个坑在 traceRuns 上已经踩过一次。
   */
  chatAgents: ['chat', 'agents'] as const,
  workflows: ['workflows'] as const,
  workflow: (workflowId: string) => ['workflows', workflowId] as const,
  /*
   * 工作流的两个附属列表必须与详情分开成两个键族。
   *
   * 详情键是 ['workflows', key]，而运行记录/版本都用 ['workflows', key, ...] 前缀 ——
   * 前缀匹配的失效（invalidateQueries({ queryKey: ['workflows'] })）会同时命中三者，
   * 所以保存草稿后重拉的都是"这个工作流的全部东西"，不会出现"定义变了但运行记录没刷"。
   *
   * 为什么运行记录里不带 limit：页面只用一个固定条数（50），把 limit 放进键里
   * 会让"改了条数"变成一次键变更，而那是翻页行为不是数据变更。
   */
  workflowRuns: (workflowId: string) => ['workflows', workflowId, 'runs'] as const,
  workflowVersions: (workflowId: string) => ['workflows', workflowId, 'versions'] as const,

  /*
   * 工作区文件。
   *
   * 目录键里必须带齐 (agentName, userId, path) 三个 —— 它们共同决定一次请求的结果。
   * 少带 userId 尤其危险：基线与某个用户的目录树是两棵完全不同的树，
   * 切 userId 时若命中旧缓存，人会对着「另一个用户的文件」做编辑，而且看不出来。
   */
  workspaceAgents: ['workspace', 'agents'] as const,
  workspaceUsers: (agentName: string) => ['workspace', 'users', agentName] as const,
  workspaceDir: (agentName: string, userId: string, path: string) =>
    ['workspace', 'dir', agentName, userId, path] as const,
  workspaceFile: (agentName: string, userId: string, path: string) =>
    ['workspace', 'file', agentName, userId, path] as const,
  /** 失效整棵工作区缓存树用（保存/删除之后）。前缀匹配，与上面的键族同源。 */
  workspaceAll: ['workspace'] as const,
};
