/*
 * 事件 → 调用树投影。
 *
 * 纯函数：输入事件数组，输出页面用的树与节点详情。没有副作用、不碰状态，
 * 所以可以直接在测试里断言，也可以在 worker 里复用。
 * 「原始事件是唯一事实来源，树只是它的可读投影」—— 刷新页面时重算即可。
 */
import { presentEvent } from './eventPresentation';
import type {
  TraceEvent,
  TraceNode,
  TraceNodeDetail,
  TraceNodeSection,
  TraceRunMeta,
} from './model';

function depthOf(path: string): number {
  return path.split('.').length - 1;
}

function pretty(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 按路径建树。事件的到达顺序不影响结果 —— 只有 seq 影响持续时间与「进行中」的判定。
 */
export function projectTrace(events: TraceEvent[]): TraceNode[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const nodes = new Map<string, TraceNode>();

  for (const event of ordered) {
    const standalone = presentEvent(event.type).standalone;
    const existing = nodes.get(event.path);

    if (!existing) {
      if (!standalone) continue; // 只有完成事件而没有起点，说明历史没取全，先不建节点
      nodes.set(event.path, {
        path: event.path,
        depth: depthOf(event.path),
        kind: event.kind,
        label: event.label,
        source: event.source,
        status: event.status,
        durationMs: event.durationMs,
        tokens: event.tokens,
        startedAt: event.occurredAt,
        open: event.status === 'run' || event.status === 'wait',
        children: [],
        eventIds: [event.id],
      });
      continue;
    }

    existing.eventIds.push(event.id);
    if (event.durationMs !== null) existing.durationMs = event.durationMs;
    if (event.tokens !== null) existing.tokens = event.tokens;
    if (event.source) existing.source = event.source;
    existing.status = event.status;
    existing.open = event.status === 'run' || event.status === 'wait';
  }

  const roots: TraceNode[] = [];
  for (const node of nodes.values()) {
    if (node.depth === 0) {
      roots.push(node);
      continue;
    }
    const parentPath = node.path.slice(0, node.path.lastIndexOf('.'));
    const parent = nodes.get(parentPath);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRecursive = (list: TraceNode[]) => {
    list.sort((a, b) => {
      const aSeg = a.path.split('.').map(Number);
      const bSeg = b.path.split('.').map(Number);
      for (let i = 0; i < Math.max(aSeg.length, bSeg.length); i += 1) {
        const diff = (aSeg[i] ?? -1) - (bSeg[i] ?? -1);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    for (const item of list) sortRecursive(item.children);
  };
  sortRecursive(roots);

  return roots;
}

export function findTraceNode(nodes: TraceNode[], path: string): TraceNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const hit = findTraceNode(node.children, path);
    if (hit) return hit;
  }
  return null;
}

export function flattenTrace(nodes: TraceNode[]): TraceNode[] {
  return nodes.flatMap((node) => [node, ...flattenTrace(node.children)]);
}

export function countTraceNodes(nodes: TraceNode[]): number {
  return flattenTrace(nodes).length;
}

/** 根节点耗时，用作耗时条的分母。 */
export function traceSpanMs(nodes: TraceNode[]): number {
  const all = flattenTrace(nodes);
  return Math.max(1, ...all.map((node) => node.durationMs ?? 0));
}

function eventsOf(node: TraceNode, events: TraceEvent[]): TraceEvent[] {
  return events.filter((event) => event.path === node.path).sort((a, b) => a.seq - b.seq);
}

export function describeTraceNode(
  node: TraceNode,
  events: TraceEvent[],
  spanMs: number,
): TraceNodeDetail {
  const ordered = eventsOf(node, events);
  const latest = ordered[ordered.length - 1];
  const payload = latest?.payload ?? {};

  const sections: TraceNodeSection[] = [];
  if (payload.input !== undefined) {
    sections.push({ title: '输入 · input', json: pretty(payload.input) });
  }
  if (payload.output !== undefined) {
    sections.push({ title: '输出 · output', json: pretty(payload.output) });
  }
  if (payload.note) {
    sections.push({ title: '说明', json: payload.note });
  }

  const metrics = payload.metrics ?? {};
  const inputTokens = metrics.inputTokens;
  const outputTokens = metrics.outputTokens;
  const tokenText =
    node.tokens === null
      ? '—'
      : inputTokens !== undefined && outputTokens !== undefined
        ? `${node.tokens.toLocaleString('en-US')}（in ${Number(inputTokens).toLocaleString('en-US')} / out ${Number(outputTokens).toLocaleString('en-US')}）`
        : node.tokens.toLocaleString('en-US');

  const durationText =
    node.durationMs === null
      ? '—'
      : `${(node.durationMs / 1000).toFixed(1)}s · 耗时占比 ${((node.durationMs / spanMs) * 100).toFixed(1)}%`;

  const fields: TraceNodeDetail['fields'] = [
    { label: '类型', value: describeKind(node) },
    // 没来源就打「—」，别把 JS 的 null 直接印到界面上（耗时 / Token 也是这么处理的）。
    { label: 'source', value: node.source ?? '—', mono: true },
    { label: '耗时', value: durationText },
    { label: 'Token', value: tokenText },
    {
      label: '状态',
      value: '',
      badge: { text: statusText(node), tone: node.status },
    },
  ];

  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'inputTokens' || key === 'outputTokens') continue;
    fields.push({ label: key, value: String(value) });
  }

  return { node, fields, sections };
}

function describeKind(node: TraceNode): string {
  switch (node.kind) {
    case 'agent':
      return 'Agent 阶段（run 根节点）';
    case 'reasoning':
      return '模型调用（reasoning）';
    case 'acting':
      return '动作阶段（acting）';
    case 'tool':
      return '工具调用（tool）';
    case 'subagent':
      return '子 Agent 调用（agent_spawn）';
    case 'error':
      return '异常（error）';
    default:
      return node.kind;
  }
}

function statusText(node: TraceNode): string {
  if (node.open) return node.status === 'wait' ? 'pending' : 'running';
  return node.status === 'ok' ? 'success' : node.status === 'err' ? 'failed' : node.status;
}

/**
 * 从事件里推导 run 级元信息：迭代次数、总耗时、token。
 * 后端给了 RunSummary 就用它兜底，页面不必自己算。
 */
export function projectRunMeta(
  events: TraceEvent[],
  fallback: {
    runId: string;
    agentId: string;
    kind: 'react' | 'harness';
    sessionId: string;
    user: string;
    source: string;
    durationMs: number;
    tokens: number;
    cacheHitRate: string;
    parentRunId: string | null;
    taskId: string | null;
  },
): TraceRunMeta {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const root = ordered.find((event) => event.kind === 'agent');
  const iterations = ordered.filter((event) => event.type === 'reasoning.started').length;
  const totalTokens = ordered.reduce((sum, event) => sum + (event.tokens ?? 0), 0);
  const completed = ordered.find((event) => event.type === 'run.completed');
  const failed = ordered.find((event) => event.type === 'error.raised');

  return {
    runId: fallback.runId,
    agentId: root?.label ?? fallback.agentId,
    agentKind: fallback.kind,
    sessionId: fallback.sessionId,
    user: fallback.user,
    source: fallback.source,
    status: failed ? '失败' : completed ? '成功' : '运行中',
    tone: failed ? 'err' : completed ? 'ok' : 'run',
    durationMs: completed?.durationMs ?? root?.durationMs ?? fallback.durationMs,
    iterations: iterations || 1,
    tokens: totalTokens || fallback.tokens,
    cacheHitRate: fallback.cacheHitRate,
    // 父子关系只在 run 级元信息里有（事件流里根本没有这个信息），原样透传，不做任何推导
    parentRunId: fallback.parentRunId,
    taskId: fallback.taskId,
  };
}
