import { describe, expect, it } from 'vitest';

import { tabKeyForRoute, tabTitleForRoute } from './tabs';

describe('页面标签页', () => {
  it('query 不产生新标签，对话页切换 agent 也不产生新标签', () => {
    expect(tabKeyForRoute({ name: 'agent-detail', path: '/agents/a' })).toBe('/agents/a');
    expect(tabKeyForRoute({ name: 'chat', path: '/chat/a' })).toBe('/chat');
    expect(tabKeyForRoute({ name: 'chat', path: '/chat/b' })).toBe('/chat');
  });

  it('静态页面用导航名，详情页带上主体标识', () => {
    expect(tabTitleForRoute({ name: 'agents', path: '/agents', params: {} })).toBe('Agents');
    expect(
      tabTitleForRoute({ name: 'agent-detail', path: '/agents/a', params: { agentId: 'a' } }),
    ).toBe('Agent 详情 · a');
    expect(
      tabTitleForRoute({ name: 'harness-detail', path: '/harness/h', params: { agentId: 'h' } }),
    ).toBe('Harness 工作台 · h');
    expect(
      tabTitleForRoute({ name: 'storage-session', path: '/storage/t/u:s', params: { table: 't', slotId: 'u:s' } }),
    ).toBe('会话详情 · u:s');
    expect(tabTitleForRoute({ name: 'chat', path: '/chat/a', params: { agentId: 'a' } })).toBe('对话');
  });
});
