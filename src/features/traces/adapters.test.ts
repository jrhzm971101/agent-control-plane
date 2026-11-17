import { describe, expect, it } from 'vitest';
import { describeTraceNode, findTraceNode, projectRunMeta, projectTrace, traceSpanMs } from './adapters';
import { mockRunFallback, mockTraceEvents, mockTraceHistory } from './mockEvents';
import type { TraceEvent, TraceEventType } from './model';

describe('projectTrace', () => {
  it('把事件投影成调用树，并保留层级', () => {
    const roots = projectTrace(mockTraceEvents);
    expect(roots).toHaveLength(1);

    const root = roots[0];
    expect(root.label).toBe('workwx_batch_agent');
    expect(root.children.map((child) => child.path)).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5']);

    const batch = findTraceNode(roots, '1.4');
    expect(batch?.children.map((child) => child.path)).toEqual(['1.4.1', '1.4.2', '1.4.3']);
  });

  it('乱序到达的事件不影响树结构', () => {
    const shuffled = [...mockTraceEvents].sort((a, b) => b.seq - a.seq);
    const roots = projectTrace(shuffled);
    expect(findTraceNode(roots, '1.4.1')?.status).toBe('ok');
    expect(findTraceNode(roots, '1.5.1')?.status).toBe('wait');
  });

  it('只有完成事件时不会凭空建节点', () => {
    const roots = projectTrace(mockTraceEvents.filter((event) => event.type === 'reasoning.completed'));
    expect(roots).toEqual([]);
  });

  it('未完成节点标记为 open', () => {
    const roots = projectTrace(mockTraceHistory);
    expect(findTraceNode(roots, '1.4.3')).toBeNull();
    const withLive = projectTrace(mockTraceEvents);
    expect(findTraceNode(withLive, '1.5')?.open).toBe(true);
    expect(findTraceNode(withLive, '1.2')?.open).toBe(false);
  });

  /*
   * 后端加一个新事件类型时（比如给模型重试补一条 reasoning.retried），
   * 前端这一刻的 eventPresentation 里还没有它 —— 而 type 是 JSON 里的任意字符串，
   * 反序列化时被直接断言成了联合类型，没有任何校验兜住。
   * 如果 presentEvent 对未知类型返回 undefined，这里会抛
   * "Cannot read properties of undefined (reading 'standalone')"，
   * 表现是整条链路页白屏 —— 恰恰在最需要看链路的时候打不开。
   */
  it('认不出来的事件类型不会让整棵树塌掉', () => {
    const unknown = {
      ...mockTraceEvents[0],
      id: 'unknown-1',
      seq: 9_999,
      path: '1.9',
      type: 'reasoning.retried' as TraceEventType,
    } as TraceEvent;

    const roots = projectTrace([...mockTraceEvents, unknown]);

    // 不抛错，而且这条事件在树里真的占了个位置 —— 悄悄吞掉它比显示成未知更糟
    expect(findTraceNode(roots, '1.9')).not.toBeNull();
  });
});

describe('describeTraceNode', () => {
  it('带上耗时占比、token 分项与输入输出的原始 JSON', () => {
    const roots = projectTrace(mockTraceEvents);
    const node = findTraceNode(roots, '1.4.1')!;
    const detail = describeTraceNode(node, mockTraceEvents, traceSpanMs(roots));

    expect(detail.fields.find((field) => field.label === '类型')?.value).toContain('子 Agent');
    expect(detail.fields.find((field) => field.label === '耗时')?.value).toContain('占比');
    expect(detail.fields.find((field) => field.label === 'Token')?.value).toContain('in 9,812');
    expect(detail.sections.map((section) => section.title)).toEqual(['输入 · input', '输出 · output']);
    expect(detail.sections[1].json).toContain('checked');
  });
});

describe('projectRunMeta', () => {
  it('迭代数按 reasoning 起点统计，运行中时状态为运行中', () => {
    const meta = projectRunMeta(mockTraceEvents, mockRunFallback);
    expect(meta.iterations).toBe(3);
    expect(meta.status).toBe('运行中');
    expect(meta.tone).toBe('run');
  });

  it('出现 run.completed 后判为成功', () => {
    const completed = [
      ...mockTraceEvents,
      {
        ...mockTraceEvents[0],
        id: 'done',
        seq: 99,
        type: 'run.completed' as const,
        durationMs: 30_000,
      },
    ];
    const meta = projectRunMeta(completed, mockRunFallback);
    expect(meta.status).toBe('成功');
    expect(meta.durationMs).toBe(30_000);
  });
});
