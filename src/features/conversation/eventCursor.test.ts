import { describe, expect, it } from 'vitest';
import { highestSequence, mergeContiguousEvents } from './eventCursor';

interface Item {
  seq: number;
  text: string;
}

describe('mergeContiguousEvents', () => {
  it('只释放连续前缀，把乱序到达的事件留在待处理集合里', () => {
    const pending = new Map<number, Item>();

    // seq 12 先到：缺口在 11，所以一个都不能释放。
    const first = mergeContiguousEvents<Item>(10, pending, [{ seq: 12, text: 'twelve' }], (e) => e.seq);
    expect(first.cursor).toBe(10);
    expect(first.accepted).toEqual([]);
    expect(pending.size).toBe(1);

    // seq 11 到达后，11 与 12 一起释放。
    const second = mergeContiguousEvents<Item>(first.cursor, pending, [{ seq: 11, text: 'eleven' }], (e) => e.seq);
    expect(second.cursor).toBe(12);
    expect(second.accepted.map((event) => event.text)).toEqual(['eleven', 'twelve']);
    expect(pending.size).toBe(0);
  });

  it('重复事件不会推进游标', () => {
    const pending = new Map<number, Item>();
    const result = mergeContiguousEvents<Item>(3, pending, [{ seq: 3, text: 'again' }], (e) => e.seq);
    expect(result.cursor).toBe(3);
    expect(result.accepted).toEqual([]);
  });
});

describe('highestSequence', () => {
  it('取事件里的最大序号，空集合返回 0', () => {
    expect(highestSequence<{ seq: number }>([], (event) => event.seq)).toBe(0);
    expect(
      highestSequence<{ seq: number }>([{ seq: 4 }, { seq: 9 }, { seq: 7 }], (event) => event.seq),
    ).toBe(9);
  });
});