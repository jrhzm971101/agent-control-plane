/*
 * 轨迹事件的 mock 事件源。
 *
 * 它模拟的是「一个已落库、带单调 seq 的事件日志 + 一条 SSE 直播」，
 * 而不是直接给出成品树 —— 这样前端的游标、去重、乱序缓冲逻辑都会被真实地跑一遍。
 *
 * 注意 live 段里 seq 22 故意先于 seq 21 到达：用来演示
 * mergeContiguousEvents 的「保留待处理、只释放连续前缀」，这是官方实现里
 * 最容易被忽略、也最容易出隐蔽 bug 的一处。
 */
import { mockAgentKind, mockTraceRuns } from './mockDataset';
import type { TraceEvent, TraceRunInfo } from './model';

const RUN_ID = 'r_8f3c21a9';
const BASE = Date.parse('2026-09-20T09:14:02+08:00');
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

interface Scripted {
  event: Omit<TraceEvent, 'id' | 'runId' | 'occurredAt'>;
  /** 相对 run 开始的偏移，用于生成 occurredAt。 */
  offsetMs: number;
}

const TASK_INPUT = {
  agent_id: 'general-purpose-subagent',
  timeout_seconds: 300,
  task:
    '核对以下人员的当月工时填报情况：\n名单：张伟(1001), 李娜(1002), 王强(1003) …\n工作日：2026-09-01 ~ 2026-09-18 共 13 天\n规则：工作日未填写 → 标记缺失\n返回：每人一条 {工号, 姓名, 已填天数, 缺失日期[], 结论}',
};

const TASK_OUTPUT = {
  status: 'ok',
  result: [
    { 工号: '1001', 姓名: '张伟', 已填: 11, 缺失: ['2026-09-14', '2026-09-17'], 结论: '缺填' },
    { 工号: '1002', 姓名: '李娜', 已填: 13, 缺失: [], 结论: '正常' },
  ],
  checked: 34,
};

const script: Scripted[] = [
  { offsetMs: 0, event: { seq: 1, type: 'run.started', path: '1', parentPath: null, kind: 'agent', label: 'workwx_batch_agent', source: null, status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 300, event: { seq: 2, type: 'reasoning.started', path: '1.1', parentPath: '1', kind: 'reasoning', label: 'reasoning #1', source: 'deepseek-v4-flash', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 7_500, event: { seq: 3, type: 'reasoning.completed', path: '1.1', parentPath: '1', kind: 'reasoning', label: 'reasoning #1', source: 'deepseek-v4-flash', status: 'ok', durationMs: 7_200, tokens: 61_000 } },
  { offsetMs: 7_600, event: { seq: 4, type: 'acting.started', path: '1.2', parentPath: '1', kind: 'acting', label: 'acting · agent_spawn', source: 'wo7U1…/workwx_doc_agent', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 13_800, event: { seq: 5, type: 'acting.completed', path: '1.2', parentPath: '1', kind: 'acting', label: 'acting · agent_spawn', source: 'wo7U1…/workwx_doc_agent', status: 'ok', durationMs: 6_200, tokens: 31_000 } },
  { offsetMs: 7_900, event: { seq: 6, type: 'reasoning.started', path: '1.2.1', parentPath: '1.2', kind: 'reasoning', label: 'reasoning', source: 'skill: read-roster', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 10_000, event: { seq: 7, type: 'reasoning.completed', path: '1.2.1', parentPath: '1.2', kind: 'reasoning', label: 'reasoning', source: 'skill: read-roster', status: 'ok', durationMs: 2_100, tokens: 9_000 } },
  { offsetMs: 10_100, event: { seq: 8, type: 'tool.started', path: '1.2.2', parentPath: '1.2', kind: 'tool', label: 'tool · smartsheet_records_list', source: 'workwx-doc-mcp', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 13_500, event: { seq: 9, type: 'tool.completed', path: '1.2.2', parentPath: '1.2', kind: 'tool', label: 'tool · smartsheet_records_list', source: 'workwx-doc-mcp', status: 'ok', durationMs: 3_400, tokens: null } },
  { offsetMs: 13_900, event: { seq: 10, type: 'acting.started', path: '1.3', parentPath: '1', kind: 'acting', label: 'acting · agent_spawn', source: 'wo7U1…/workwx_doc_agent', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 23_300, event: { seq: 11, type: 'acting.completed', path: '1.3', parentPath: '1', kind: 'acting', label: 'acting · agent_spawn', source: 'wo7U1…/workwx_doc_agent', status: 'ok', durationMs: 9_400, tokens: 52_000 } },
  { offsetMs: 14_100, event: { seq: 12, type: 'reasoning.started', path: '1.3.1', parentPath: '1.3', kind: 'reasoning', label: 'reasoning', source: 'skill: read-timesheet', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 17_300, event: { seq: 13, type: 'reasoning.completed', path: '1.3.1', parentPath: '1.3', kind: 'reasoning', label: 'reasoning', source: 'skill: read-timesheet', status: 'ok', durationMs: 3_200, tokens: 14_000 } },
  { offsetMs: 17_400, event: { seq: 14, type: 'tool.started', path: '1.3.2', parentPath: '1.3', kind: 'tool', label: 'tool · smartsheet_records_list ×4', source: '分页', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 23_000, event: { seq: 15, type: 'tool.completed', path: '1.3.2', parentPath: '1.3', kind: 'tool', label: 'tool · smartsheet_records_list ×4', source: '分页', status: 'ok', durationMs: 5_600, tokens: null } },
  { offsetMs: 23_400, event: { seq: 16, type: 'acting.started', path: '1.4', parentPath: '1', kind: 'acting', label: 'acting · 批量派发 ×3', source: 'general-purpose', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 23_600, event: { seq: 17, type: 'subagent.dispatched', path: '1.4.1', parentPath: '1.4', kind: 'subagent', label: 'sub #1 · 核对 34 人', source: 'sub-b46441fb', status: 'run', durationMs: null, tokens: null } },
  {
    offsetMs: 25_700,
    event: {
      seq: 18,
      type: 'subagent.completed',
      path: '1.4.1',
      parentPath: '1.4',
      kind: 'subagent',
      label: 'sub #1 · 核对 34 人',
      source: 'sub-b46441fb',
      status: 'ok',
      durationMs: 2_100,
      tokens: 11_204,
      payload: {
        input: TASK_INPUT,
        output: TASK_OUTPUT,
        metrics: { inputTokens: 9_812, outputTokens: 1_392, checked: 34 },
      },
    },
  },
  { offsetMs: 25_800, event: { seq: 19, type: 'subagent.dispatched', path: '1.4.2', parentPath: '1.4', kind: 'subagent', label: 'sub #2 · 核对 33 人', source: 'sub-e591566d', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 27_600, event: { seq: 20, type: 'subagent.completed', path: '1.4.2', parentPath: '1.4', kind: 'subagent', label: 'sub #2 · 核对 33 人', source: 'sub-e591566d', status: 'ok', durationMs: 1_800, tokens: 10_000 } },
  { offsetMs: 27_700, event: { seq: 21, type: 'subagent.dispatched', path: '1.4.3', parentPath: '1.4', kind: 'subagent', label: 'sub #3 · 核对 33 人', source: 'sub-8c1d0a77', status: 'run', durationMs: null, tokens: null } },
  { offsetMs: 29_800, event: { seq: 22, type: 'acting.started', path: '1.5', parentPath: '1', kind: 'acting', label: 'acting · agent_spawn', source: 'wo7U1…/workwx_notify_agent', status: 'wait', durationMs: null, tokens: null } },
  { offsetMs: 29_900, event: { seq: 23, type: 'tool.started', path: '1.5.1', parentPath: '1.5', kind: 'tool', label: 'tool · workwx_webhook_send', source: '待执行', status: 'wait', durationMs: null, tokens: null } },
];

/** 已落库的部分：其中 seq 20 也在历史里，live 段从 21 之后开始。 */
const HISTORY_THROUGH_SEQ = 20;

export const mockTraceEvents: TraceEvent[] = script.map(({ event, offsetMs }) => ({
  ...event,
  id: `${RUN_ID}-${event.seq}`,
  runId: RUN_ID,
  occurredAt: at(offsetMs),
}));

export const mockTraceHistory: TraceEvent[] = mockTraceEvents.filter(
  (event) => event.seq <= HISTORY_THROUGH_SEQ,
);

/** live 段：seq 22 排在 21 之前，故意制造一个缺口。 */
export const mockTraceLive: Array<{ delayMs: number; event: TraceEvent }> = [
  { delayMs: 1_500, event: mockTraceEvents.find((event) => event.seq === 22)! },
  { delayMs: 2_500, event: mockTraceEvents.find((event) => event.seq === 21)! },
  { delayMs: 4_000, event: mockTraceEvents.find((event) => event.seq === 23)! },
];

export const mockRunFallback = {
  runId: RUN_ID,
  agentId: 'workwx_batch_agent',
  kind: 'harness' as const,
  sessionId: 'single-wo7U1…-2026-09-20',
  user: 'wo7U1ZEQAA…',
  source: 'Channels · 企微 bot',
  durationMs: 24_800,
  tokens: 412_000,
  cacheHitRate: '61%',
  // 示例 run 由企微通道直接发起，没有父链路
  parentRunId: null,
  taskId: null,
};

/* --------------------------------------------------------------- run 元信息 */

interface RunMetaSeed {
  agentId: string;
  agentKind: 'react' | 'harness';
  sessionId: string;
  user: string;
  source: string;
  durationMs: number;
  tokens: number;
  /** 派发它的父 run；只有异步子 agent 才有（见 model.ts 的 TraceRunInfo.parentRunId）。 */
  parentRunId?: string | null;
  /** 框架后台任务号。 */
  taskId?: string | null;
}

const runMetaSeeds: Record<string, RunMetaSeed> = {
  [RUN_ID]: {
    agentId: 'workwx_batch_agent',
    agentKind: 'harness',
    sessionId: 'single-wo7U1…-2026-09-20',
    user: 'wo7U1ZEQAA…',
    source: 'Channels · 企微 bot',
    durationMs: 24_800,
    tokens: 412_000,
  },
  r_8f3c1f04: {
    agentId: 'deployment_agent',
    agentKind: 'harness',
    sessionId: 'single-ou_87a…-2026-09-20',
    user: 'ou_87a0c4d1…',
    source: 'Channels · 企微 bot',
    durationMs: 48_200,
    tokens: 318_000,
  },
  r_8f3c1a77: {
    agentId: 'workwx_doc_agent',
    agentKind: 'react',
    sessionId: 'sub-81d3…a6e5',
    user: '派发方 workwx_batch_agent',
    source: '父会话派发',
    durationMs: 6_200,
    tokens: 31_000,
    // 这一条用来演示"后台派发"：子 agent 在父 run 收口之后才跑，于是自己开了一条 run
    parentRunId: RUN_ID,
    taskId: 'task_7f3a',
  },
  r_8f3c0d31: {
    agentId: 'diagnosis_agent',
    agentKind: 'harness',
    sessionId: 'group_cmr-prod',
    user: '群聊 cmr-prod',
    source: 'Channels · 群聊',
    durationMs: 22_900,
    tokens: 96_000,
  },
  r_8f3c0912: {
    agentId: 'workwx_notify_agent',
    agentKind: 'react',
    sessionId: 'single_gw-f991…',
    user: '派发方 workwx_batch_agent',
    source: '父会话派发',
    durationMs: 3_300,
    tokens: 8_000,
    parentRunId: RUN_ID,
    taskId: 'task_5e21',
  },
  r_8f3c0011: {
    agentId: 'nacos_agent',
    agentKind: 'react',
    sessionId: 'single_admin_local_2026-09-17',
    user: 'admin',
    source: '控制台调试',
    durationMs: 11_700,
    tokens: 74_000,
  },
};

/**
 * 会话 ID → 用户与来源。
 *
 * 手写样例（runMetaSeeds）不走这里：那几条的 user / source 是逐条想过的。
 * 这里只服务从 run 清单里派生出来的那几十条 —— 少了它，详情页顶栏会把
 * 示例 run 的「wo7U1ZEQAA…」印在 k8s_agent 的会话上。
 */
function deriveRunContext(sessionId: string): { user: string; source: string } {
  if (/^sub[-_]/.test(sessionId)) return { user: '派发方 Agent', source: '父会话派发' };
  if (/^(group|cmr)/.test(sessionId)) return { user: '群聊成员', source: 'Channels · 群聊' };
  if (/^job-/.test(sessionId)) return { user: '定时任务', source: 'XXL-Job 调度' };
  if (/admin[-_] ?local/.test(sessionId)) return { user: 'admin', source: '控制台调试' };
  return { user: '企微用户', source: 'Channels · 企微 bot' };
}

/**
 * 页面顶部的 run 概览。三档回落，保证深链不会白屏：
 * 1. 手写样例（runMetaSeeds）优先 —— 它有最完整的 user / source；
 * 2. 否则按 run 清单里的真实归属拼出来，Agent 名与列表页点到的那一行一致；
 * 3. 都不认得才回落到示例 run。
 */
export function mockRunInfo(runId: string): TraceRunInfo {
  const seed = runMetaSeeds[runId];
  // 默认无父链路 / 无后台任务号：只有手写样例里显式配了的几条才有（见 RunMetaSeed 的注释）
  if (seed) return { runId, parentRunId: null, taskId: null, ...seed, cacheHitRate: '61%' };

  const run = mockTraceRuns.find((item) => item.runId === runId);
  if (run) {
    return {
      runId,
      agentId: run.agentId,
      agentKind: mockAgentKind(run.agentId),
      sessionId: run.sessionId,
      ...deriveRunContext(run.sessionId),
      durationMs: run.durationMs ?? 0,
      tokens: run.tokens ?? 0,
      cacheHitRate: '61%',
      // 从清单派生出来的这些 run 不编父子关系：编一个指向不明 runId 的链接，点过去就是 404
      parentRunId: null,
      taskId: null,
    };
  }

  return { runId, parentRunId: null, taskId: null, ...runMetaSeeds[RUN_ID], cacheHitRate: '61%' };
}
