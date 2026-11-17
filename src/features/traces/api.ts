/*
 * 轨迹的取数与订阅。
 *
 * 两条通道分工明确（对齐官方实现）：
 * - REST：权威读，支持 ?after= / ?before= 游标分页，用于历史与补齐缺口；
 * - SSE：只做增量推送，断线用 Last-Event-ID 续传。
 * 推送从不直接改页面状态 —— 一律经 useRunEvents 的游标合并后再落状态。
 */
import { ApiError, apiJson, apiResponse, buildUrl } from '@/lib/apiClient';
import { mockTraceRuns } from './mockDataset';
import { mockRunInfo, mockTraceHistory, mockTraceLive } from './mockEvents';
import type { RunSummary } from '@/api/types';
import type { TraceEvent, TraceEventPage, TraceRunInfo } from './model';

/** 执行链路默认连接真实后端；只有显式打开 VITE_TRACES_MOCK=true 才使用演示数据。 */
export const TRACES_SOURCE_MOCK = import.meta.env.VITE_TRACES_MOCK === 'true';

function mockDelay<T>(value: T, delayMs = 120): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), delayMs);
  });
}

export interface FetchRunEventsOptions {
  limit?: number;
  /** 只取 seq 大于该值的事件（断点续传用）。 */
  after?: number;
  /** 只取 seq 小于该值的事件（向前翻页用）。 */
  before?: number;
}

/** run 列表；演示数据与真实接口由同一个 VITE_TRACES_MOCK 开关决定。 */
export async function fetchTraceRuns(): Promise<RunSummary[]> {
  if (TRACES_SOURCE_MOCK) return mockDelay(mockTraceRuns);
  return apiJson<RunSummary[]>(buildUrl('/api/traces', { limit: 200 }));
}

/** run 级元信息，页面用它渲染顶部概览，不用自己从事件里凑。 */
export async function fetchRunInfo(runId: string): Promise<TraceRunInfo> {
  if (TRACES_SOURCE_MOCK) {
    return new Promise((resolve) => {
      window.setTimeout(() => resolve(mockRunInfo(runId)), 80);
    });
  }
  return apiJson<TraceRunInfo>(buildUrl(`/api/traces/${encodeURIComponent(runId)}`));
}

export async function fetchRunEvents(
  runId: string,
  options: FetchRunEventsOptions = {},
): Promise<TraceEventPage> {
  const { limit = 100, after, before } = options;

  if (TRACES_SOURCE_MOCK) {
    return mockFetchRunEvents(runId, limit, after, before);
  }

  const page = await apiJson<{ events: TraceEvent[]; hasEarlier?: boolean }>(
    buildUrl(`/api/traces/${encodeURIComponent(runId)}/events`, { limit, after, before }),
  );
  const events = page.events ?? [];
  /*
   * hasEarlier 以服务端为准（后端确实会返回它，见 AgentTraceController#events 的
   * `new TraceEventPage(list, from > 0)`），缺失时才退回「拿满一页 = 可能还有」这个启发式。
   *
   * 当前调用方（useRunEvents）不再消费这个字段：首屏固定从 seq 0 开始、之后一路向后补齐，
   * 链路是「从头往尾长」出来的，不需要往上翻。留着它是两侧的公共契约（见 model.ts 的
   * TraceEventPage），以后真要做向上翻页时不必回来改这一层。
   */
  return { events, hasEarlier: page.hasEarlier ?? events.length >= limit };
}

/**
 * mock：事件脚本只写了一份，其它 runId 复用同一份并重新打戳。
 *
 * <p>根节点的 label 是 run 的 Agent 名，必须跟着 runId 一起换 ——
 * 否则从列表点进 k8s_agent 的 run，详情页顶栏和调用树里都会写着
 * workwx_batch_agent（projectRunMeta 优先取根事件的 label）。
 */
function restamp(runId: string, events: TraceEvent[]): TraceEvent[] {
  const agentId = mockRunInfo(runId).agentId;
  return events.map((event) => ({
    ...event,
    runId,
    id: `${runId}-${event.seq}`,
    ...(event.path === '1' ? { label: agentId } : {}),
  }));
}

function mockFetchRunEvents(
  runId: string,
  limit: number,
  after?: number,
  before?: number,
): Promise<TraceEventPage> {
  const all = restamp(runId, mockTraceHistory);
  let events: TraceEvent[];

  if (after !== undefined) {
    events = all.filter((event) => event.seq > after).slice(0, limit);
  } else if (before !== undefined) {
    const older = all.filter((event) => event.seq < before);
    events = older.slice(Math.max(0, older.length - limit));
  } else {
    events = all.slice(Math.max(0, all.length - limit));
  }

  return new Promise((resolve) => {
    window.setTimeout(() => resolve({ events, hasEarlier: events.length >= limit }), 90);
  });
}

export interface TraceStreamHandle {
  close: () => void;
}

export interface StreamRunEventsOptions {
  /** 每次重连都重新取一次游标，避免用到闭包里的旧值。 */
  getAfter?: () => number;
  retryMs?: number;
  maxRetryMs?: number;
  onOpen?: () => void;
}

/** 订阅增量事件；返回的句柄负责关闭（组件卸载时必须调用）。 */
export function streamRunEvents(
  runId: string,
  onEvent: (event: TraceEvent) => void,
  onError?: (error: Error) => void,
  options?: StreamRunEventsOptions,
): TraceStreamHandle {
  if (TRACES_SOURCE_MOCK) {
    return mockStreamRunEvents(runId, onEvent, options);
  }
  return sseStreamRunEvents(runId, onEvent, onError, options);
}

function mockStreamRunEvents(
  runId: string,
  onEvent: (event: TraceEvent) => void,
  options?: StreamRunEventsOptions,
): TraceStreamHandle {
  let closed = false;
  const timers: number[] = [];

  timers.push(
    window.setTimeout(() => {
      if (closed) return;
      options?.onOpen?.();
      for (const frame of mockTraceLive) {
        timers.push(
          window.setTimeout(() => {
            if (closed) return;
            onEvent({ ...frame.event, runId, id: `${runId}-${frame.event.seq}` });
          }, frame.delayMs),
        );
      }
    }, 400),
  );

  return {
    close: () => {
      closed = true;
      for (const timer of timers) window.clearTimeout(timer);
    },
  };
}

function sseStreamRunEvents(
  runId: string,
  onEvent: (event: TraceEvent) => void,
  onError?: (error: Error) => void,
  options?: StreamRunEventsOptions,
): TraceStreamHandle {
  const controller = new AbortController();
  let closed = false;
  let backoffMs = Math.max(500, options?.retryMs ?? 1_000);
  const maxRetryMs = options?.maxRetryMs ?? 30_000;

  async function connect(): Promise<void> {
    const after = options?.getAfter?.() ?? 0;
    const response = await apiResponse(`/api/traces/${encodeURIComponent(runId)}/events/stream`, {
      headers: {
        Accept: 'text/event-stream',
        ...(after > 0 ? { 'Last-Event-ID': String(after) } : {}),
      },
      signal: controller.signal,
    });
    if (!response.body) throw new Error('轨迹事件流没有响应体');
    backoffMs = Math.max(500, options?.retryMs ?? 1_000);
    options?.onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          try {
            onEvent(JSON.parse(data) as TraceEvent);
            backoffMs = Math.max(500, options?.retryMs ?? 1_000);
          } catch {
            // 单帧解析失败不推进游标，避免把坏帧当成「已消费」
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  void (async () => {
    while (!closed) {
      try {
        await connect();
      } catch (cause) {
        if (closed || (cause instanceof Error && cause.name === 'AbortError')) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        // 404 / 405 表示后端根本没有这个端点（或 runId 已不存在）。这类错误重连多少次都一样，
        // 交给页面显示一次就够 —— 否则页面会以 30s 为单位一直敲后端，日志里全是噪声。
        if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
          onError?.(error);
          return;
        }
        onError?.(error);
      }
      if (closed) return;
      const delay = backoffMs;
      backoffMs = Math.min(maxRetryMs, backoffMs * 2);
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
  })();

  return {
    close: () => {
      closed = true;
      controller.abort();
    },
  };
}
