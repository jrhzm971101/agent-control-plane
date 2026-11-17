/*
 * 页面标签页的身份与标题。
 *
 * 标签不是「一次路由跳转」，而是「一个页面」。所以这里的 key 刻意不看 query：
 * Agent 详情的 ?tab=runtime 只是同一页里的子页签，不该再生一个标签。
 *
 * 对话页进一步收成固定 key：它内部切换 agent 属于同一页的操作，
 * 每选一次 agent 就多一个标签会让标签栏很快失去意义。
 */
import type { RouteLocationNormalizedLoaded } from 'vue-router';

import { titleForPath } from './nav';

export interface PageTab {
  /** 页面身份，也是 KeepAlive 的缓存键前缀。 */
  key: string;
  /** 最近一次停留的完整地址（含 query），点标签时回到这里。 */
  path: string;
  title: string;
  /** 每次重新打开生成新序号，确保关闭后再打开拿到一份干净的页面状态。 */
  instance: number;
}

type TabRoute = Pick<RouteLocationNormalizedLoaded, 'name' | 'path' | 'params'>;

const CHAT_TAB_KEY = '/chat';

export function tabKeyForRoute(route: Pick<TabRoute, 'name' | 'path'>): string {
  if (route.name === 'chat') return CHAT_TAB_KEY;
  return route.path || '/';
}

function paramText(value: unknown): string {
  if (Array.isArray(value)) return value.length ? String(value[0]) : '';
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function withSubject(base: string, value: unknown): string {
  const subject = paramText(value);
  return subject ? `${base} · ${subject}` : base;
}

export function tabTitleForRoute(route: TabRoute): string {
  switch (route.name) {
    case 'chat':
      return '对话';
    case 'agent-detail':
      return withSubject('Agent 详情', route.params.agentId);
    case 'harness-detail':
      return withSubject('Harness 工作台', route.params.agentId);
    case 'trace-detail':
      return withSubject('链路详情', route.params.runId);
    case 'workspace-detail':
      return withSubject('工作区', route.params.agentName);
    case 'workflow-designer':
      return withSubject('工作流', route.params.workflowKey);
    case 'storage-table':
      return withSubject('状态存储', route.params.table);
    case 'storage-session':
      return withSubject('会话详情', route.params.slotId);
    default:
      return titleForPath(route.path);
  }
}
