/*
 * 事件 → 展示语义。
 *
 * 页面只消费这里的映射结果，不直接判断 TraceEventType，
 * 这样以后后端新增事件类型时，改一处即可（对齐官方 eventPresentation.ts 的职责）。
 */
import type { TraceEventType, TraceNodeKind } from './model';

export interface EventPresentation {
  label: string;
  kind: TraceNodeKind;
  /** 是否在树里单独成节点；粒度太细的 used/finished 事件只更新父节点。 */
  standalone: boolean;
}

export const eventPresentation: Record<TraceEventType, EventPresentation> = {
  'run.started': { label: 'run 开始', kind: 'agent', standalone: true },
  'run.completed': { label: 'run 结束', kind: 'agent', standalone: false },
  'reasoning.started': { label: 'reasoning', kind: 'reasoning', standalone: true },
  'reasoning.completed': { label: 'reasoning', kind: 'reasoning', standalone: false },
  'acting.started': { label: 'acting', kind: 'acting', standalone: true },
  'acting.completed': { label: 'acting', kind: 'acting', standalone: false },
  'tool.started': { label: 'tool', kind: 'tool', standalone: true },
  'tool.completed': { label: 'tool', kind: 'tool', standalone: false },
  'subagent.dispatched': { label: 'agent_spawn', kind: 'subagent', standalone: true },
  'subagent.completed': { label: 'agent_spawn', kind: 'subagent', standalone: false },
  'error.raised': { label: 'error', kind: 'error', standalone: true },
};

/**
 * 查一个事件类型该怎么展示。
 *
 * <p>对**未知类型必须给出兜底**，不能直接 `eventPresentation[type]` 就返回：
 * 类型联合只是前端这边的一厢情愿，JSON 里的 type 是任意字符串，反序列化时
 * 会被直接断言成 TraceEventType（没有任何校验）。后端加一个新事件类型
 * （比如给重试加一条 `reasoning.retried`）时，前端这一刻的代码还是旧的 ——
 * 而 adapters 里写的是 `presentEvent(event.type).standalone`，
 * 一个不认识的事件就足以抛异常，把**整条链路页**打成白屏。
 *
 * <p>宁可多显示一个"未知事件"，也不能整页打不开：执行链路页的价值就在于
 * 出了问题时它得能打开。兜底成 standalone 而不是沿用父节点，
 * 是为了让这条事件在树里真的可见 —— 悄悄吞掉它比显示成未知更糟。
 */
export function presentEvent(type: TraceEventType): EventPresentation {
  return (
    eventPresentation[type] ?? {
      label: type,
      kind: 'agent',
      standalone: true,
    }
  );
}
