/*
 * 轨迹事件订阅（组合式函数）。
 *
 * 与官方 frontend/src/features/operate/lib/useSessionEvents.ts 一一对应：
 * 同样的 generation 防竞态、同样的 pending 缓冲 + 前向补齐、同样的退避重连。
 * 差异只在 React → Vue 的写法上（useRef → ref，useEffect → watch/onUnmounted）。
 *
 * 唯一一处刻意偏离官方：首屏取「最早一页」而不是「最新一页」。
 * 官方那一页是会话流（越新的越靠下，打开时想看最新几条），本页是调用链树
 * （根挂在第一条事件上，缺了根整棵树就散成一堆孤儿）。取数方向见 refresh() 的注释。
 */
import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
import { highestSequence, mergeContiguousEvents } from '@/features/conversation/eventCursor';
import { fetchRunEvents, streamRunEvents } from './api';
import type { TraceEvent } from './model';

const PAGE_SIZE = 100;
/**
 * 补齐时每批的条数。取 500 而不是 PAGE_SIZE：
 * 首屏那一页是给人看的，要小（先画出来）；补齐是机器在拉，批量越大往返次数越少。
 * 后端单页上限是 1000（AgentTraceController.MAX_EVENTS_PER_PAGE），500 留了一半余量。
 */
const CATCH_UP_PAGE = 500;
/**
 * 一次补齐最多跑几轮，也就是「打开一个页面」最多主动拉回 20 × 500 = 10000 条事件。
 *
 * 事件数没有天花板（一条跑了半小时的 harness run 轻易上万条），不设限的话
 * 打开一个病态 run 会把浏览器和后端一起拖住。撞上限不是错误 —— 置 hasMore 之后
 * 由页面上的「继续加载」按钮把决定权交回给人。
 */
const CATCH_UP_MAX_ROUNDS = 20;
const STREAM_READY_DELAY_MS = 600;

function keyOf(event: TraceEvent, index: number): string {
  return event.id != null ? `id:${event.id}` : `seq:${event.seq ?? index}`;
}

/** 按 id/seq 去重合并，保证同一事件不会因为「历史 + 直播」各来一次而重复渲染。 */
export function mergeTraceEvents(older: TraceEvent[], newer: TraceEvent[]): TraceEvent[] {
  const seen = new Set<string>();
  return [...older, ...newer]
    .filter((event, index) => {
      const key = keyOf(event, index);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.seq - b.seq);
}

export interface UseRunEventsOptions {
  enabled?: Ref<boolean> | boolean;
}

export function useRunEvents(runId: Ref<string>, options: UseRunEventsOptions = {}) {
  const enabled = options.enabled ?? true;
  const isEnabled = () => (typeof enabled === 'boolean' ? enabled : enabled.value);

  const events = shallowRef<TraceEvent[]>([]);
  const loading = ref(false);
  /** 补齐 / 继续加载进行中。与 loading 分开：首屏那次和后台补那次要能分别提示。 */
  const loadingMore = ref(false);
  /** 后面还有没拿回来的事件（只会在补齐撞上轮数上限时为 true）。 */
  const hasMore = ref(false);
  const streamReady = ref(false);
  const error = ref<string | null>(null);

  let cursor = 0;
  const bufferedLive = new Map<number, TraceEvent>();
  /** 正在跑的补齐（同一时刻只允许一个：并发拉同一段会互相打乱游标）。 */
  let pulling: Promise<void> | null = null;
  /** 补齐失败后的重试定时器（1s 一轮），页面卸载和换 runId 时必须清掉。 */
  let pullTimer: number | null = null;
  let generation = 0;
  let streamHandle: { close: () => void } | null = null;
  let streamTimer: number | null = null;

  function setEvents(updater: (current: TraceEvent[]) => TraceEvent[]) {
    events.value = updater(events.value);
  }

  /**
   * 首次加载 / 手动刷新：取**最早**一页。
   *
   * <p>为什么不是「最新一页」：本页消费的是调用链树，树的根是 run 的第一条事件
   * （path = 1）。先拿最新一页，根就不在窗口里 —— 递归投影时找不到父节点的节点
   * 会被顶成根，页面看起来「从中间某一轮开始展示」（真实案例：528 条事件的 run，
   * 首屏 100 条只覆盖 seq 429..528，树顶变成了第 61 轮）。
   * 取最早一页则保证根一定在，也保证 events 始终是 seq 1..N 的连续前缀。
   *
   * <p>{@code after: 0} 必须显式写：不带游标时后端给的是最新一页，
   * 「我要从头开始」这件事得说清楚，不能依赖默认值 —— 默认值一改，这里就静默错方向。
   *
   * <p>首屏这一页直接并集，不过 {@link mergeContiguousEvents}：连续性校验是给
   * 「中途插进来的增量」把关的，而首屏自带 run 的开头，上游没有缺口可言。
   * 真要有一页是空的（run 还没写进任何事件），游标保持 0，等直播把它填上。
   */
  async function refresh(): Promise<void> {
    const id = runId.value;
    if (!id || !isEnabled()) return;
    const current = generation;
    loading.value = events.value.length === 0;
    try {
      const result = await fetchRunEvents(id, { limit: PAGE_SIZE, after: 0 });
      if (current !== generation) return;
      const incoming = result.events ?? [];
      if (incoming.length > 0) {
        // 游标对齐到已见的最大 seq：后面补齐缺口时从这个号往后拉。
        cursor = Math.max(cursor, highestSequence(incoming, (event) => event.seq ?? 0));
        setEvents((existing) => mergeTraceEvents(existing, incoming));
      }
      error.value = null;
    } catch (cause) {
      if (current === generation) {
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      if (current === generation) loading.value = false;
    }
  }

  /**
   * 向后补齐：从当前游标开始按 {@code after} 连续拉，直到追到尾部或撞上轮数上限。
   *
   * <p>三处调用它，语义完全一样，所以只留一个实现：
   * <ol>
   *   <li>首屏拿到第 1 页之后 —— 把链路从 100 条铺到「此刻为止」；</li>
   *   <li>直播期间出现缺口（先接到 seq 22、21 还没到）—— 前向读是权威的，
   *       补完再看缓冲里还有没有东西，有就隔 1s 再来一轮；</li>
   *   <li>用户点页面上的「继续加载」—— 补齐撞过上限之后的人工续拉。</li>
   * </ol>
   *
   * <p>为什么必须用 {@link mergeContiguousEvents} 落状态，而不是直接求并集：
   * 只有补齐回来的区间和已有游标严丝合缝（22 紧跟在 21 后面）时才允许落，
   * 否则中间会留一个洞 —— 洞会把后面所有事件永久卡在 pending 里，
   * 表现是「页面停在某一轮不再更新」。
   *
   * <p>轮数上限不能省：事件数没有天花板（跑半小时的 harness run 轻易上万条），
   * 不设限的话打开一个病态 run 会把浏览器和后端一起拖住。撞上限不是错误 ——
   * 置 hasMore 之后由页面上的按钮把决定权交回给人。
   */
  function pullForward(): Promise<void> {
    if (pulling) return pulling;
    const current = generation;
    const id = runId.value;
    pulling = (async () => {
      /** 补齐中途失败（网络抖动）时置位，隔 1s 重来一轮，避免页面永远停在半截。 */
      let retry = false;
      /** 是不是「没拉完」退出的：只有这一种情况才需要在页面上给按钮。 */
      let truncated = false;
      try {
        if (!id || !isEnabled()) return;
        loadingMore.value = true;
        for (let round = 0; round < CATCH_UP_MAX_ROUNDS; round += 1) {
          const after = cursor;
          const result = await fetchRunEvents(id, { limit: CATCH_UP_PAGE, after });
          if (current !== generation) return;
          const incoming = result.events ?? [];
          // 空页 = 后端说「这个游标之后没有了」，追到尾部。
          if (incoming.length === 0) break;
          const merged = mergeContiguousEvents(cursor, bufferedLive, incoming, (event) => event.seq ?? 0);
          cursor = merged.cursor;
          if (merged.accepted.length > 0) {
            setEvents((existing) => mergeTraceEvents(existing, merged.accepted));
          }
          // 一轮下来游标没动 = 卡在缺号上，不该继续空转，等那一号到了再补。
          if (cursor === after) {
            retry = bufferedLive.size > 0;
            break;
          }
          // 不足一整页 = 后端把尾部给完了，收工。
          if (incoming.length < CATCH_UP_PAGE) break;
          // 一整页一整页拿到底 = 这个 run 比一次补齐的上限更长，交给按钮。
          truncated = round === CATCH_UP_MAX_ROUNDS - 1;
        }
        hasMore.value = truncated;
        retry ||= bufferedLive.size > 0;
        error.value = null;
      } catch (cause) {
        if (current !== generation) return;
        error.value = cause instanceof Error ? cause.message : String(cause);
        retry = true;
      } finally {
        if (current === generation) {
          pulling = null;
          loadingMore.value = false;
        }
      }
      if (retry && current === generation && pullTimer === null) {
        pullTimer = window.setTimeout(() => {
          pullTimer = null;
          void pullForward();
        }, 1_000);
      }
    })();
    return pulling;
  }

  /**
   * 页面按钮入口：人来决定要不要接着往后拉。
   *
   * <p>刻意不做成「loadMore 之外的第二种补齐逻辑」—— 和自动补齐走同一个函数，
   * 才不会有「手动拉的路径没做连续性校验」这种只在长链路上才暴露的分叉。
   */
  async function loadMore(): Promise<void> {
    await pullForward();
  }

  function startStream(): void {
    if (streamHandle) return;
    const id = runId.value;
    streamHandle = streamRunEvents(
      id,
      (event) => {
        const seq = event.seq ?? 0;
        if (seq <= 0) {
          setEvents((existing) => mergeTraceEvents(existing, [event]));
          return;
        }
        const merged = mergeContiguousEvents(cursor, bufferedLive, [event], (item) => item.seq ?? 0);
        cursor = merged.cursor;
        if (merged.accepted.length > 0) {
          setEvents((existing) => mergeTraceEvents(existing, merged.accepted));
        }
        if (bufferedLive.size > 0) void pullForward();
        error.value = null;
      },
      (cause) => {
        error.value = cause.message;
      },
      { getAfter: () => cursor, onOpen: () => (error.value = null) },
    );
  }

  function stopStream(): void {
    streamHandle?.close();
    streamHandle = null;
    if (streamTimer !== null) {
      window.clearTimeout(streamTimer);
      streamTimer = null;
    }
  }

  function reset(): void {
    generation += 1;
    stopStream();
    events.value = [];
    cursor = 0;
    bufferedLive.clear();
    pulling = null;
    if (pullTimer !== null) window.clearTimeout(pullTimer);
    pullTimer = null;
    streamReady.value = false;
    hasMore.value = false;
    loadingMore.value = false;
    error.value = null;
  }

  watch(
    () => [runId.value, typeof enabled === 'boolean' ? enabled : enabled.value] as const,
    () => {
      reset();
      if (runId.value && isEnabled()) {
        // 首屏只画最早 100 条（先让用户看到链路的开头），剩下的在后台往后补齐。
        // 必须等 refresh 落地再补：补要是先跑，它会从游标 0 开始拉，
        // 把首屏那一页重新取一遍（幂等，但白跑一趟，也让请求序列不再可预测）。
        // refresh 内部自己吞异常，所以 .then 一定执行 —— 它失败时游标还是 0，
        // 补齐正好从 0 开始，是那条兜底的路。
        void refresh().then(() => {
          if (runId.value && isEnabled()) void pullForward();
        });
        // 历史先渲染，再挂直播，避免直播事件早于历史到达造成不必要的补洞。
        streamTimer = window.setTimeout(() => {
          streamTimer = null;
          streamReady.value = true;
        }, STREAM_READY_DELAY_MS);
      }
    },
    { immediate: true },
  );

  watch(streamReady, (ready) => {
    if (ready) startStream();
    else stopStream();
  });

  onBeforeUnmount(() => {
    generation += 1;
    stopStream();
    if (pullTimer !== null) window.clearTimeout(pullTimer);
    pullTimer = null;
  });

  return { events, loading, loadingMore, hasMore, streamReady, error, loadMore, refresh };
}
