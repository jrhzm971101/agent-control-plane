/*
 * 会话记录接口 —— 与后端 controller/session/SessionController 一一对应。
 *
 * 与 api/*.ts 那批老模块的两点差别（和 api/state、api/controlplane 一致）：
 *
 * 1. **不做 mock 分叉**。这一页回答的是「真实跑过的会话长什么样」。
 *    早先它读的是文件系统约定拼出来的假数据（"状态存储目前是本地文件""快照路径"），
 *    那些话在状态搬进 MySQL 之后已经全部不成立 —— 一份写死在页面里的描述，
 *    最有欺骗性的地方在于它看起来永远是对的。
 * 2. **会话不是一张表**，所以这里没有写接口。它是 md_agent_run 按
 *    (user_id, session_id) 的聚合结果；要清记忆去状态存储页，要清链路去执行链路页。
 *
 * ── 两个必须记住的口径 ───────────────────────────────────────────────
 * · **agent 是筛选维度，不是归属维度**：同一个 sessionId 会被多个 agent 服务过
 *   （实测：企微里同一条会话先交给 workwx_batch_agent 又交给 deployment_agent，
 *   sessionId 没变，因为 sessionId 由入口方算、里面不含 agent）。
 *   所以 agents 是**数组**，而 agentId 筛选的含义是"被这个 agent 服务过的会话"。
 * · **时间统一是 epoch millis**（不是 ISO 串）：前端要拿它做相对时间与时间窗比较，
 *   给字符串反而要再解析一次。唯一的例外是 states[].updatedAt —— 它来自状态表的
 *   DATETIME 列，后端出口处已归一成 ISO。
 */
import { apiJson, buildUrl } from '@/lib/apiClient';
import type { Tone } from './types';

/** 会话列表里的一行。 */
export interface SessionRow {
  /** 发起人；库里有 user_id 为 NULL 的会话，所以允许 null。 */
  userId: string | null;
  sessionId: string;
  /** 一共跑了多少次（= run 行数）。 */
  runs: number;
  /** 其中失败的次数。 */
  failed: number;
  /** token 合计（输入 + 输出）。 */
  tokens: number;
  /** 服务过这个会话的 agent，去重并按名排序。**可能不止一个**。 */
  agents: string[];
  /** 出现过的来源（console / wecom / feishu / schedule）；一次都没标注过时为空数组。 */
  sources: string[];
  /** 最早一次执行（epoch millis）。 */
  firstMs: number;
  /** 最近一次执行（epoch millis）。 */
  lastMs: number;
  /** 状态库里还有没有这个会话的记忆。 */
  hasState: boolean;
  /** 有记忆时落在哪几张状态表里。 */
  stateTables: string[];
}

export interface SessionPage {
  /** 过滤后命中的会话数。 */
  total: number;
  /** 库里全部会话数（不带筛选），页面用它显示「筛选出 X / 共 Y」。 */
  allTotal: number;
  items: SessionRow[];
}

/** 会话详情里的一次执行（= 一棵调用树的根）。 */
export interface SessionRunRow {
  runId: string;
  agentId: string;
  agentKind: 'react' | 'harness';
  source: string | null;
  /** 前端闭集：running | success | failed。 */
  status: string;
  tone: Tone;
  /** 耗时；进行中的 run 是「至今耗时」，不是 0。 */
  durationMs: number;
  tokens: number;
  startedAtMs: number;
  error: string | null;
}

/** 这个会话的记忆落在哪张状态表里。 */
export interface SessionStateTable {
  tableName: string;
  /** 声明使用这张表的 agent；null = 孤儿表。 */
  agentName: string | null;
  rows: number;
  bytes: number;
  /** ISO-8601（后端已把 DATETIME 的空格分隔形态归一）。 */
  updatedAt: string | null;
}

export interface SessionDetail {
  userId: string | null;
  sessionId: string;
  /** 执行时间线，新的在前。上限 200 次。 */
  runs: SessionRunRow[];
  states: SessionStateTable[];
}

/**
 * 列表的查询条件。
 *
 * <p>页面把它**同一个对象**同时喂给 queryKey 与 queryFn（见 queryKeys.sessions）——
 * 拆成两份的写法迟早会出现"键变了但请求没变"，而那种 bug 的表现是
 * "点了筛选，结果没动"，没人会先怀疑缓存。
 */
export interface SessionQuery {
  agentId?: string;
  source?: string;
  /** 时间窗下界（epoch millis），比的是「最近一次活动」。 */
  from?: number | null;
  /** 时间窗上界（epoch millis）。 */
  to?: number | null;
  /** 同时匹配 userId 与 sessionId 的子串。 */
  keyword?: string;
  /**
   * 有没有记忆：true = 只看还有记忆的，false = 只看已经没有记忆的，null = 不限。
   *
   * <p>写成 {@code boolean | null} 而不是"空串表示不限"：这里是三态，不是一个可空字符串 ——
   * 用空串的话 {@code false} 会被 buildUrl 当成"有值"发出去（它只丢 undefined / null / ''），
   * 而"没有记忆"正好是那个会被误判成"没传"的取值。三态就用三态的类型表达。
   */
  hasState?: boolean | null;
  limit?: number;
  offset?: number;
}

export async function fetchSessions(query: SessionQuery = {}): Promise<SessionPage> {
  return apiJson<SessionPage>(buildUrl('/api/sessions', { ...query }));
}

/**
 * 一条会话的执行时间线 + 记忆清单。
 *
 * <p>{@code userId} 允许为 null：库里确实有 user_id 为 NULL 的会话（老数据、非渠道入口）。
 * {@code buildUrl} 会把 null 直接丢掉（不写进 query），后端因此收到"没给 userId"，
 * 走的正是 NULL 安全等值 —— 传空串反而会变成 {@code user_id <=> ''} 而查不到。
 */
export async function fetchSessionDetail(
  userId: string | null,
  sessionId: string,
): Promise<SessionDetail> {
  return apiJson<SessionDetail>(buildUrl('/api/sessions/detail', { userId, sessionId }));
}
