import type { AgentRow } from '@/api/controlplane/types';

/**
 * 建一个「agent 标识 → 展示名」的查表函数。
 *
 * <h2>为什么需要它</h2>
 * 控制面上到处都要展示 agent：资源的引用方、渠道的兜底 agent、网关的纳管清单、
 * 各种下拉候选。而库里存、接口回的一律是 {@code agent_name} —— 它同时是运行时注册键、
 * 前端路由参数（/chat/:agentId）与装配期的 AgentDefinition.name，改一次等于新建一个 agent。
 * 让这种列承担"给人看的名字"，改一次展示口径就要走整套版本快照与重新装配，
 * 所以展示名单独占一列（已后端化并必填）。
 *
 * <h2>回落成标识而不是空串</h2>
 * 查不到只有两种可能：agent 列表还没加载回来，或者那一行的展示名是空的（历史数据）。
 * 两种情况下"显示机器名"都比"显示空白"有用 —— 空白会被当成页面坏了，
 * 而机器名至少能立刻对上库里、日志里、配置里的东西。
 *
 * <h2>为什么不各写一遍</h2>
 * 回落规则一旦分叉（有的页面回落、有的不回落、有的回落成"未命名"），
 * 同一个 agent 在不同页面上就会叫不同的名字 —— 而那正是这次改造要消灭的那类问题。
 */
export function agentDisplayName(
  rows: AgentRow[] | null | undefined,
): (name: string) => string {
  // 先建 Map 再查：引用方/纳管清单这类地方是循环调用，逐次 find 会让
  // "列表页渲染" 从 O(n) 变成 O(n·m)，而这类页面正好是最常刷新的那些。
  const byName = new Map((rows ?? []).map((row) => [row.agentName, row.displayName]));
  return (name: string) => byName.get(name) || name;
}
