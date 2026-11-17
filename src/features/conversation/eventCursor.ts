/*
 * 会话/轨迹事件游标。
 *
 * 与官方 frontend/src/features/conversation/eventCursor.ts 保持一致的实现与语义，
 * 迁移时只改了注释语言 —— 这样以后跟官方代码 diff 时不会有噪声。
 */
import type { Tone } from '@/api/types';

export interface ContiguousMergeResult<T> {
  cursor: number;
  accepted: T[];
}

/**
 * 把持久化事件并入待处理集合，只释放「连续前缀」。
 *
 * pending 会跨重连存活：如果 seq 12 先于 seq 11 到达，调用方先保留 12、
 * 从 10 回补历史，再一起释放 11 和 12。这样可避免续传游标永久跳过
 * 一条第一次读库时还不可见的事务。
 */
export function mergeContiguousEvents<T>(
  cursor: number,
  pending: Map<number, T>,
  incoming: Iterable<T>,
  sequenceOf: (event: T) => number,
): ContiguousMergeResult<T> {
  for (const event of incoming) {
    const sequence = sequenceOf(event);
    if (sequence > cursor && !pending.has(sequence)) pending.set(sequence, event);
  }

  const accepted: T[] = [];
  let next = cursor + 1;
  while (pending.has(next)) {
    const event = pending.get(next);
    pending.delete(next);
    if (event != null) accepted.push(event);
    cursor = next;
    next += 1;
  }
  return { cursor, accepted };
}

/** 事件里出现过的最大 seq，用于刷新后重新对齐游标。 */
export function highestSequence<T>(events: Iterable<T>, sequenceOf: (event: T) => number): number {
  let max = 0;
  for (const event of events) {
    const sequence = sequenceOf(event);
    if (sequence > max) max = sequence;
  }
  return max;
}

/** 状态点的语义类型，轨迹与列表页共用一套 tone。 */
export type { Tone };