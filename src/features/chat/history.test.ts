/*
 * 会话回放的映射单测。
 *
 * 这里只测"后端消息 → 页面的一轮轮对话"这一层纯函数：
 * 它不碰网络、不碰组件，是回放里唯一有可能悄悄出错的地方
 * （角色漏了一种、思考被错误地默认展开、工具名挂错了字段）。
 *
 * 取数与端到端渲染由 routes.smoke.test.ts 承担 —— 那边把页面真挂起来，
 * 验的是"点了历史会话，消息真的出现在页面上"。
 */
import { describe, expect, it } from 'vitest';
import { toChatTurns } from './history';
import type { StateMessage } from '@/api/state';

/** 只写关心的字段，其余按"框架给出的空值"补上。 */
function msg(partial: Partial<StateMessage>): StateMessage {
  return { role: 'USER', text: '', thinking: '', tools: [], timestamp: '', ...partial };
}

describe('会话消息 → 对话轮次', () => {
  it('只认 USER 与 ASSISTANT，工具与系统消息不进对话', () => {
    const turns = toChatTurns([
      msg({ role: 'SYSTEM', text: '你是某某助手' }),
      msg({ role: 'USER', text: '你好' }),
      msg({ role: 'ASSISTANT', text: '在的' }),
      msg({ role: 'TOOL', text: '工具返回的一大段' }),
    ]);

    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns.map((t) => t.text)).toEqual(['你好', '在的']);
    // 工具结果的正文一个字都不该漏进来
    expect(turns.map((t) => t.text).join('')).not.toContain('工具返回');
  });

  it('思考与正文分开存，且历史里的思考默认是收起的', () => {
    const [turn] = toChatTurns([
      msg({ role: 'ASSISTANT', thinking: '先想一下', text: '答案在这' }),
    ]);

    expect(turn.thinking).toBe('先想一下');
    expect(turn.text).toBe('答案在这');
    /*
     * 收起 + 视作"用户已手动动过"：一条跑了几十轮的长会话全展开能滚出好几屏，
     * 而且那套自动展开 / 收起的规则只服务于正在流式的那条消息。
     */
    expect(turn.thinkingOpen).toBe(false);
    expect(turn.thinkingTouched).toBe(true);
  });

  it('工具名挂在 activity 上，超过三个只报个数', () => {
    const [one] = toChatTurns([
      msg({ role: 'ASSISTANT', text: '查完了', tools: ['workday-query'] }),
    ]);
    expect(one.activity).toBe('调用过 workday-query');

    const [three] = toChatTurns([
      msg({ role: 'ASSISTANT', text: '查完了', tools: ['a', 'b', 'c'] }),
    ]);
    expect(three.activity).toBe('调用过 a、b、c');

    const [many] = toChatTurns([
      msg({ role: 'ASSISTANT', text: '查完了', tools: ['a', 'b', 'c', 'd', 'e'] }),
    ]);
    expect(many.activity).toBe('调用过 a、b、c 等 5 个工具');
  });

  it('只有工具调用的消息留一行提示；三个字段全空的才丢掉', () => {
    const turns = toChatTurns([
      msg({ role: 'USER', text: '帮我查' }),
      // 有工具名 → 保留：那一行"调用过 search"就是这一轮唯一的痕迹
      msg({ role: 'ASSISTANT', tools: ['search'] }),
      // 正文、思考、工具都空 → 丢掉。留着就是一个纯空气泡
      msg({ role: 'ASSISTANT' }),
      msg({ role: 'ASSISTANT', text: '查到了' }),
    ]);

    expect(turns).toHaveLength(3);
    expect(turns[1].text).toBe('');
    expect(turns[1].activity).toBe('调用过 search');
    expect(turns[2].text).toBe('查到了');
  });

  it('轮次 id 唯一、状态是已完成、不带 runId', () => {
    const turns = toChatTurns([
      msg({ role: 'USER', text: '一' }),
      msg({ role: 'ASSISTANT', text: '二' }),
      msg({ role: 'USER', text: '三' }),
      msg({ role: 'ASSISTANT', text: '四' }),
    ]);

    expect(new Set(turns.map((t) => t.id)).size).toBe(turns.length);
    expect(turns.every((t) => t.status === 'done')).toBe(true);
    /*
     * 历史轮次刻意不给 runId：它对应的是一次提问，而回放里一条 assistant 消息
     * 未必等于一次提问（一次提问里模型可能分多条消息）。硬塞一个坐标会让人
     * 点进一条不相干的链路。
     */
    expect(turns.every((t) => t.runId === '')).toBe(true);
  });
});