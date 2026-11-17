/*
 * 轨迹的运行时事件模型与投影模型。
 *
 * 这一层刻意区分两种东西（对齐官方 features/conversation/model.ts 的纲领）：
 * - TraceEvent：运行时的原始事件，落库、有单调 seq，是唯一事实来源；
 * - TraceNode / TraceNodeDetail：给页面看的投影，可重新生成，不反向写回事件。
 * 原始 payload 永久保留，但渲染层永不「解释」它 —— 解释只发生在 adapters.ts。
 */
import type { Tone } from '@/api/types';

export type TraceNodeKind = 'agent' | 'reasoning' | 'acting' | 'tool' | 'subagent' | 'error';

export type TraceEventType =
  | 'run.started'
  | 'run.completed'
  | 'reasoning.started'
  | 'reasoning.completed'
  | 'acting.started'
  | 'acting.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'subagent.dispatched'
  | 'subagent.completed'
  | 'error.raised';

export interface TraceEventPayload {
  /** 送进模型 / 工具 / 子 Agent 的入参。 */
  input?: unknown;
  /** 拿回来的结果。 */
  output?: unknown;
  /** 人类可读的补充说明，例如失败原因。 */
  note?: string;
  /** 明细指标，例如 token 分项。 */
  metrics?: Record<string, number | string>;
}

export interface TraceEvent {
  id: string;
  /** 单调递增序号 —— 断点续传的唯一依据。 */
  seq: number;
  runId: string;
  type: TraceEventType;
  occurredAt: string;
  /** 调用树里的路径，例如 1.4.1；根节点是 1。 */
  path: string;
  parentPath: string | null;
  kind: TraceNodeKind;
  label: string;
  /** 模型名 / skill 名 / 子会话 id；null 表示没有来源。 */
  source: string | null;
  status: Tone;
  durationMs: number | null;
  tokens: number | null;
  payload?: TraceEventPayload;
}

export interface TraceNode {
  path: string;
  depth: number;
  kind: TraceNodeKind;
  label: string;
  source: string | null;
  status: Tone;
  durationMs: number | null;
  tokens: number | null;
  startedAt: string;
  /** 仍在进行中：只有 started 没有 completed。 */
  open: boolean;
  children: TraceNode[];
  eventIds: string[];
}

export interface TraceNodeSection {
  title: string;
  json: string;
}

export interface TraceNodeDetail {
  node: TraceNode;
  fields: Array<{ label: string; value: string; mono?: boolean; badge?: { text: string; tone: Tone } }>;
  sections: TraceNodeSection[];
}

export interface TraceRunMeta {
  runId: string;
  agentId: string;
  agentKind: 'react' | 'harness';
  sessionId: string;
  user: string;
  /** 来源的展示文本：已经在 projectRunMeta 里兜过底，页面直接用，不必再判空。 */
  source: string;
  status: string;
  tone: Tone;
  durationMs: number | null;
  iterations: number;
  tokens: number | null;
  cacheHitRate: string;
  /**
   * 派发出这条 run 的父 run；null = 用户 / 通道 / 工作流直接发起的。
   *
   * 只有「异步子 agent」会有值：子 agent 在父 run 收口之后才开跑，中间件只能新开一条 run，
   * 此时把派发它的父 runId 记下来。页面上据此给出「回到父链路」的入口 ——
   * 否则这条链路在列表里就是孤零零的一条，看不出来是被谁派发的。
   */
  parentRunId: string | null;
  /**
   * 框架后台任务号（task_<uuid>）；null = 不是后台任务跑起来的。
   *
   * 与父侧派发节点事件载荷里的 task_id 是同一个号，两边可以互相对上：
   * 在父链路里看到一个 wait 状态的派发节点，拿这个号就能找到它对应的那条 run。
   */
  taskId: string | null;
}

/** run 级元信息（GET /api/traces/{runId} 的返回）。 */
export interface TraceRunInfo {
  runId: string;
  agentId: string;
  agentKind: 'react' | 'harness';
  sessionId: string;
  user: string;
  /**
   * 触发来源：console / wecom / feishu / schedule。
   *
   * 允许 null：来源由四个入口在建 run 时各自写下（后端 AgentTraceRun.SOURCE_*），
   * 而接线之前产生的历史 run 没有标注。页面显示成空，不编值 ——
   * 消费方（TraceDetailPage）用 `?? '—'` 兜底，这里的 null 是**预期内**的取值。
   */
  source: string | null;
  durationMs: number;
  tokens: number;
  cacheHitRate: string;
  /** 派发它的父 run（见 TraceRunInfo.parentRunId）；空表示这条链路是入口直接发起的。 */
  parentRunId: string | null;
  /** 后台任务号（见 TraceRunInfo.taskId）。 */
  taskId: string | null;
}
/** SSE 一帧的载荷，和历史接口返回的结构一致。 */
export interface TraceEventPage {
  events: TraceEvent[];
  /** 服务端声明是否还有更早的事件。 */
  hasEarlier: boolean;
}

/** 节点类型 → 展示标签，页面不要自己写 if/else。 */
export const traceKindLabel: Record<TraceNodeKind, string> = {
  agent: 'Agent 阶段',
  reasoning: '模型调用',
  acting: '动作阶段',
  tool: '工具调用',
  subagent: '子 Agent 调用',
  error: '异常',
};
