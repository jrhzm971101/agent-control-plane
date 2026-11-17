/*
 * 控制面领域模型 —— 与后端 md-agent-platform 的库表 / 接口一一对应。
 *
 * 约定（改本文件前必读）：
 *
 * 1. 字段名严格等于后端 JSON 的 key，不做任何重命名。后端实体是 Lombok 的
 *    getter，Jackson 由 getter 推导属性名（getPromptKey -> promptKey），
 *    所以这里就是 camelCase 化的列名。页面拿到对象直接显示，中间不再加映射层 ——
 *    一旦有映射层，「页面显示的字段」与「库里实际存的字段」就会各自漂移，
 *    而这正是这次重构要消灭的东西。
 *
 * 2. 时间统一是 epoch millis（number），不是 ISO 字符串。后端列名就叫 xxx_at_ms，
 *    格式化交给 lib/format.ts。不要在这里转成 Date 或字符串：转一次就引入一处
 *    时区假设，而同一份数据在企微推送、SSE 流、页面上三处显示的是同一个时刻。
 *
 * 3. 三态开关用 TriState（= boolean | null），不是 boolean：
 *      null  = 未设置 —— 装配时不下发对应的 setter，用框架默认值；
 *      true  = 显式开启；
 *      false = 显式关闭。
 *    见设计文档 §5.1。压成 boolean 会让框架默认值的变化在平台上静默失效：
 *    框架把默认 maxIters 从 10 改成 20，只有 null 的语义能跟着变。
 *
 * 4. 引用字段（promptKey / tools / skillNames / mcpNames / middleware）存的是
 *    「被引用者的名字」，不存内容副本。所以页面上对应的控件永远是下拉多选，
 *    不是自由输入 —— 手输一个不存在的名字，后端校验会直接拒。
 *
 * 5. 关联对象允许为 null，且 null 是有含义的：它表示「这张表里没有这个 agent 的行」，
 *    而不是「没查到」。REACT agent 没有 harness 工作区配置是正确状态。
 */

/** 资源生命周期：DRAFT（改动只在库里）→ PUBLISHED（曾是装配源）。 */
export type ResourceStatus = 'DRAFT' | 'PUBLISHED';

/** agent 类型；决定装配期走 react 链还是 harness 链。 */
export type AgentType = 'REACT' | 'HARNESS';

/** 三态开关。见文件头第 3 条。 */
export type TriState = boolean | null;

/** 每张受治理的表都带的「版本 + 审计」列。 */
export interface Governed {
  status: ResourceStatus;
  /** 内容版本号，每次保存 +1。 */
  version: number | null;
  /** 已发布版本号；null = 从未发布（与「发布的是第 0 版」是两件事）。 */
  publishedVersion: number | null;
  publishedAtMs: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  createdBy: string | null;
  updatedBy: string | null;
}

// ==================================================================================
// 能力资源：prompt / skill / mcp
// ==================================================================================

/**
 * 提示词正文。
 *
 * body 存的是原文（纯文本 / Markdown），后端既不解析也不改写：同一份正文有两个
 * 消费者 —— 装配期原样进 builder.sysPrompt(...)，页面里原样进编辑器。
 * 所以前端也不要"顺手美化"（去首尾空白、重排标题），否则页面看到的与
 * 实际生效的就对不上了，而这类偏差在排查"为什么模型行为不对"时最难发现。
 */
export interface PromptEntity extends Governed {
  /** 主键，也是 md_agent_ref.prompt_key 引用它的名字。 */
  promptKey: string;
  /**
   * 展示名 —— 页面上唯一该露给人看的名字。
   *
   * <p>为什么不直接拿 promptKey 当标题：promptKey 是装配期 sysPrompt 的解析键、
   * 也是 md_agent_ref.prompt_key 的引用值，改一次等于新建一条 prompt。
   * 展示口径不能挂在"改一次就要走快照与重新装配"的列上。
   * 必填（后端 validatePrompt 拦），因此这里不是 `| null`。
   */
  displayName: string;
  description: string | null;
  bizTags: string[] | null;
  body: string | null;
}

/**
 * MCP 服务端。
 *
 * transport 只有 streamable / sse 两种可用：stdio（本地进程）在装配时被显式拒绝，
 * 因此 command / args / env 三列保留但页面不开放编辑 —— 表结构留着是为了将来
 * 放开本地 MCP 时改逻辑而不是改 DDL。
 */
export interface McpServerEntity extends Governed {
  /** 主键，也是 md_agent_ref.mcp_names 引用它的名字。 */
  serverName: string;
  /** 展示名；必填。理由与 PromptEntity.displayName 相同。 */
  displayName: string;
  description: string | null;
  bizTags: string[] | null;
  /** streamable | sse。 */
  transport: string | null;
  url: string | null;
  headers: Record<string, string> | null;
  queryParams: Record<string, string> | null;
  /** 工具白名单；非空则以它为准。 */
  enableTools: string[] | null;
  /** 工具黑名单；enableTools 非空时忽略本列。 */
  disableTools: string[] | null;
  timeoutMs: number | null;
  initTimeoutMs: number | null;
  /** 停用 = 不参与装配；被停用的 MCP 不允许再配到 agent 上（校验会拒）。 */
  enabled: boolean | null;
}

/**
 * skill 的治理元数据。
 *
 * 注意 skill 的内容不在本对象里：正文与附属文件由官方 MysqlSkillRepository 管理
 * （另一个 schema 的两张表）。这里的 description 只是列表页用的缓存副本，
 * 权威值在官方表 —— 若有人绕过控制面直接改官方表，本列会漂移（设计文档 §10.7）。
 */
export interface SkillMetaEntity extends Governed {
  /** 主键，与官方内容表的 name 一一对应。 */
  skillName: string;
  /**
   * 展示名（官方表只有 name）。
   *
   * <p>2026-09-22 起从选填改为必填：四类资源加渠道的展示口径必须一致，
   * 否则"哪一页可以留空"会变成一个要翻代码才能回答的问题。
   * 页面与后端校验都拦；后端列已收紧为 NOT NULL。
   */
  displayName: string;
  description: string | null;
  bizTags: string[] | null;
  enabled: boolean | null;
}

/** skill 详情：治理元数据 + 正文 + 附属文件（对应 GET /api/resources/skills/{name}）。 */
export interface SkillDetail {
  meta: SkillMetaEntity;
  /** SKILL.md 正文；内容表漂移时后端回空串而不是 500。 */
  body: string;
  /** 附属文件：相对路径 -> 文本内容。 */
  resources: Record<string, string>;
}

/** skill 的写入载荷（对应 SkillUpsert：三者必须一次提交，避免出现中间态）。 */
export interface SkillUpsert {
  meta: SkillMetaEntity;
  body: string;
  resources: Record<string, string>;
}
// ==================================================================================
// 模型（md_model）
// ==================================================================================

/**
 * md_model：一个模型 = 一套「怎么连」+ 一套「生成参数」。
 *
 * 它是<b>第六类受治理资源</b>（与 prompt / skill / mcp 同级），所以 extends Governed：
 * 端点与 apiKey 这类东西改错了需要能一键退回上一版，靠人记住旧值回填是不现实的。
 *
 * 两个名字必须分清，否则页面与 agent 配置会各说各话：
 *   · modelKey    —— 引用键。md_agent_runtime.model_ref 填的就是它，改一次等于所有引用它的
 *                    agent 集体失效。所以它在列表页只是次要索引、编辑时冻结；
 *   · displayName —— 展示名。只给人看，可以随时改。
 *
 * apiKey 在这一层是<b>明文</b>：详情接口的载荷就是编辑表单要回填的东西，
 * 打码值回传会把真密钥覆盖成六个星号（一次保存就永久损坏凭据）。
 * 列表接口给的是 {@link ModelRow.apiKeyMask} —— 两者是不同的对象，别混用。
 */
export interface ModelEntity extends Governed {
  modelKey: string;
  displayName: string;
  /** 用途分组（对话 / 记忆归并 / 向量化…）。仅页面筛选，装配层读不到它。 */
  purpose: string | null;
  /** 厂商标识（deepseek / ark / openai…）。仅展示与筛选：路由实际只看 baseUrl。 */
  provider: string | null;
  /** OpenAI 兼容端点根，例如 https://api.deepseek.com。 */
  baseUrl: string;
  /** 明文密钥。见上面的类注释。 */
  apiKey: string;
  /** 厂商侧模型名，例如 deepseek-v4-flash。 */
  modelName: string;
  /** 补全路径；null = 用框架默认（/v1/chat/completions）。 */
  endpointPath: string | null;
  /** 回填格式化器：'default' | 'deepseek-reasoning'。 */
  formatter: string | null;
  /** low | medium | high；null = 不下发。 */
  reasoningEffort: string | null;
  /*
   * 生成参数都是「可空」而不是「带默认值」：null = 不下发（交给厂商默认），
   * 而 0 是一个真实存在的采样策略（temperature=0 表示贪心）。
   * 页面上这两者必须长得不一样 ——「留空」与「填 0」是两个动作。
   */
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  /** 对应框架 contextWindowSize；null = 不下发。 */
  contextWindowSize: number | null;
  description: string | null;
  bizTags: string[] | null;
  /** 全局兜底模型：agent 没声明 modelRef 时用它。全表最多一个 true（由事务内保证）。 */
  isDefault: boolean | null;
  /** 停用后不参与装配。 */
  enabled: boolean | null;
}

/**
 * 列表行 —— 后端把实体「摊平」之后再加三个展示字段。
 *
 * 为什么不直接回 ModelEntity[]：列表要显示三样实体里没有的东西 ——
 * 打码后的密钥、引用它的 agent 数、近 7 日用量。把这三样塞回实体，等于让实体带上一批
 * 只用于展示的字段，存储细节与展示口径就混在一处了。
 *
 * 注意这里所有的可空性都放宽了一档（后端 record 的 String/Double 都可能为 null）：
 * 类型的严格程度要跟着实际载荷走，不能照抄实体的 NOT NULL 约束。
 */
export interface ModelRow {
  modelKey: string;
  displayName: string;
  purpose: string | null;
  provider: string | null;
  baseUrl: string | null;
  /** 打码值（六个星号）；密钥本身为空时是空串 —— 不是"配了一串星号"。 */
  apiKeyMask: string;
  modelName: string | null;
  endpointPath: string | null;
  formatter: string | null;
  reasoningEffort: string | null;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextWindowSize: number | null;
  description: string | null;
  bizTags: string[] | null;
  isDefault: boolean;
  enabled: boolean;
  status: ResourceStatus;
  version: number | null;
  publishedVersion: number | null;
  publishedAtMs: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  createdBy: string | null;
  updatedBy: string | null;
  /** 引用它的 agent 数（主模型 / 兜底 / 子 agent / 记忆压缩四处引用的去重计数）。 */
  agentCount: number;
  /**
   * 靠它兜底的 agent 数（`md_agent_runtime.model_ref` 为空的那批）；非默认模型恒为 0。
   *
   * 这批 agent 「用」这个模型但不「引用」它，所以不计入 agentCount ——
   * 卡片上必须把它和 agentCount 一起显示，否则会出现
   * 「0 个 agent 指定 · 近 7 日 66k token」这种自相矛盾的画面。
   */
  fallbackForAgents: number;
  /** 近 7 日 token 合计；没有数据是 0（不是 null）。 */
  tokens7d: number;
  /** 近 7 日执行次数；没有数据是 0。 */
  runs7d: number;
}

/** 详情：明文实体 + 引用清单 + 用量（对应 GET /api/models/{key}）。 */
export interface ModelDetail {
  model: ModelEntity;
  agentCount: number;
  tokens7d: number;
  runs7d: number;
  /** 引用它的 agent 名（后端已去重排序），页面直接列出来。 */
  usedByAgents: string[];
}

/** 「调用参数默认值」里的一行。note 是人话补充，页面上显示为灰色小字。 */
export interface DefaultsItem {
  label: string;
  value: string;
  note: string | null;
}

/**
 * 调用参数默认值 —— 页面要能说清「没配的那部分去哪了」。
 *
 * fallbackSource 取 'md_model' 或 'application.yml'：后者正是
 * 「模型表是空的、agent 却跑得好好的」这个现象的答案，页面上必须如实显示，不能藏起来。
 */
export interface ModelDefaults {
  /** 当前生效的兜底模型键；null = 没有任何兜底（装配期会直接失败）。 */
  fallbackKey: string | null;
  fallbackSource: string;
  items: DefaultsItem[];
}

/**
 * 连通性探测结果。
 *
 * detail 在失败时是<b>异常原文</b>（不做美化）：401、DNS 解析失败、连接超时
 * 这三种原因对应三种完全不同的修法，统一成一句「测试失败」等于把信息删掉。
 */
export interface ConnectionTest {
  ok: boolean;
  detail: string;
}

// ==================================================================================
// Agent：主表 + 5 张关联表
// ==================================================================================

/** md_agent 主表：只装「身份 + 生命周期」，运行时旋钮在 runtime，能力开关在 workspace。 */
export interface AgentEntity extends Governed {
  /** 主键，也是装配时的 AgentDefinition.name。 */
  agentName: string;
  /**
   * 展示名；必填。
   *
   * <p>agentName 同时兼任运行时注册键、前端路由参数（/chat/:agentId）与装配名，
   * 所以它不能承担展示职责 —— 详见后端 AgentEntity.displayName 的说明。
   * 页面标题一律取本字段，agentName 只作为次要的 mono 索引露出。
   */
  displayName: string;
  agentType: AgentType;
  description: string | null;
  /** 业务标签，仅控制面用（分组/筛选），不参与装配。 */
  bizTags: string[] | null;
  /** 能力分组（页面筛选用）。 */
  category: string | null;
  /** 是否参与装配；false = 从注册表摘掉。 */
  enabled: boolean | null;
}

/**
 * md_agent_ref：「这个 agent 用了谁」。
 *
 * 每一列都是引用，页面上对应一个下拉控件。不要把被引用者的内容抄进来 ——
 * 那是「三套真相」的老问题。数组顺序有语义的只有 mcpNames（决定装配顺序）。
 */
export interface AgentRefEntity {
  agentName: string;
  /** 引用 md_prompt.prompt_key；非空时其正文成为 sysPrompt。 */
  promptKey: string | null;
  /** Spring 工具 bean 名（不是 @Tool 名）—— 校验与列表都按 bean 名。 */
  tools: string[] | null;
  /** 中间件 bean 名。 */
  middleware: string[] | null;
  /** 引用 md_skill_meta.skill_name。 */
  skillNames: string[] | null;
  /** 引用 md_mcp_server.server_name，顺序即装配顺序。 */
  mcpNames: string[] | null;
  /** RAG Knowledge bean 名；装配层当前有意不映射（框架 knowledge() 已废弃）。 */
  knowledges: string[] | null;
}

/** md_agent_runtime：模型 + 迭代/重试 + 行为开关 + 结构化配置。 */
export interface AgentRuntimeEntity {
  agentName: string;
  /** 主模型 bean 名；空则用框架默认（openAIChatModel）。 */
  modelRef: string | null;
  /** 兜底模型 bean 名；空则不套任何默认（与 modelRef 的默认行为不对称，是刻意的）。 */
  fallbackModelRef: string | null;
  /** low | medium | high。 */
  reasoningEffort: string | null;
  maxIters: number | null;
  maxRetries: number | null;
  /** HARNESS 最大上下文 token；null 表示框架默认。 */
  maxContextTokens: number | null;
  checkRunning: TriState;
  stopOnReject: TriState;
  enableMetaTool: TriState;
  enableTaskList: TriState;
  enablePendingToolRecovery: TriState;
  /** REACT 专有：OVERWRITE | FAIL | APPEND_MERGE。 */
  conflictPolicy: string | null;
  /**
   * REACT 专有的技能策略。三项都出自 ReActAgent.Builder，HarnessAgent.Builder 上没有对应方法。
   *
   * 2026-09-22 从 md_agent_workspace 迁到这里：迁走之后那张表才是纯 HARNESS 表，
   * 可以整表归属于 Harness 工作台页；本表则是"两链共有调优 + REACT 专有项"。
   */
  dynamicSkillsEnabled: TriState;
  skillCodeExecutionEnabled: TriState;
  /** 技能执行工作目录（相对 workspace-root）。 */
  skillWorkDir: string | null;
  /**
   * 状态存储开关：非空 = 启用会话持久化（MysqlAgentStateStore）。
   *
   * <p>值本身不参与任何逻辑，后端只判"非不非空"：落地库由 agent-platform.state-store-database
   * 决定，表名由 state_table 决定（为空回落 agent 名）。页面把它做成了开 / 关的下拉，
   * 提交值固定 'mysql' —— 口径与归一化都在 lib/stateStore.ts，不要在这一层再解释一遍。
   */
  stateStore: string | null;
  defaultSessionId: string | null;
  /** AGENT_CONTROL | STATIC_CONTROL | BOTH。 */
  longTermMemoryMode: string | null;
  longTermMemoryAsync: TriState;
  ragMode: string | null;
  /** 以下五项是 JSON 列，字段少且没有按子字段查询的需求，所以不做子表。 */
  generateOptions: Record<string, unknown> | null;
  modelExecutionConfig: Record<string, unknown> | null;
  toolExecutionConfig: Record<string, unknown> | null;
  retrieveConfig: Record<string, unknown> | null;
  permission: Record<string, unknown> | null;
}

/**
 * md_agent_memory：上下文压缩 + 记忆 + 工具结果驱逐。
 *
 * 三块合成一张表是因为它们回答同一个问题 —— 上下文随轮次变长时怎么收敛 ——
 * 且相互影响（压缩阈值调大，大工具结果更容易撑爆上下文，驱逐阈值要跟着调）。
 *
 * <p>注意 compactionDisabled 与 evictDisabled 是 NOT NULL DEFAULT 0，
 * <b>不是</b>三态；其余字段的空值语义见文件头第 3 条。
 */
export interface AgentMemoryEntity {
  agentName: string;
  /** 注意：非三态，not null default 0。 */
  compactionDisabled: boolean | null;
  triggerMessages: number | null;
  triggerTokens: number | null;
  reserved: number | null;
  keepMessages: number | null;
  keepTokens: number | null;
  keepTokensMin: number | null;
  keepTokensMax: number | null;
  /** 后端是 BigDecimal，JSON 序列化成 number。 */
  keepTokensRatio: number | null;
  summaryPrompt: string | null;
  flushBeforeCompact: TriState;
  offloadBeforeCompact: TriState;
  compactionModelRef: string | null;
  truncateArgs: Record<string, unknown> | null;
  prune: Record<string, unknown> | null;
  memoryModelRef: string | null;
  flushPrompt: string | null;
  consolidationPrompt: string | null;
  consolidationMaxTokens: number | null;
  consolidationMinGapMs: number | null;
  dailyFileRetentionDays: number | null;
  sessionRetentionDays: number | null;
  flushTrigger: Record<string, unknown> | null;
  /** 注意：非三态，not null default 0。 */
  evictDisabled: boolean | null;
  evictMaxResultChars: number | null;
  evictPreviewChars: number | null;
  evictPath: string | null;
  evictExcludedTools: string[] | null;
}

/**
 * md_agent_workspace：Harness 工作区与能力开关（HARNESS 专有）。
 *
 * 这 13 个 disableXxx 是「能力裁剪」的正交开关，全部三态。页面必须把它们渲染成
 * 三选（未设置 / 开启 / 关闭）而不是复选框：复选框没有"未设置"这一档，
 * 一保存就把 null 写成 false，等于替框架钉死了默认值。
 */
export interface AgentWorkspaceEntity {
  agentName: string;
  harnessAgentId: string | null;
  workspacePath: string | null;
  /** 工作区文件后端：LOCAL(默认，本地磁盘+shell) | REMOTE(进 md_agent_workspace KV，无 shell)。 */
  fsBackend: string | null;
  environment: string | null;
  environmentMemory: string | null;
  projectGlobalSkillsDir: string | null;
  planFileDirectory: string | null;
  /** 额外注入上下文的文件清单。 */
  additionalContextFiles: string[] | null;
  filesystem: Record<string, unknown> | null;
  useLegacyXmlWorkspaceContext: TriState;
  agentTracingLogEnabled: TriState;
  enablePlanMode: TriState;
  planModeAllowShell: TriState;
  /** 技能总开关。 */
  skillsEnabled: TriState;
  enableSkills: string[] | null;
  disableSkills: string[] | null;
  /** 是否启用技能管理工具。 */
  skillManageToolEnabled: TriState;
  skillManageConfig: Record<string, unknown> | null;
  disableFilesystemTools: TriState;
  disableShellTool: TriState;
  disableMemoryTools: TriState;
  disableMemoryHooks: TriState;
  disableTranscript: TriState;
  disableSessionPersistence: TriState;
  disableWorkspaceContext: TriState;
  disableAtPathExpansion: TriState;
  disableSubagents: TriState;
  disableDynamicSubagents: TriState;
  disableDynamicSkills: TriState;
  disableDefaultWorkspaceSkills: TriState;
  disableToolsConfig: TriState;
  /**
   * 是否强制子 agent 同步执行（三态）。
   *
   * 框架默认由模型自己填的 agent_spawn.timeout_seconds 决定同步还是丢后台 ——
   * 对"必须拿到结果才能继续"的编排，这种不确定性是致命的（同步等超时还会被自动转成后台任务）。
   * 打开后装配层会在运行入口的 RuntimeContext 上写 AgentSpawnTool.CTX_FORCE_SYNC，优先级高于模型参数。
   */
  subagentForceSync: TriState;
  /** 强制同步时的等待秒数；null = 框架默认 30。仅在 subagentForceSync 打开时有意义。 */
  subagentSyncTimeoutSeconds: number | null;
}

/**
 * md_agent_sub_agent：HARNESS 的子 agent 声明，一行一个。
 *
 * 逐字段建列（而不是像 runtime 那样塞 JSON）的理由：页面上它是一个可增删的表格，
 * 需要按列校验（maxIters 必须为正整数、temperature 0~2）、按 sortOrder 排序、
 * 按 subName 去重。同时顺序会影响 harness 给模型呈现子 agent 的先后，所以要保序。
 */
export interface AgentSubAgentEntity {
  /** 自增 id；新增行时后端会忽略它。 */
  id?: number | null;
  agentName?: string | null;
  /** 子 agent 名；本地子 agent = 另一个 md_agent.agent_name。 */
  subName: string;
  /** 展示顺序，从 0 开始。 */
  sortOrder: number | null;
  /** 派发职责说明；不填则装配时回落到子 agent 自己的 description。 */
  subDescription: string | null;
  /** ISOLATED | SHARED。 */
  workspaceMode: string | null;
  workspacePath: string | null;
  /** 内联 AGENTS.md 正文；空则读子 agent 自己定义里的提示词。 */
  inlineAgentsBody: string | null;
  modelRef: string | null;
  maxIters: number | null;
  steps: number | null;
  /** 后端 BigDecimal。 */
  temperature: number | null;
  topP: number | null;
  variant: string | null;
  /** PRIMARY | SUBAGENT | ALL。 */
  mode: string | null;
  hidden: TriState;
  persistSession: TriState;
  inheritParentPermissions: TriState;
  exposeToUser: TriState;
  tools: string[] | null;
  skills: string[] | null;
  // ---- 远端子 agent（A2A）----
  remote: TriState;
  url: string | null;
  headers: Record<string, string> | null;
  remoteStreaming: TriState;
  remoteStreamDetail: string | null;
  remoteAskPolicy: string | null;
  remoteContextAttributes: Record<string, unknown> | null;
}

/**
 * 一个 agent 的全部内容行（对应 GET /api/agents/{name}）。
 *
 * 这是页面编辑表单与后端之间唯一的形状：页面按域分区编辑（身份 / 引用 / 运行时 /
 * 记忆 / 工作区 / 子 agent），存的就是这束行。中间不经过 AgentDefinition ——
 * 那条「行束 -> 定义」的转换只发生在装配期，于是"页面存什么"与"装配读什么"
 * 共用同一份结构，不会出现两个方向的映射各自漂移。
 */
export interface AgentDefinitionBundle {
  /** 主表行，不可为 null。 */
  agent: AgentEntity;
  ref: AgentRefEntity | null;
  runtime: AgentRuntimeEntity | null;
  memory: AgentMemoryEntity | null;
  workspace: AgentWorkspaceEntity | null;
  /** 按 sortOrder 升序。 */
  subAgents: AgentSubAgentEntity[] | null;
}

/**
 * 列表行（对应 GET /api/agents）—— 主表字段 + 引用名清单 + 运行时是否已注册。
 *
 * loaded 与 enabled 不是一回事：改过但还没发布时 enabled 是 true，
 * 而实例仍是旧的；停用则会从注册表里摘掉，此时 loaded=false。
 *
 * 引用回的是名字清单而不是计数，是为了让资源页能反向算出「这个 prompt / skill /
 * mcp 被哪些 agent 引用」—— 那是删除保护的依据，也是列表上最有用的一列。
 * 计数在页面里用 names.length 算，不再单独回传。空数组与 null 已统一成 null。
 */
export interface AgentRow {
  agentName: string;
  /** 展示名；卡片标题取它，agentName 降为次要索引。 */
  displayName: string;
  agentType: AgentType;
  description: string | null;
  category: string | null;
  bizTags: string[] | null;
  status: ResourceStatus;
  version: number | null;
  publishedVersion: number | null;
  publishedAtMs: number | null;
  enabled: boolean | null;
  updatedAtMs: number | null;
  /** 引用 md_prompt.prompt_key；null = 没配（等价于空串）。 */
  promptKey: string | null;
  tools: string[] | null;
  middleware: string[] | null;
  skillNames: string[] | null;
  mcpNames: string[] | null;
  /** 子 agent 名，按 sortOrder 升序。 */
  subAgentNames: string[];
  loaded: boolean;
}

/** 版本快照的列表投影（不含 snapshot_json，页面只需要这四列）。 */
export interface ResourceVersionInfo {
  version: number;
  changeNote: string | null;
  createdAtMs: number;
  createdBy: string | null;
}

/** 发布结果：热装配重建了哪些 agent + 过程中的告警。 */
export interface PublishResult {
  reloadedAgents: string[];
  note: string | null;
}

// ==================================================================================
// 只读目录（工具与中间件不落库，它们的选项来自扫 bean）
// ==================================================================================

/** 工具目录项；name 是运行时工具名，beanName 才是 agent 引用时要填的值。 */
export interface ToolMeta {
  name: string;
  beanName: string;
  description: string | null;
  parameters: Array<{ name: string; description: string | null }> | null;
}

/** 中间件目录项。 */
export interface MiddlewareMeta {
  beanName: string;
  simpleName: string;
  className: string;
}

/** GET /api/resources/middleware 的返回：全局链很短，其余按 agent 声明挂载。 */
export interface MiddlewareChainInfo {
  global: string[];
  note: string;
}

// ==================================================================================
// 接入域：渠道（channel）与网关（gateway）
// ==================================================================================

/**
 * 渠道族的归属。
 *
 * OFFICIAL = 官方回调式接入（自建应用 + 公网回调地址，回复由官方 outbound 直发），
 * BOT      = 本项目的长连接机器人（企微智能机器人 / 飞书 WS，回复由本项目渲染器发出）。
 * 同一平台的两套接入方式，凭据与回复形态都不同，所以是并列的两个类型而不是一个开关。
 */
export type ChannelKind = 'OFFICIAL' | 'BOT';

/** 单聊会话键的收敛范围；取值与官方 DmScope 枚举同名。 */
export type DmScope = 'MAIN' | 'PER_PEER' | 'PER_CHANNEL_PEER' | 'PER_ACCOUNT_CHANNEL_PEER';

/** 回复渲染风格；null = 按平台推断（企微→流式思考卡片，飞书→卡片）。 */
export type ReplyStyleName = 'WECOM_THINK' | 'FEISHU_CARD';

/**
 * 渠道类型的"能力声明"，来自后端 GET /api/channels/types。
 *
 * 页面的类型下拉与凭据表单<b>完全由它驱动</b>：加一个平台时前端零改动。
 * properties[].key 是写进 channel.properties 的键名，必须原样用，不要在前端改名。
 */
export interface ChannelTypeDescriptor {
  /** 存进 md_channel.channel_type 的取值：wecom-bot / feishu-bot / wecom / feishu / dingtalk / gitlab。 */
  typeId: string;
  label: string;
  kind: ChannelKind;
  /** 一句话说明这个类型适合什么场景。 */
  description: string;
  properties: ChannelPropertySpec[];
  /** 单聊会话范围在这个类型上的支持情况；options 为空 = 不适用（长连接机器人、GitLab）。 */
  dmScope: ChannelCapability;
  /** 回复风格在这个类型上的支持情况；options 为空 = 不适用（回调式的回复由官方 outbound 渲染）。 */
  replyStyle: ChannelCapability;
}

/**
 * 一个「行为参数」在某类型上的支持声明（对应后端 ChannelCapability）。
 *
 * options 为空 = 这个类型根本不读这个参数：页面不渲染该控件，只显示 note 里的原因。
 * 原因必须展示 —— "控件消失"与"控件被藏起来"在用户眼里是同一件事，
 * 不解释的话唯一的结论只能是"页面坏了"。
 */
export interface ChannelCapability {
  /** 该类型支持的取值；空数组 = 不适用。 */
  options: string[];
  /** 适用时的一句提醒、或不适用时的原因说明。 */
  note: string | null;
}

/** 类型的一个连接凭据字段 —— 页面据此渲染输入框（含中文标签、必填、打码）。 */
export interface ChannelPropertySpec {
  key: string;
  label: string;
  required: boolean;
  /** 敏感字段：列表接口会把它打码成 ******；编辑时不要把这串原样回传。 */
  secret: boolean;
  placeholder: string | null;
  hint: string | null;
}

/**
 * 渠道绑定规则 —— 与官方 ChannelBinding record 逐字段对应。
 *
 * 优先级（高→低）：peer > parentPeer > guild+roles > guild > team > account > channel。
 * 七个条件全空是一条永远不会命中的死规则（后端会拒），所以至少填一个。
 */
export interface ChannelBindingEntity {
  /** 自增主键；新建时传 null，后端忽略页面传的值。 */
  id: number | null;
  channelId: string;
  /** 命中后交给哪个 agent。 */
  agentId: string;
  peer: string | null;
  parentPeer: string | null;
  guild: string | null;
  roles: string[] | null;
  team: string | null;
  account: string | null;
  channel: string | null;
  /** 该绑定的会话范围覆盖；null = 用渠道级 dmScope。 */
  sessionScope: DmScope | null;
  /** 同层内的匹配顺序，从 0 开始。 */
  sortOrder: number | null;
}

/**
 * 渠道行（md_channel）。
 *
 * properties 是按类型而变的凭据 map：企微机器人两个键、飞书五个键……
 * 所以页面必须按 ChannelTypeDescriptor.properties 渲染，不能写死字段。
 */
export interface ChannelEntity extends Governed {
  channelId: string;
  channelType: string;
  /**
   * 展示名；必填。
   *
   * <p>2026-09-22 起从选填改为必填：列表首列取它，channelId 降为次要的 mono 索引 ——
   * 留空会让整张表的首列空掉，比显示一个机器名更糟。
   */
  displayName: string;
  description: string | null;
  ownerId: string | null;
  /** 兜底 agent；null = 用网关主 agent。 */
  defaultAgentId: string | null;
  dmScope: DmScope | null;
  replyStyle: ReplyStyleName | null;
  properties: Record<string, unknown> | null;
  /** 是否参与装配（停用但不删除）。 */
  enabled: boolean | null;
}

/** 渠道的运行时状态（后端 ChannelRuntimeStatus）。 */
export interface ChannelRuntimeStatus {
  channelId: string;
  channelType: string;
  /** 类型的中文名；null = 该类型未注册（工厂被删了或类型名写错）。 */
  typeLabel: string | null;
  kind: ChannelKind | null;
  enabled: boolean;
  status: ResourceStatus;
  publishedVersion: number | null;
  /** 当前是否有活着的实例。 */
  started: boolean;
  /** 实例自报的可用性（长连接重连期间会短暂 false）。 */
  alive: boolean;
  /** 最近一次装配/启动失败的原因；null = 无错误。 */
  error: string | null;
  bindingCount: number;
  appliedAtMs: number | null;
}

/**
 * 页面用的渠道行：库内容 + 运行时状态的合并结果（后端 ChannelController.ChannelView）。
 *
 * 为什么不拆成两个接口让前端自己按 id 拼：拼错了的表现是"状态显示串行"，
 * 那种 bug 从页面上看像数据问题，实际是接口设计问题。
 */
export interface ChannelView {
  channelId: string;
  channelType: string;
  typeLabel: string | null;
  kind: ChannelKind | null;
  displayName: string | null;
  description: string | null;
  ownerId: string | null;
  defaultAgentId: string | null;
  dmScope: DmScope | null;
  replyStyle: ReplyStyleName | null;
  /** 列表接口里敏感字段是 ******；详情接口是明文（编辑表单要回填）。 */
  properties: Record<string, unknown> | null;
  enabled: boolean;
  status: ResourceStatus;
  version: number | null;
  publishedVersion: number | null;
  publishedAtMs: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  createdBy: string | null;
  updatedBy: string | null;
  bindings: ChannelBindingEntity[];
  runtime: ChannelRuntimeStatus;
}

/** 写入载荷：渠道行 + 它的全部绑定行（一次提交，整体替换）。 */
export interface ChannelUpsert {
  channel: ChannelEntity;
  bindings: ChannelBindingEntity[];
}

/** 网关运行时快照（后端 ManagedGateway）。 */
export interface ManagedGateway {
  /** 是否装配成功。false 时 note 解释"为什么没装成"。 */
  built: boolean;
  /** 库里的主 agent；null = 未设置。 */
  mainAgentId: string | null;
  /** 实际纳管的 HARNESS agent 名，升序；同时也是"可选为主 agent"的候选集。 */
  agentIds: string[];
  /** 路由兜底 agent —— 没有任何绑定与渠道兜底命中时消息的落点。 */
  routerDefault: string | null;
  /** 人话说明：未装配的原因，或装配完成的一句话；null = 一切正常。 */
  note: string | null;
  loadedAtMs: number | null;
}

/** GET /api/gateway 的返回。 */
export interface GatewayView {
  mainAgentId: string | null;
  description: string | null;
  updatedAtMs: number | null;
  updatedBy: string | null;
  runtime: ManagedGateway;
  candidates: string[];
}

// ==================================================================================
// 工作区文件（HARNESS agent 的 workspace/）
// ==================================================================================

/*
 * 这一组的形状来自后端 server/workspace/WorkspaceViews.java，与它一一对应。
 *
 * 与上面几组资源最明显的差别：这里<b>没有</b> status / version / publishedVersion 这些治理列。
 * 工作区文件不是"受治理资源"，它直接就是 agent 运行时读到的东西 —— 改完即生效，
 * 没有草稿态，也没有版本快照。所以页面上也没有发布/回滚按钮，只有保存与删除。
 *
 * 两个字段需要单独说清楚，它们都是"页面必须照着做，不能自己再算一遍"的：
 *
 *   - writable：后端白名单算出来的可写性。页面的编辑/删除入口一律以它为准 ——
 *     在前端另抄一份白名单必然与后端漂移，而"前端说能写、后端 400"是最难向用户解释的一类失败。
 *   - truncated：内容超过后端读取上限被截断。必须显式提示，否则用户会以为"文件就这么长"，
 *     然后照着一份残缺内容去做判断。
 */

/** 有工作区的 agent（= 已装配的 HARNESS 实例）。 */
export interface WorkspaceAgentRow {
  agentName: string;
  /** 配置的工作区文件后端：LOCAL | REMOTE；null = 库里没有这张 workspace 行。 */
  fsBackend: string | null;
  /** 工作区根路径。REMOTE 下它只是逻辑根，不代表真在磁盘上。 */
  workspacePath: string | null;
  /**
   * 真正装配出来的 filesystem 实现类名（LocalFilesystem / CompositeFilesystem…）。
   *
   * <p>这是本页唯一的「自证字段」：fsBackend 只是配置，这个才是真正生效的东西 ——
   * 排查「配了 REMOTE 但文件还落在磁盘」时先看它。
   */
  filesystemType: string | null;
}

/**
 * 「隔离维度」下拉框的一个候选值 —— 这个 agent 被哪个身份用过。
 *
 * <h2>为什么候选值由后端给</h2>
 * 工作区按 userId 隔离，而「有哪些 userId」只有后端知道：前端既没有 agentscope_store
 * 的命名空间，也不该去猜角色名（console 之类）。这里少一个字段就会退化成手输 ID，
 * 而手输的代价是"输错一个字符看到一片空白"，看不出是拼错了还是那个人真没东西。
 */
export interface WorkspaceUserRow {
  /** 工作区命名空间里的那一段。 */
  userId: string;
  /** 这个身份在这个 agent 上跑过多少次。 */
  runs: number;
  /** 最近一次执行的开始时刻（epoch millis），排序与展示都用它。 */
  lastActiveMs: number;
}
/** 目录里的一项。 */
export interface WorkspaceEntry {
  name: string;
  /** 工作区相对路径（不含前导 /），直接拿它继续下钻或读取。 */
  path: string;
  directory: boolean;
  /** 根级文件不给 size（后端不为了显示一个数字去读全文），页面把 0 显示成「—」。 */
  size: number;
  /** 框架给的修改时间；根级条目为空串。 */
  modifiedAt: string;
  writable: boolean;
}

/** 列目录结果。path 为空串表示工作区根。 */
export interface WorkspaceDirView {
  agentName: string;
  /** 生效的隔离维度；null = 基线层（出厂模板所在的地方，不属于任何用户）。 */
  userId: string | null;
  path: string;
  entries: WorkspaceEntry[];
}

/** 单个文件的内容。 */
export interface WorkspaceFileView {
  agentName: string;
  userId: string | null;
  path: string;
  content: string;
  size: number;
  writable: boolean;
  /** 内容超过后端读取上限被截断。 */
  truncated: boolean;
}

/** 删除结果。 */
export interface WorkspaceDeleteResult {
  path: string;
  deleted: boolean;
}


// ==================================================================================
// 环境目录（/api/environments + /api/env-groups）
// ==================================================================================

/*
 * 这一组形状与其余几组元数据有一个根本差别：**它是动态的**。
 *
 * 页面上的表格列不是写死的「Nacos / K8s / RabbitMQ / XXL-Job / OpenObserve」，
 * 而是由后端返回的分组模板 drive 出来的。所以这里没有一个 "components" 字面量类型，
 * 有的是 groupCode 这个字符串键 —— 加一个业务分组（比如 biz），前端一行都不用改。
 *
 * 代价是取值时必须先按 groupCode 找到那一项，写起来比 row.components['Nacos'] 啰嗦。
 * 这笔交易换来的是"页面不再知道有哪些分组"，这正是这次改造的目的。
 */

/** 分组健康状态。 */
export type EnvGroupStatus = 'READY' | 'PARTIAL' | 'EMPTY';

/** 分组模板里的一个键声明。 */
export interface EnvGroupKeyTemplate {
  /** 键名。与后端 POJO 字段名逐字一致（serverAddr / authorization…），页面只应该把它当"展示用的技术名"。 */
  keyCode: string;
  /** 表单上给人看的字段名。 */
  label: string;
  valueType: string;
  /** 缺失会计入完整度缺口；但**不阻断保存** —— 凭据拿不到时也要能先存下来。 */
  required: boolean;
  /** 凭据：参与检索的只有 label，值不进关键字匹配。 */
  secret: boolean;
  placeholder: string | null;
  /** 格式示意，不是默认值 —— 表单绝不能拿它预填。 */
  exampleValue: string | null;
  description: string | null;
  sortOrder: number;
  /**
   * <b>只由后端给出的派生标记</b>：该键名被工具代码强引用（EnvironmentRegistry 对该分组的强类型投影）。
   * 为 true 时不能改名、也不能删除 —— 页面允许的话，工具会静默拿到 null（投影走 Jackson，认不出的键被忽略）。
   * 请求体里带上它会被忽略：这个标记跟着代码走，不由页面决定。
   */
  reserved: boolean;
}

/** 分组模板。列表页的列、详情页的区块、模板编辑器都读它。 */
export interface EnvGroupTemplate {
  groupCode: string;
  displayName: string;
  icon: string | null;
  description: string | null;
  /** true = 被工具代码强引用（EnvironmentRegistry 的强类型访问器），不可删除。 */
  builtin: boolean;
  sortOrder: number;
  keys: EnvGroupKeyTemplate[];
}

/** 列表里一格的聚合状态。**不含量**，所以列表接口不存在明文过线的问题。 */
export interface EnvGroupState {
  groupCode: string;
  displayName: string;
  status: EnvGroupStatus;
  /** 缺哪些必填项（用 label，直接可显示）。EMPTY 时列出全部必填项。 */
  missing: string[];
  /** 该分组下维护了几个实例；0 表示还没建实例。 */
  instanceCount: number;
}

/** 环境列表的一行。 */
export interface EnvRow {
  envCode: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  sortOrder: number;
  updatedAtMs: number;
  updatedBy: string | null;
  /** 顺序与分组模板一致，页面按下标对齐列。 */
  groups: EnvGroupState[];
  /** 已填的必填键数 / 必填键总数。 */
  readyKeys: number;
  requiredKeys: number;
}

/** 详情里的一个键值。值为<b>明文</b>（调试期决定）。 */
export interface EnvKeyValue {
  keyCode: string;
  label: string;
  valueType: string;
  required: boolean;
  secret: boolean;
  value: string | null;
}

/** 环境详情里的一个已绑定实例；不含配置值。 */
export interface EnvDetailInstance {
  instanceCode: string;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
}

/** 环境详情里的一个已绑定分组。 */
export interface EnvDetailGroup {
  groupCode: string;
  displayName: string;
  instances: EnvDetailInstance[];
}

/** 环境详情 —— 只服务主表单与绑定关系回填，配置值走实例详情接口。 */
export interface EnvDetail {
  envCode: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAtMs: number;
  updatedAtMs: number;
  createdBy: string | null;
  updatedBy: string | null;
  groups: EnvDetailGroup[];
}

/** 页面「分组实例」维护区的一行。实例是分组级元数据，不在环境上重复。 */
export interface EnvInstanceRow {
  groupCode: string;
  groupDisplayName: string;
  instanceCode: string;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
}

/** 实例编辑弹窗的数据源：元数据 + 该实例自己的固定配置值。 */
export interface EnvInstanceDetail {
  groupCode: string;
  groupDisplayName: string;
  instanceCode: string;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
  values: EnvKeyValue[];
}

/**
 * 新建 / 更新实例。实例编码在 URL 上，配置值也属于实例本身。
 *
 * values 省略表示不改配置；空对象表示清空配置。页面保存时总是提交完整值。
 */
export interface EnvInstanceSaveRequest {
  displayName: string;
  enabled?: boolean;
  sortOrder?: number;
  values?: Record<string, string>;
}

export interface EnvSaveRequest {
  /** 新建时必填；保存时后端以路径上的 envCode 为准（改名 = 删除 + 新建）。 */
  envCode?: string;
  displayName: string;
  description?: string;
  enabled?: boolean;
  sortOrder?: number;
  /** 分组 → 实例编码。**整体替换绑定关系**；环境不保存任何配置值。 */
  bindings: Record<string, string[]>;
}

/** 新建 / 保存分组模板的请求体（键声明整体替换）。 */
export interface EnvGroupSaveRequest {
  groupCode: string;
  displayName: string;
  icon?: string | null;
  description?: string | null;
  sortOrder?: number;
  keys: EnvGroupKeyTemplate[];
}

/** 模板保存结果。removedKeys 非空时必须提示 —— 那些键在各环境上的值被一并清掉了。 */
export interface EnvGroupSaveResult {
  groupCode: string;
  saved: boolean;
  removedKeys: string[];
}

// ================================================================================
// 工作流（md_workflow / md_workflow_run）
// ================================================================================

/**
 * 节点类型。
 *
 * 只有三种是可用的：另外五个名字（team / approval / timer / signal / subrun）后端
 * 认得但会明确拒绝 —— 它们要"挂起 + 跨进程恢复"这类机制，属于后续批次。
 * 放在同一个联合类型里而不是剔除，是为了让页面的下拉框能如实展示"有这个名字、现在不能用"，
 * 而不是让人以为是自己拼错了单词。
 */
export type WorkflowNodeType = 'agent' | 'condition' | 'join';

/** 后端认得但当前版本不支持的节点类型；选了它们，发布时的校验会给出明确理由。 */
export const WORKFLOW_UNSUPPORTED_NODE_TYPES = [
  'team',
  'approval',
  'timer',
  'signal',
  'subrun',
] as const;

/** join 的汇合模式；第一批只有 all。 */
export type JoinMode = 'all';

/** join 节点的配置。 */
export interface WorkflowJoinSpec {
  /** 不填按 all 处理。 */
  mode?: JoinMode | string | null;
  quorum?: number | null;
}

/**
 * 一个节点。
 *
 * 除 key / type 外全部可选：不同类型用不同字段（agent 用 agentId、condition 用 condition、
 * join 用 join）。不做成"三个子类型 + 判别联合"是因为这个对象要原样存成 JSON、
 * 也由页面表单直接编辑 —— 判别联合会逼着表单在切换类型时重建整个对象。
 */
export interface WorkflowNode {
  /** 节点标识，也是表达式里的寻址方式（node.<key>.text）。创建后改它等于断开所有引用。 */
  key: string;
  type: WorkflowNodeType | string;
  /** 画布上显示的说明；也会作为"本步任务"拼进给 agent 的消息。 */
  label?: string | null;
  /** agent 节点：目标 agent 名。 */
  agentId?: string | null;
  /** condition 节点：分支表达式（受限子集，见后端 WorkflowConditionEvaluator）。 */
  condition?: string | null;
  /** join 节点：汇合配置。 */
  join?: WorkflowJoinSpec | null;
  /** 暂不支持的类型的配置，原样透传，不会丢。 */
  teamRef?: unknown;
  signalName?: unknown;
  timer?: unknown;
  approval?: unknown;
  subrun?: unknown;
}

/** 一条边。condition 只允许出现在 condition 节点的出边上（发布会校验）。 */
export interface WorkflowEdge {
  from: string;
  to: string;
  /**
   * 边的条件。同一个 condition 节点的出边按<b>声明顺序</b>求值，
   * 取第一条成立的；所以"兜底边"要放在最后一条并且不写条件。
   */
  condition?: string | null;
}

/** 节点图。 */
export interface WorkflowSpec {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * 列表行：治理字段 + 节点/边数量，**不含 spec**。
 *
 * <p>刻意<b>不</b> extends Governed：后端这个投影只回列表页真正用到的那些列，
 * createdAtMs / createdBy / updatedBy 三个字段不在响应里。声明成 Governed 会让
 * 页面以为「拿得到创建人」而实际拿到 undefined —— 这类谎报只有点进页面才暴露。
 */
export interface WorkflowRow {
  workflowKey: string;
  displayName: string;
  description: string | null;
  status: ResourceStatus;
  /** 草稿版本号，每次保存 +1。 */
  version: number | null;
  /** 已发布版本号；null = 从未发布（与「发布的是第 0 版」是两件事）。 */
  publishedVersion: number | null;
  publishedAtMs: number | null;
  updatedAtMs: number | null;
  nodeCount: number;
  edgeCount: number;
}

/** 工作流详情：整行含 spec，编辑器据此初始化。 */
export interface WorkflowEntity extends Governed {
  workflowKey: string;
  displayName: string;
  description: string | null;
  spec: WorkflowSpec | null;
  publishedAtMs: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  createdBy: string | null;
  updatedBy: string | null;
}

/** 校验结果。problems 为空表示可以发布；非空时页面要逐条列出，不要只显示第一条。 */
export interface WorkflowValidation {
  ok: boolean;
  problems: string[];
}

/** 运行状态机。PENDING 与 SKIPPED 的区别见后端的说明：前者是"还没轮到就断了"。 */
export type WorkflowRunState = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/** 节点状态。 */
export type WorkflowNodeState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

/** 一次执行的 run 行。 */
export interface WorkflowRunRow {
  runId: string;
  workflowKey: string;
  /** 这次执行锁定的定义版本（发布版本号），不是草稿版本。 */
  revision: number | null;
  triggerType: string;
  triggerRef: string | null;
  /** 整次运行共用一个会话键（wf-<runId>）。 */
  sessionId: string | null;
  userId: string | null;
  state: WorkflowRunState;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  failureCode: string | null;
  failureMessage: string | null;
  policy: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  createdAtMs: number;
}

/** 一次执行里某个节点的行。 */
export interface WorkflowRunNodeRow {
  id: number | null;
  runId: string;
  nodeKey: string;
  nodeType: string;
  state: WorkflowNodeState;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  /** condition 节点选中的下游节点 key。 */
  branchTaken: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  /**
   * agent 节点的执行链路 id —— 它对应 md_agent_run 里的一条链路，
   * 页面上从节点直接跳到 /traces/<runId> 看那次调用的完整过程。
   */
  agentRunId: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
}

/** 一次执行的详情：run + 全部节点（后端合成一个响应体，页面对应两次请求没有意义）。 */
export interface WorkflowRunDetail {
  run: WorkflowRunRow;
  nodes: WorkflowRunNodeRow[];
}
