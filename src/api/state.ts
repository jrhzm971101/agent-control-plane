/*
 * 状态存储（会话上下文）管理接口 —— 与后端 controller/state/StateStoreController 一一对应。
 *
 * 与 api/*.ts 那批老模块的两点差别（和 api/controlplane 一致）：
 *
 * 1. 不做 mock 分叉。这一页回答的是「库里的会话状态现在长什么样」，
 *    用假数据展示等于把这一页的唯一价值抽掉 —— 它会显示得很正常，但和库毫无关系。
 * 2. 这一页只有删除，没有写。state_data 是框架内部对象的序列化结果，
 *    让页面写回去的风险见后端 AgentStateAdminService 的类注释。
 */
import { apiJson, apiResponse, buildUrl } from '@/lib/apiClient';

/** 一张状态表（= 一个 agent）的概览。 */
export interface StateTableRow {
  tableName: string;
  /** 声明使用它的 agent；null = 孤儿表（改过名或删过 agent 的残留）。 */
  agentName: string | null;
  /** false = agent 配了状态存储但一次都没跑过，表还没被框架建出来。 */
  exists: boolean;
  sessions: number;
  rows: number;
  bytes: number;
  lastWriteAt: string | null;
}

/** 一个会话（或其中一个槽位）的元信息。 */
export interface StateSlotRow {
  /** 库里的 session_id 列原值，形如 <userId>:<sessionId>。删除时用的就是它。 */
  slotId: string;
  userId: string | null;
  sessionId: string | null;
  stateKey: string | null;
  itemIndex: number | null;
  bytes: number;
  rows: number | null;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface StateSessionPage {
  /** 过滤后命中数。 */
  total: number;
  /** 该表全部会话数（不带关键字过滤）。 */
  tableTotal: number;
  items: StateSlotRow[];
}

export interface StateTaskView {
  id: string | null;
  subject: string | null;
  state: string | null;
  owner: string | null;
}

export interface StateMessagePreview {
  role: string;
  /** text | thinking | tool_use | tool_result | mixed | unknown */
  kind: string;
  text: string;
  timestamp: string;
}

/** 从 agent_state 的 JSON 里抽出来的可读摘要。 */
export interface StateSnapshot {
  bytes: number;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  summary: string;
  messages: number;
  curIter: number;
  shutdownInterrupted: boolean;
  tasksTotal: number;
  tasks: StateTaskView[];
  planActive: boolean;
  planFile: string | null;
  activatedToolGroups: string[];
  permissionMode: string;
  preview: StateMessagePreview[];
}

export interface StateSessionDetail {
  slotId: string;
  userId: string | null;
  sessionId: string | null;
  totalBytes: number;
  slots: StateSlotRow[];
  snapshot: StateSnapshot | null;
  /** 摘要区为空的原因。有值时页面要显出来，否则用户只看到一个空白区块。 */
  parseError: string | null;
}

export async function fetchStateDatabase(): Promise<{ database: string }> {
  return apiJson<{ database: string }>(buildUrl('/api/state/database'));
}

export async function fetchStateTables(): Promise<StateTableRow[]> {
  return apiJson<StateTableRow[]>(buildUrl('/api/state/tables'));
}

export async function fetchStateSessions(params: {
  table: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}): Promise<StateSessionPage> {
  return apiJson<StateSessionPage>(
    buildUrl('/api/state/sessions', {
      table: params.table,
      keyword: params.keyword,
      limit: params.limit,
      offset: params.offset,
    }),
  );
}

export async function fetchStateSessionDetail(
  table: string,
  slotId: string,
): Promise<StateSessionDetail> {
  return apiJson<StateSessionDetail>(
    buildUrl('/api/state/sessions/detail', { table, slotId }),
  );
}

/**
 * 原始 state_data。
 *
 * 走 apiResponse 而不是 apiJson：后端用 text/plain 返回"库里存着的那段文本"，
 * 我们也不能把它当对象解析 —— 它的价值恰恰在于未经加工。
 * 后端对超过 4 MB 的会话回 413，异常会原样抛出（页面显示后端给的原因）。
 */
export async function fetchStateRaw(table: string, slotId: string): Promise<string> {
  const response = await apiResponse(buildUrl('/api/state/sessions/raw', { table, slotId }));
  return response.text();
}

/**
 * 会话里的一条消息（完整版）。
 *
 * <p>与 {@link StateSnapshot}.preview 的区别，也是这一整份接口存在的理由：
 * preview 是给「详情摘要」用的（最后 20 条、每条截到 400 字、正文与思考拼成一行），
 * 适合"扫一眼这个会话处在什么状态"；这里返回的是**原文**，三段分开、不截到 400 字，
 * 因为对话页要把正文按 Markdown 渲染、把思考折进折叠区、把工具调用单独挂一行 ——
 * 拼在一起再拆开是不可能的。
 *
 * <p>工具结果（{@code tool_result}）这里刻意不返回：它是"过程"不是"对话"，
 * 几千字的表格查询结果铺满整页只会让人找不到对话本身。
 */
export interface StateMessage {
  /** USER / ASSISTANT / TOOL / SYSTEM（框架原值，页面自己决定认哪几种）。 */
  role: string;
  /** 正文块拼起来的文本；没有正文块时是空串。 */
  text: string;
  /** 思考块拼起来的文本；没有思考块时是空串。 */
  thinking: string;
  /** 这条消息里出现过的工具名，按出现顺序；没有时是空数组。 */
  tools: string[];
  /** 消息时间戳原样。 */
  timestamp: string;
}

/**
 * 一个会话的完整消息清单（从最新往前取 {@code limit} 条）。
 *
 * <p>后端的默认上限是 500 条、单条消息单个字段截 2 万字，所以这里不传 limit
 * 也能拿到足够回放的一份 —— 传参只在"只要最近几条"的场景下才有意义。
 */
export async function fetchStateMessages(
  table: string,
  slotId: string,
  limit?: number,
): Promise<StateMessage[]> {
  return apiJson<StateMessage[]>(
    buildUrl('/api/state/sessions/messages', { table, slotId, limit }),
  );
}

/**
 * 删除一个会话的状态。
 *
 * 只删状态，不碰调用链路（md_agent_run / md_agent_run_event）——
 * 链路的用途正是"上下文没了之后还能回看当时发生了什么"。
 */
export async function deleteStateSession(
  table: string,
  slotId: string,
): Promise<{ deleted: number; table: string; slotId: string }> {
  return apiJson<{ deleted: number; table: string; slotId: string }>(
    buildUrl('/api/state/sessions', { table, slotId }),
    { method: 'DELETE' },
  );
}
