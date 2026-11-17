/*
 * 跨页跳转的唯一构造处。
 *
 * <h2>为什么要有这个文件</h2>
 * 控制面里的资源是互相引用的：一条 run 里带 agentId 与会话 ID，一个 agent 引用了
 * skill / prompt / mcp，一个渠道绑定了一个 agent，一个工作流节点又是一个 agent。
 * 用户看见这些标识时的动作几乎只有一个 ——「点进去看它是什么」。
 *
 * <h2>为什么不各页自己拼字符串</h2>
 * 在这之前，`router.push('/traces/' + runId)` 这类写法散在各个页面里，于是
 * 「哪一段是路径主体、哪些进查询串、哪些要 encodeURIComponent」变成了一份**分散的知识**：
 * 路由形状一改要满项目 grep，漏一处不会报错、只会在某个次要入口上静默跳错页。
 * 集中到这里之后，「某个资源归哪一页管、地址长什么样」是一张一眼能读完的表。
 *
 * <h2>为什么每个标识都 encodeURIComponent</h2>
 * agent 名、表名、slotId、workflow-key 的取值域由各自后端校验决定，它们今天可能都是
 * [A-Za-z0-9_-]，但「今天合法」不等于「永远合法」。encode 的成本是零，
 * 漏 encode 的成本是路径被多出来的斜杠切错段 —— 而那只会出现在某一个特定名字上，
 * 是最难复现的一类问题。
 * 查询串的值统一交给 URLSearchParams（它会自己编码），不要手拼 `?a=` + 值。
 *
 * <h2>为什么返回字符串而不是 LocationRaw</h2>
 * 这一层的调用方有两种：router.push() 与 <router-link :to>。两者都接受字符串，
 * 而字符串地址还有一个额外好处 —— 可以直接贴进浏览器、贴给别人、写进日志，
 * 所见即所得。用对象形式反而要在两处各写一遍字段名。
 */

/**
 * 拼查询串：空值（null / undefined / 空串）一律不写进地址。
 *
 * <p>为什么空串也要丢掉：`/sessions?agent=` 与 `/sessions` 在后端语义上相同，
 * 但它们是**两个不同的地址** —— 浏览器历史、书签、"返回上一级"都会把它们当成两页。
 * 页面上「清空筛选」与「没筛过」应当是同一个地址。
 */
function withQuery(
  path: string,
  query: Record<string, string | number | boolean | null | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** 从路由查询串里读一个字符串参数（不存在或不是字符串时给空串）。 */
export function queryString(query: Record<string, unknown>, key: string): string {
  const raw = query[key];
  return typeof raw === 'string' ? raw : '';
}

/* ────────────────────────────── 编排定义 ────────────────────────────── */

/** 对话页。agentId 省略时进裸 /chat（页面会自己选第一个 agent）。 */
export function chatLink(agentId?: string): string {
  return agentId ? `/chat/${encodeURIComponent(agentId)}` : '/chat';
}

/** 能力型（REACT）agent 详情。 */
export function agentLink(agentName: string): string {
  return `/agents/${encodeURIComponent(agentName)}`;
}

/** 编排型（HARNESS）agent 详情 —— 与 agentLink 是同一个组件、不同入口，见 router.ts。 */
export function harnessLink(agentName: string): string {
  return `/harness/${encodeURIComponent(agentName)}`;
}

/**
 * 按 agentType 选详情入口。
 *
 * <p>凡是「只拿到一个 agent 名、不知道它是什么类型」的地方（run 记录、渠道绑定、
 * 工作流节点、状态表归属）都走这里，而不是让调用方自己写 if ——
 * 判错的表现是"HARNESS agent 从渠道点进去落在能力域"，那个页面会把编排 tab 全藏起来，
 * 看起来像"这个 agent 的工作区配置丢了"。
 *
 * <p>type 为 null / undefined 时回落 /agents：能力型是多数，
 * 且落错时 /agents 详情仍会按真实类型渲染（它读的是接口里的 agentType，不是地址）。
 */
export function agentDetailLink(agentName: string, agentType?: string | null): string {
  return agentType === 'HARNESS' ? harnessLink(agentName) : agentLink(agentName);
}

/* ────────────────────────────── 运行状态 ────────────────────────────── */

/**
 * 执行链路列表。
 *
 * <p>agent 与 keyword 都是**服务端/列表页**的筛选条件（TracesPage 会在挂载时读它们），
 * 所以从别处「跳去看这个 agent 的链路」能直接落在筛好的列表上，而不是要人再填一遍。
 */
export function tracesLink(filter: { agentId?: string | null; keyword?: string | null } = {}): string {
  return withQuery('/traces', { agent: filter.agentId, keyword: filter.keyword });
}

/** 一条 run 的链路详情。 */
export function traceLink(runId: string): string {
  return `/traces/${encodeURIComponent(runId)}`;
}

/**
 * 会话记录列表。
 *
 * <p>会话的唯一键是 (userId, sessionId)，而后端列表接口只提供 keyword 子串匹配
 * （同时匹配两者）、没有独立的 userId 参数，所以「定位到某一条会话」用 keyword 传 sessionId，
 * 「看某个用户在这个 agent 上的会话」用 keyword 传 userId。这一点在调用方也注明了，
 * 免得下次有人以为传错了参数。
 */
export function sessionsLink(
  filter: {
    agentId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
    source?: string | null;
    hasState?: boolean | null;
  } = {},
): string {
  return withQuery('/sessions', {
    agent: filter.agentId,
    keyword: filter.sessionId ?? filter.userId,
    source: filter.source,
    hasState:
      filter.hasState === null || filter.hasState === undefined ? undefined : String(filter.hasState),
  });
}

/* ──────────────────────── 运行产物：工作区 / 状态存储 ──────────────────────── */

export function workspaceLink(agentName?: string | null): string {
  return agentName ? `/workspace/${encodeURIComponent(agentName)}` : '/workspace';
}

/** 状态存储列表（有哪些状态表）。 */
export function storageLink(): string {
  return '/storage';
}

/**
 * 状态存储 · 表详情（这张表里有哪些会话）。
 *
 * <p>keyword 用来把某一条会话直接筛出来：表详情的会话列表是服务端分页的，
 * 一条会话可能落在第二页 —— 不带关键字跳过去，人还得自己找。
 */
export function storageTableLink(tableName: string, keyword?: string | null): string {
  return withQuery(`/storage/${encodeURIComponent(tableName)}`, { keyword });
}

/** 状态存储 · 会话详情（模型下一次对话真正会读到的上下文）。 */
export function storageSessionLink(tableName: string, slotId: string): string {
  return `/storage/${encodeURIComponent(tableName)}/${encodeURIComponent(slotId)}`;
}

/**
 * 拼状态存储的 slotId。
 *
 * <p>库里 session_id 列的原值就是 `<userId>:<sessionId>`，删除、查看都用它。
 * 与其让四个页面各拼一次这个字符串，不如把格式收在这里 ——
 * 分隔符写错的表现是"跳过去查不到这条会话"，而不是报错。
 */
export function stateSlotId(userId: string | null, sessionId: string): string {
  return `${userId ?? ''}:${sessionId}`;
}

/* ────────────────────────────── 能力资源 ────────────────────────────── */

/*
 * 这几页都会读地址上的 keyword（挂载时当初始筛选，见各页 setup 第一行），
 * 所以「某个 agent 引用了哪个 skill / prompt / mcp」可以直接跳到筛好的清单上。
 */

export function toolsLink(keyword?: string | null): string {
  return withQuery('/tools', { keyword });
}

export function skillsLink(keyword?: string | null): string {
  return withQuery('/skills', { keyword });
}

export function promptsLink(keyword?: string | null): string {
  return withQuery('/prompts', { keyword });
}

export function mcpLink(keyword?: string | null): string {
  return withQuery('/mcp', { keyword });
}

export function middlewareLink(keyword?: string | null): string {
  return withQuery('/middleware', { keyword });
}

/* ────────────────────────────── 接入 / 业务 ────────────────────────────── */

