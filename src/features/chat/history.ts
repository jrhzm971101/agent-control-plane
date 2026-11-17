/*
 * 会话回放 —— 在对话页点开一条历史会话时，把它当时的对话内容取回来。
 *
 * <h2>一、数据从哪来</h2>
 * 两个接口，缺一不可：
 * <ol>
 *   <li>{@code GET /api/state/tables} —— 找到这个 agent 的状态表。表名取
 *       {@code md_agent_runtime.state_table}，为空时回落 agent 名，所以它**不等于**
 *       agentId（改名过的 agent 就是这个差值）。拿 agentId 当表名去查，结果是一条
 *       404，而且只在改过名的 agent 上出现。</li>
 *   <li>{@code GET /api/state/sessions/messages} —— 按 {@code <userId>:<sessionId>}
 *       拿那个会话的完整消息。这个拼法是框架在 MySQL 状态存储里的槽位键，
 *       与 run 表把两段分开存不同（见后端
 *       {@code AgentStateAdminService#slotId} 的注释）。</li>
 * </ol>
 *
 * <h2>二、为什么不是"直接读 run 表"</h2>
 * run 表记的是"这一次执行发生了什么"（耗时、token、成功与否），它没有回答的内容；
 * 回答在状态表里（那是模型下一轮真正会看到的上下文）。会话记录页看的是前者，
 * 这一页要看的是后者 —— 两个页面的数据源天生不同，不是重复实现。
 *
 * <h2>三、为什么状态表名要缓存</h2>
 * {@code /api/state/tables} 会把库里所有状态表都列一遍（每个 agent 一行，
 * 还要逐个统计行数与体积）。这张表在一次页面停留期间不会变，而"点开一条历史会话"
 * 可能连点好几次 —— 每次都重拉一遍是纯浪费。
 * 缓存只在模块里活一次会话，刷新页面即失效；表结构变了需要重进页面，这点写在
 * {@link resolveStateTable} 上。
 */
import { fetchStateMessages, fetchStateTables, type StateMessage } from '@/api/state';
import type { ChatTurn } from './model';

/** 一个 agent 的状态表名 → 表名（null 表示它没有状态表）。 */
let tableByAgent: Map<string, string> | null = null;

/**
 * 这个 agent 的状态表名；没有则 null。
 *
 * <p>同一个 agentName 有多张表时取第一张：正常装配下这是不可能的
 * （表名由 state_table 决定，一个 agent 只有一个），真出现了也只需要能进得去。
 *
 * <p>模块级缓存，进程（页面）内不再失效。它缓存的是"表清单"，不是"表里的内容" ——
 * 内容每次都重拉，所以缓存不会让用户看到旧消息。
 */
export async function resolveStateTable(agentId: string): Promise<string | null> {
  if (!tableByAgent) {
    const tables = await fetchStateTables();
    tableByAgent = new Map();
    for (const table of tables) {
      if (table.agentName && !tableByAgent.has(table.agentName)) {
        tableByAgent.set(table.agentName, table.tableName);
      }
    }
  }
  return tableByAgent.get(agentId) ?? null;
}

/** 仅供单测：把上面的模块级缓存清掉。 */
export function resetStateTableCache(): void {
  tableByAgent = null;
}

/**
 * 取一条会话的对话内容。
 *
 * <p>没有状态表时返回空数组而不是抛错：那不是故障，是"这个 agent 没开状态存储"，
 * 页面据此显示一句"没有可回放的上下文"就行 —— 把配置问题渲染成一个红色报错，
 * 只会让人以为系统坏了。
 */
export async function loadConversation(
  agentId: string,
  userId: string,
  sessionId: string,
): Promise<ChatTurn[]> {
  if (!agentId || !userId || !sessionId) return [];
  const table = await resolveStateTable(agentId);
  if (!table) return [];
  const messages = await fetchStateMessages(table, `${userId}:${sessionId}`);
  return toChatTurns(messages);
}

/**
 * 后端消息 → 页面的一轮轮对话。
 *
 * <h2>只认 USER / ASSISTANT 两种角色</h2>
 * TOOL 是工具结果（约定后端不返回，真返回了也不渲染）、SYSTEM 是系统提示词
 * —— 两者都不是"对话"，画成气泡会让人以为那是模型说的话。
 *
 * <h2>为什么工具名挂在 activity 上</h2>
 * {@link ChatTurn} 没有"工具清单"这一栏，而 activity 那一行本来就是"这一轮它动过什么"
 * 的位置（流式时显示"正在调用 xxx"，结束后清空）。历史轮次不会再收到任何帧，
 * 所以借它显示"调用过 a、b"是安全的，不用为此给领域模型加一个只在历史里用到的字段。
 *
 * <h2>id 为什么是 h-N</h2>
 * 新对话的 id 由 useChat 的计数器发（u-N / a-N），两者都只是 v-for 的 key，
 * 只要**同一次列表里唯一**即可。历史轮次整批替换 turns，所以从头编号不会撞。
 */
export function toChatTurns(messages: StateMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    const role = (message.role || '').toUpperCase();
    if (role === 'USER') {
      turns.push({
        id: `h-${turns.length}`,
        role: 'user',
        text: message.text,
        // 用户那条没有思考过程。两个思考字段给"已收起 + 视作已被动过"，
        // 与 useChat 里新发一条用户消息时的取值保持一致。
        thinking: '',
        thinkingOpen: false,
        thinkingTouched: true,
        activity: '',
        runId: '',
        status: 'done',
        error: '',
      });
      continue;
    }
    if (role !== 'ASSISTANT') continue;
    // 只有 tool_use 的中间消息（正文与思考都空）不画：那会是一个空气泡。
    // 它带的信息已经在工具名里，而下一条 assistant 消息会连着正文一起出现。
    if (!message.text && !message.thinking && message.tools.length === 0) continue;
    turns.push({
      id: `h-${turns.length}`,
      role: 'assistant',
      text: message.text,
      thinking: message.thinking,
      // 历史里的思考一律折叠：一条跑了几十轮的长会话全展开能滚出好几屏，
      // 「想看就点开」比「默认铺满」更合适。thinkingTouched 置位是为了
      // 让它不再被自动展开 / 收起那套规则碰到（那些规则只服务于正在流式的那条）。
      thinkingOpen: false,
      thinkingTouched: true,
      activity: toolsHint(message.tools),
      // 历史轮次没有对应的 runId：run 是"一次提问"的坐标，而回放里一条 assistant
      // 消息未必等于一次提问（一次提问里模型可能分多条消息、还夹着工具调用）。
      // 硬塞一个坐标比留空更糟 —— 点进去会是一条不相干的链路。
      runId: '',
      status: 'done',
      error: '',
    });
  }
  return turns;
}

/** 工具名清单 → 一行提示。超过三个只报个数，否则这一行会比正文还长。 */
function toolsHint(tools: string[]): string {
  if (tools.length === 0) return '';
  const head = tools.slice(0, 3).join('、');
  return tools.length > 3 ? `调用过 ${head} 等 ${tools.length} 个工具` : `调用过 ${head}`;
}