/*
 * 后端契约测试：拿一份**真实的** /api/traces/{runId}/events 响应喂给投影层。
 *
 * 为什么必须有这个测试：这次联调满屏 404，靠肉眼根本分不清"接口没通"还是
 * "数据通了但渲染不出来"。mock 事件源是照着契约手写的，写得再像也不能证明后端真的这么返回 ——
 * 字段名差一个字母、payload 少一层，页面就是一棵空树，而且不报错。
 * 所以这里锁一份逐字节落盘的真实响应（__fixtures__ 目录下），
 * 后端一改事件形状，这个测试先红，而不是等联调时在页面上猜。
 *
 * fixture 由 `Invoke-WebRequest http://localhost:9090/api/traces/5302626f/events?limit=100`
 * 的结果原样保存，没有经过任何再序列化。
 */
import { describe, expect, it } from 'vitest';
import raw from './__fixtures__/run-5302626f-events.json?raw';
import dispatchRaw from './__fixtures__/run-muktxn6e-async-dispatch-events.json?raw';
import { describeTraceNode, findTraceNode, projectRunMeta, projectTrace, traceSpanMs } from './adapters';
import type { TraceEvent } from './model';

const page = JSON.parse(raw) as { events: TraceEvent[]; hasEarlier: boolean };

/** 用真实 run 的元信息兜底，保证断言的是"后端给的数据"而不是页面的默认值。 */
const fallback = {
  runId: '5302626f',
  agentId: 'workwx_batch_agent',
  kind: 'harness' as const,
  sessionId: 'single-wo7U1ZEQAApziTCwT6jow9UKLs0xrqlw-2026-09-20',
  user: 'wo7U1ZEQAApziTCwT6jow9UKLs0xrqlw',
  // 来源列 2026-09-23 起由入口方真实写入（这份 fixture 抓的时候还没有这一列，当时恒为 unknown）
  source: 'wecom',
  durationMs: 4801,
  tokens: 16897,
  cacheHitRate: '5%',
  // 这次调用是企微通道直接发起的，不是异步派发出来的子链路
  parentRunId: null,
  taskId: null,
};

describe('后端真实响应（fixture）', () => {
  it('事件字段与 TraceEvent 契约一致，投影层不会静默丢掉事件', () => {
    expect(page.events).toHaveLength(4);
    for (const event of page.events) {
      expect(typeof event.id).toBe('string');
      expect(typeof event.seq).toBe('number');
      expect(event.runId).toBe('5302626f');
      expect(typeof event.type).toBe('string');
      expect(typeof event.path).toBe('string');
      expect(typeof event.label).toBe('string');
    }
    // seq 单调递增是断点续传（?after=）的前提，后端乱序就是对不上游标
    const seqs = page.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('投影出 run 根节点 + 一轮推理，且 run.completed 不会重复建节点', () => {
    const roots = projectTrace(page.events);
    expect(roots).toHaveLength(1);

    const root = roots[0];
    expect(root.path).toBe('1');
    expect(root.label).toBe('workwx_batch_agent');
    expect(root.status).toBe('ok');
    expect(root.durationMs).toBe(4801);
    expect(root.children.map((child) => child.path)).toEqual(['1.1']);

    const reasoning = findTraceNode(roots, '1.1');
    expect(reasoning?.source).toBe('deepseek-v4-flash');
    expect(reasoning?.tokens).toBe(16897);
    expect(reasoning?.open).toBe(false);
  });

  it('节点详情直接吃后端的 payload.input / output / metrics', () => {
    const roots = projectTrace(page.events);
    const node = findTraceNode(roots, '1.1')!;
    const detail = describeTraceNode(node, page.events, traceSpanMs(roots));

    expect(detail.sections.map((section) => section.title)).toEqual(['输入 · input', '输出 · output']);
    expect(detail.sections[0].json).toContain('visibleTools');
    expect(detail.sections[1].json).toContain('plannedTools');

    // token 分项来自 payload.metrics；inputTokens / outputTokens 已折进 Token 字段，不重复列
    expect(detail.fields.find((field) => field.label === 'Token')?.value)
      .toBe('16,897（in 16,382 / out 515）');
    expect(detail.fields.find((field) => field.label === 'cachedTokens')?.value).toBe('896');
  });

  it('run 级元信息取真实事件推导，token 不因根节点而翻倍', () => {
    const meta = projectRunMeta(page.events, fallback);
    expect(meta.status).toBe('成功');
    expect(meta.tokens).toBe(16897);
    expect(meta.iterations).toBe(1);
    expect(meta.durationMs).toBe(4801);
  });
});

/*
 * 异步派发（agent_spawn timeout_seconds=0）的真实响应。
 *
 * 2026-09-28 真机跑出来的一条（run muktxn6e-pt1ohn，跑的是 test_harness_agent 后台派发
 * test-workwx-doc-agent）。fixture 是那次 /events 响应里<b>按 seq 挑出的 7 条</b>
 * （1/2/3/5/7/9/10），字段值逐字节照抄，只是把无关的中间事件去掉了 ——
 * 整份 178 条有 130 多 KB，而这里要守的只有两个形状。
 *
 * 为什么要锁它：这两件事此前在真机上都是错的，且不报错、只在页面上表现为"看起来正常"——
 * ① 派发节点被画成"同步成功"（status 是 ok 而不是 wait），让人以为子 agent 已经给了结论；
 * ② 子 agent 的节点挂不到派发节点下（异步派发的时间区间根本不重叠，靠区间归属认不出来）。
 * 后端解析结果文本的坑（JSON 编码过的结果文本）就是这次真机才暴露的，见
 * AgentRunTraceMiddleware#decodeToolText。
 */
const dispatchPage = JSON.parse(dispatchRaw) as { events: TraceEvent[]; hasEarlier: boolean };

describe('异步派发的真实响应（wait + 子会话归属）', () => {
  it('派发节点收口为 wait（仍在进行中），子 agent 的子树挂在这个派发节点下', () => {
    const roots = projectTrace(dispatchPage.events);

    const dispatch = findTraceNode(roots, '1.2');
    expect(dispatch?.kind).toBe('subagent');
    expect(dispatch?.status).toBe('wait');
    // wait 在页面上等同于"还没结束"（projectTrace 的 open 判定），节点显示 pending
    expect(dispatch?.open).toBe(true);

    // 子 agent 的第 1 轮推理（seq 7，agentSession=sub-…）精确挂在这次派发下
    expect(dispatch?.children.map((child) => child.path)).toEqual(['1.2.1']);
    // 子节点的 label 里带着它自己的 agent 名（轮次是按 agent 分桶的，见中间件）；source 是模型名
    expect(dispatch?.children[0].label).toContain('test-workwx-doc-agent');
    expect(dispatch?.children[0].open).toBe(true);
  });

  it('节点详情能看到后台任务号、子会话与"结果去哪了"的说明', () => {
    const roots = projectTrace(dispatchPage.events);
    const detail = describeTraceNode(
      findTraceNode(roots, '1.2')!,
      dispatchPage.events,
      traceSpanMs(roots),
    );

    expect(detail.fields.find((field) => field.label === 'dispatchStatus')?.value).toBe('accepted');
    expect(detail.fields.find((field) => field.label === 'taskId')?.value).toMatch(/^task_/);
    expect(detail.fields.find((field) => field.label === 'childSession')?.value).toMatch(/^sub-/);
    expect(detail.sections.find((section) => section.title === '说明')?.json)
      .toContain('已在后台继续执行');
  });
});
