/*
 * 轨迹取数方向的单测。
 *
 * 钉住的是一个真实事故：某个 run 有 528 条事件，首屏只取「最新 100 条」→ 树的根
 * （seq 1）不在窗口里 → 递归投影时找不到父节点的第 61 轮被顶成了根，
 * 页面看起来「从第 61 轮开始展示」。所以「首屏必须是最早一页」这件事得有用例守着，
 * 不能只写在注释里 —— 它是一行代码就能改回去的方向性决策。
 *
 * 为什么不打真后端：这里要钉的是「某个 run 有 N 条事件时，前端按什么游标发几次请求」，
 * 真后端的事件数是活的、每次都不一样。假实现把 AgentTraceController#events 的
 * 分页语义照抄一遍（after → 从该号之后往前切；不带游标 → 切尾部），
 * 这样「发了什么游标」与「拿回来是哪一段」之间才没有空隙，请求序列本身就能被断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { TraceEvent } from './model';

/*
 * 假 api 与用例之间的共享槽。
 * 必须走 vi.hoisted：vi.mock 的工厂函数会被提升到 import 之前执行，
 * 工厂里引用的变量也得跟着一起提升，否则会拿到「还没初始化」的绑定。
 */
const sink = vi.hoisted(() => ({
  /** 每次 REST 取数的实参，按调用顺序 —— 断言的就是这串「请求序列」。 */
  calls: [] as Array<{ limit: number; after?: number; before?: number }>,
  /** 假后端手里的事件全集（seq 升序，与真后端一致）。 */
  all: [] as Array<{ seq: number }>,
  /** 直播回调：用例通过它手动喂帧，才能在「流还没结束」的中间态上做断言。 */
  emit: null as null | ((event: unknown) => void),
  /** 直播重连时读的游标函数，用来验证续传从「已拿到的位置」开始。 */
  getAfter: null as null | (() => number),
}));

vi.mock('./api', () => ({
  fetchRunEvents: async (
    _runId: string,
    options: { limit?: number; after?: number; before?: number } = {},
  ) => {
    const { limit = 100, after, before } = options;
    sink.calls.push({ limit, after, before });
    const size = sink.all.length;
    let from = 0;
    let to = size;
    if (after !== undefined) {
      // 第一个 seq > after 的位置就是这一页的开头；找不到说明已经到尾部。
      const at = sink.all.findIndex((event) => event.seq > after);
      from = at < 0 ? size : at;
      to = Math.min(from + limit, size);
    } else if (before !== undefined) {
      // 第一个 seq >= before 的位置是「更早那一段」的右边界。
      const at = sink.all.findIndex((event) => event.seq >= before);
      to = at < 0 ? size : at;
      from = Math.max(0, to - limit);
    } else {
      // 不带游标 = 最新一页。首屏要是漏了 after=0，走的就是这一支。
      from = Math.max(0, size - limit);
    }
    return { events: sink.all.slice(from, to), hasEarlier: from > 0 };
  },
  streamRunEvents: (
    _runId: string,
    onEvent: (event: unknown) => void,
    _onError?: (error: Error) => void,
    options?: { getAfter?: () => number },
  ) => {
    sink.emit = onEvent;
    sink.getAfter = options?.getAfter ?? null;
    return {
      close: () => {
        sink.emit = null;
      },
    };
  },
}));

import { useRunEvents } from './useRunEvents';

/** 造一条形状合法的事件；用例只关心 seq，其余字段填成不会被误读的常量。 */
function ev(seq: number): TraceEvent {
  return {
    id: `run-x-${seq}`,
    seq,
    runId: 'run-x',
    type: 'reasoning.started',
    occurredAt: '2026-09-20T16:00:00.000+08:00',
    path: `1.${seq}`,
    parentPath: '1',
    kind: 'reasoning',
    label: `步骤 ${seq}`,
    source: null,
    status: 'ok',
    durationMs: null,
    tokens: null,
  };
}

/** seq 1..to 的连续事件。 */
function series(to: number): TraceEvent[] {
  return Array.from({ length: to }, (_unused, index) => ev(index + 1));
}

let wrapper: VueWrapper | null = null;
let api: ReturnType<typeof useRunEvents> | null = null;
let runSeq = 0;

/**
 * 挂一个只用来提供组件实例的宿主：组合式函数用到了 onBeforeUnmount，
 * 脱离组件调用会走 Vue 的「没有活动实例」告警分支。顺带每个用例换一个 runId，
 * 免得上一个用例的残留状态混进来。
 */
function mountRun(events: TraceEvent[]): void {
  sink.calls.length = 0;
  sink.all = events;
  sink.emit = null;
  sink.getAfter = null;
  api = null;
  runSeq += 1;
  const Host = defineComponent({
    setup() {
      api = useRunEvents(ref(`run-${runSeq}`));
      return () => null;
    },
  });
  wrapper = mount(Host);
}

/**
 * 等条件成立。不能用固定 sleep：补齐是「拉一页 → 判断 → 再拉一页」的循环，
 * 轮数随数据量变，写死等待时间就是在赌机器速度。
 */
async function until(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  api = null;
});

describe('useRunEvents 的取数方向', () => {
  it('首屏取最早一页，再从第 100 条之后补齐到尾部', async () => {
    mountRun(series(250));
    await until(() => api!.events.value.length === 250);

    // 第一次请求必须是「从头开始」。少了 after=0，后端给的是最新一页 ——
    // 也就是这次事故的成因，根节点不在窗口里，整棵树散成孤儿。
    expect(sink.calls[0]).toEqual({ limit: 100, after: 0 });
    // 补齐接着首屏的尾部走，而且是 500 的大页（不是又拉一次 100）。
    expect(sink.calls[1]).toEqual({ limit: 500, after: 100 });
    // 拿到的是 seq 1..250 的连续前缀，不是 151..250 这种半截窗口。
    expect(api!.events.value.map((event) => event.seq)).toEqual(
      Array.from({ length: 250 }, (_unused, index) => index + 1),
    );
    expect(api!.hasMore.value).toBe(false);
    expect(api!.loading.value).toBe(false);
    expect(api!.loadingMore.value).toBe(false);
  });

  it('补齐撞上轮数上限时置 hasMore，点「继续加载」能接着拉', async () => {
    mountRun(series(12_000));
    await until(() => api!.hasMore.value);

    // 首屏 100 + 20 轮 × 500 = 10100：补满是「有上限的后台动作」，不是无限拉。
    expect(api!.events.value.length).toBe(10_100);
    expect(sink.calls.length).toBe(21);
    // 撞上限要停，但不能把已经拿到的链路丢掉 —— 页面照样能渲染前 10100 条。
    expect(api!.events.value[0].seq).toBe(1);

    await api!.loadMore();
    expect(api!.events.value.length).toBe(12_000);
    expect(api!.hasMore.value).toBe(false);
  });

  it('直播断号时先缓冲，补齐后一起放出来；续传游标跟着已拿到的位置走', async () => {
    mountRun(series(150));
    // 直播在首屏之后 600ms 才挂上（STREAM_READY_DELAY_MS），这里等它就位。
    await until(() => sink.emit !== null);
    // 续传从「已经拿到的最大 seq」开始，重连才不会把同一段又推一遍。
    expect(sink.getAfter!()).toBe(150);

    sink.emit!(ev(152));
    await Promise.resolve();
    // 152 到了、151 还没到：这一条必须留在缓冲里，越过缺口渲染会让树错位。
    expect(api!.events.value.length).toBe(150);

    sink.emit!(ev(151));
    await until(() => api!.events.value.length === 152);
    expect(api!.events.value.map((event) => event.seq).slice(-2)).toEqual([151, 152]);
  });
});
