/*
 * SSE 切帧与解码的单测。
 *
 * 为什么这一层值得测：它处理的是「字节流的边界」，而边界怎么切由网络决定，
 * 不由我们决定。写错的表现是「回答中间少一段」或者「心跳把解析搞崩」，
 * 这两种现象在页面上都很难复现，也没法靠人工点几下验出来。
 */
import { describe, expect, it } from 'vitest';
import { decodeChatFrame, splitSseFrames } from './api';

describe('splitSseFrames', () => {
  it('切出完整帧，并把不完整的尾巴留下', () => {
    const { frames, rest } = splitSseFrames('event: delta\ndata: {"a":1}\n\ndata: {"b"');

    expect(frames).toEqual([{ event: 'delta', data: '{"a":1}' }]);
    expect(rest).toBe('data: {"b"');
  });

  it('注释行（心跳）不产生帧', () => {
    const { frames, rest } = splitSseFrames(':keep-alive\n\n');

    expect(frames).toEqual([]);
    expect(rest).toBe('');
  });

  it('多行 data 拼回一个换行', () => {
    const { frames } = splitSseFrames('data: 第一行\ndata: 第二行\n\n');

    expect(frames).toEqual([{ event: '', data: '第一行\n第二行' }]);
  });

  it('冒号后的一个空格属于分隔符，不属于值', () => {
    const { frames } = splitSseFrames('event: delta\ndata:{"x":1}\n\n');

    expect(frames[0]).toEqual({ event: 'delta', data: '{"x":1}' });
  });

  it('\\r\\n 换行同样能切', () => {
    const { frames } = splitSseFrames('data: {"a":1}\r\n\r\n');

    expect(frames).toEqual([{ event: '', data: '{"a":1}' }]);
  });

  /*
   * 这条是这一层的核心不变式：分片切在哪里都不该丢帧。
   * 逐字符喂进去，最后收到的帧集合必须与一次性喂进去完全一致。
   */
  it('逐字符喂入不丢帧', () => {
    const stream = 'event: delta\ndata: {"type":"delta","data":{"text":"你"}}\n\n'
      + ':keep-alive\n\n'
      + 'data: {"type":"done","data":{"status":"DONE"}}\n\n';

    const collected: string[] = [];
    let buffer = '';
    for (const ch of stream) {
      buffer += ch;
      const cut = splitSseFrames(buffer);
      buffer = cut.rest;
      collected.push(...cut.frames.map((frame) => frame.data));
    }

    expect(collected).toEqual([
      '{"type":"delta","data":{"text":"你"}}',
      '{"type":"done","data":{"status":"DONE"}}',
    ]);
  });
});

describe('decodeChatFrame', () => {
  it('解析出 type 与 data', () => {
    const frame = decodeChatFrame({ event: 'delta', data: '{"type":"delta","data":{"text":"你好"}}' });

    expect(frame).toEqual({ type: 'delta', data: { text: '你好' } });
  });

  it('data 不是 JSON 时丢弃这一帧而不是抛错', () => {
    expect(decodeChatFrame({ event: '', data: '不是 JSON' })).toBeNull();
  });

  it('词表外的 type 丢弃', () => {
    expect(decodeChatFrame({ event: '', data: '{"type":"unknown.thing"}' })).toBeNull();
  });

  it('缺 data 字段时给空对象，不影响渲染', () => {
    expect(decodeChatFrame({ event: 'done', data: '{"type":"done"}' })).toEqual({ type: 'done', data: {} });
  });

  it('data 不是对象时同样给空对象', () => {
    expect(decodeChatFrame({ event: '', data: '{"type":"done","data":"oops"}' })).toEqual({ type: 'done', data: {} });
  });
});
