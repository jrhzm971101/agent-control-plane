/*
 * 对话状态机 —— 按 agent 分区。
 *
 * 为什么状态挂在模块级，而不是「每次 useChat() 一份」：
 * 切换 agent 就是切换会话。状态如果跟着组件走，从 A 切到 B 再切回 A，
 * A 的对话就没了 —— 用户会认为「我刚说的话丢了」。
 * 所以这里按 agentId 各存一份，切回来就是原样。
 *
 * 存的是「内存里的当前会话」：刷新页面即丢（落库是后续的事，见
 * docs/develop/2026-09-21_chat-page-and-sse.md 的缺口表）。
 */
import { computed, reactive, watch } from 'vue';
import { streamChat } from './api';
import { loadConversation } from './history';
import { CONSOLE_USER_ID } from './model';
import type { ChatFrame, ChatTurn } from './model';

/** 一个 agent 的会话。 */
interface Conversation {
  /** 后端回执的会话键；空串 = 这个 agent 还没发过第一条。 */
  sessionId: string;
  /**
   * 后端回执的实际用户标识；空串 = 这个 agent 还没发过第一条。
   *
   * 存的是「后端说用了谁」而不是「前端想用谁」：请求里没带时后端会填默认值，
   * 页头显示的必须是那个生效值 —— 拿请求值去显示，等于把后端的回执当摆设。
   */
  userId: string;
  turns: ChatTurn[];
  /**
   * 这个 agent 是不是正在答。
   *
   * 按 agent 分开而不是全局一个开关：A 还在跑的时候切到 B，B 应该能照常问 ——
   * 两条流各写各的会话，不会串（每条流里的回调捕获的是自己那条消息对象）。
   */
  sending: boolean;
  /**
   * 正在取这条历史会话的内容。
   *
   * <p>与 sending 分开：两者都会把"发送"按钮挡住，但页面上要说的话完全不同 ——
   * 一个是"它在回答"，一个是"正在把历史读出来"。合成一个布尔，
   * 页面就只能对着一件正在加载的事说"正在回答"。
   */
  loadingHistory: boolean;
  /** 页面级错误：请求根本没发出去、agent 不存在…… 这类错不属于某一条消息。 */
  error: string;
}

/** agentId 还没确定时（列表正在加载）的兜底对象，只读不可写。 */
const EMPTY: Conversation = {
  sessionId: '', userId: '', turns: [], sending: false, loadingHistory: false, error: '',
};

/*
 * 会话仓库。用 reactive 而不是普通 Map：
 * 普通 Map 里存的对象不会被转成响应式代理，页面读到它变了也不会重新渲染。
 */
const store = reactive<Record<string, Conversation>>({});

function ensure(agentId: string): void {
  if (agentId && !store[agentId]) {
    store[agentId] = {
      sessionId: '', userId: '', turns: [], sending: false, loadingHistory: false, error: '',
    };
  }
}

/*
 * 进行中的请求句柄，按 agent 存。
 * 这样才能做到「停掉这一个 agent 的回答」，而不是把页面上所有流一起掐掉 ——
 * 全局只留一个句柄的话，第二个请求会把第一个的句柄覆盖掉，先发的那条就再也停不下来了。
 */
const controllers = new Map<string, AbortController>();

/*
 * 每个 agent 的"取历史"序号，见 openSession。
 * 它防的是同一栏里连点两条会话时，先发的那次请求后回来、把后点那条的内容覆盖掉。
 */
const openSeq = new Map<string, number>();

/** 自增序号只用于生成消息 key，与后端无关，所以模块级一个计数器就够。 */
let counter = 0;

/**
 * @param agentId 当前 agent 的取值函数（传 ref 或 computed 都行）。
 *                收成函数而不是 Ref<string>：computed 的 value 是只读的，
 *                写成 Ref 参数在某些 Vue 版本的声明下会因为 readonly 而报类型错。
 */
export function useChat(agentId: () => string) {
  /*
   * 先确保对象存在，再让下面的 computed 去读。
   * 顺序很重要：如果让 computed 顺手创建（读的时候写响应式状态），
   * 就会在同一次求值里写回它自己依赖的那个键 —— Vue 里这是要避免的写法。
   * immediate 让它在 setup 期间就跑，渲染时读到的绝不会是 EMPTY。
   */
  watch(agentId, ensure, { immediate: true });

  /** 当前 agent 的会话。agentId 一变，这个 computed 就指向另一个对象。 */
  const conversation = computed(() => store[agentId()] ?? EMPTY);
  const turns = computed(() => conversation.value.turns);
  const sessionId = computed(() => conversation.value.sessionId);
  const userId = computed(() => conversation.value.userId);
  const sending = computed(() => conversation.value.sending);
  const loadingHistory = computed(() => conversation.value.loadingHistory);
  const error = computed(() => conversation.value.error);
  /** 最后一条消息 —— 页面靠它决定要不要跟着滚动到底。 */
  const lastTurn = computed<ChatTurn | undefined>(() => turns.value[turns.value.length - 1]);

  /**
   * 把一帧落到指定会话的指定消息上。
   *
   * <p>会话对象是**参数**而不是从当前 agentId 现取：run 帧会回写会话键，
   * 如果那时候用户已经切到了别的 agent，现取就会把 A 的会话键写到 B 身上
   * （之后 B 的对话会续进 A 的会话记忆里）。这类错只有"发送后立刻切换"才复现，
   * 所以宁可在签名上多传一个参数，也不留下这种依赖当前 UI 状态的隐式前提。
   *
   * <p>字段缺失一律按「没有」处理，不抛错也不渲染 undefined。
   */
  function applyFrame(target: Conversation, turn: ChatTurn, frame: ChatFrame): void {
    switch (frame.type) {
      case 'run': {
        const incoming = text(frame.data.sessionId);
        if (incoming) target.sessionId = incoming;
        // userId 一并记下：它和 sessionId 一起决定这次对话用哪一份记忆（后端按两者合成状态键）
        const effectiveUser = text(frame.data.userId);
        if (effectiveUser) target.userId = effectiveUser;
        // runId 记在「这一条回答」上而不是会话上：一次提问 = 一条 run，
        // 会话里有多少轮就有多少个 run。挂到会话上会让历史答案都指向最后一次执行。
        const runId = text(frame.data.runId);
        if (runId) turn.runId = runId;
        break;
      }
      case 'delta':
        turn.text += text(frame.data.text);
        // 正文一到就把动作提示收掉：两个同时显示会让人以为还在跑
        turn.activity = '';
        // 正文开始了就把思考区收起来（用户手动展开过则不动，见 autoCollapseThinking）
        autoCollapseThinking(turn);
        break;
      case 'thinking':
        turn.thinking += text(frame.data.text);
        /*
         * 这里不再写 turn.activity = '思考中…'。
         *
         * 思考内容自己已经在页面上滚动了，再挂一句「思考中…」是同一件事说两遍；
         * 而且它会占着活动提示那一行，把「正在调用 xxx」这类真信息的位置占掉。
         * 「什么帧都还没来」的那种空白，改由页面按 turn 的空闲状态兜（见 ChatPage 的 idleHint）。
         */
        break;
      case 'tool': {
        const name = text(frame.data.name);
        if (!name) break;
        // 工具结束后如果正文已经来了就不再提示；没来则留一句「已完成」，
        // 让长链路（连续调好几个工具）看起来是在推进而不是卡住
        if (frame.data.phase === 'start') turn.activity = `正在调用 ${name}…`;
        else if (!turn.text) turn.activity = `已完成 ${name}`;
        break;
      }
      case 'done':
        turn.status = frame.data.status === 'ERROR' ? 'error' : 'done';
        turn.activity = '';
        autoCollapseThinking(turn);
        break;
      case 'error':
        turn.status = 'error';
        turn.error = text(frame.data.message);
        turn.activity = '';
        autoCollapseThinking(turn);
        break;
    }
  }

  /**
   * 收起思考区 —— 但只在用户没亲手展开过的时候。
   *
   * 收起的触发点有三处（正文首字到达、done、error），全部收敛到这个函数，
   * 免得三处各写一遍 `if (!thinkingTouched)`，漏一处就会出现「出错时思考区还敞着」
   * 这种只在小概率路径上出现的状态。
   */
  function autoCollapseThinking(turn: ChatTurn): void {
    if (!turn.thinkingTouched) turn.thinkingOpen = false;
  }

  /** 发一轮。空文本与「这个 agent 上一条还没答完」都被静默忽略 —— 双击发送不该发出两条。 */
  async function send(rawText: string): Promise<void> {
    const agent = agentId();
    const content = rawText.trim();
    if (!content || !agent) return;
    ensure(agent);
    const target = store[agent];
    // 上一条还没答完、或历史还没读完，都不发：那种情况下"我这个问题属于哪个会话"
    // 本身就是不确定的（会话键可能正被 openSession 改掉）。
    if (target.sending || target.loadingHistory) return;

    target.error = '';
    target.turns.push({
      id: nextId('u'), role: 'user', text: content,
      // 用户这条没有思考过程，两个思考相关字段给「已收起 + 视作已被动过」，
      // 免得以后有人误判「这条消息的思考区还能自动展开」
      thinking: '', thinkingOpen: false, thinkingTouched: true,
      activity: '', runId: '', status: 'done', error: '',
    });
    target.turns.push({
      id: nextId('a'), role: 'assistant', text: '',
      // 思考区默认展开：先让用户看见有东西在跑，正文来了再自动收
      thinking: '', thinkingOpen: true, thinkingTouched: false,
      activity: '', runId: '', status: 'streaming', error: '',
    });
    // 取出来的是响应式代理，后面所有帧都改这一个对象，不再回头按 id 找
    const reply = target.turns[target.turns.length - 1];

    target.sending = true;
    const controller = new AbortController();
    controllers.set(agent, controller);
    try {
      // 用户标识显式传出去（见 model.ts 的 CONSOLE_USER_ID）：接入登录后换成登录用户的 id
      await streamChat(agent, content, target.sessionId, CONSOLE_USER_ID,
              (frame) => applyFrame(target, reply, frame), controller.signal);
      // 后端正常收口一定会发 done；这里兜的是「流被中间层掐断」的情况
      // （代理超时、后端重启），不兜的话气泡会永远停在生成中。
      if (reply.status === 'streaming') reply.status = 'done';
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        // 用户自己按的停止，不是故障：已收到的内容留在页面上
        reply.status = 'done';
      } else {
        reply.status = 'error';
        reply.error = describe(cause);
      }
    } finally {
      target.sending = false;
      // 只有句柄还是自己时才删：期间可能已经被同一 agent 的下一次请求替换过
      if (controllers.get(agent) === controller) controllers.delete(agent);
      reply.activity = '';
    }
  }

  /** 停止当前 agent 的回答。只掐连接，不清已有内容 —— 想清空用 reset。 */
  function stop(): void {
    controllers.get(agentId())?.abort();
  }

  /**
   * 新对话：清空当前 agent 的消息与会话键。
   *
   * 只清这一个 agent 的：别的 agent 的对话跟这次点击没关系。
   * 会话键一定要清，否则新对话会续进上一个会话的记忆里。
   */
  function reset(): void {
    stop();
    const target = store[agentId()];
    if (!target) return;
    // 作废在途的那次回放：新对话开始了，它不该再往空列表里铺上一个会话的内容
    openSeq.set(agentId(), (openSeq.get(agentId()) ?? 0) + 1);
    target.turns = [];
    target.sessionId = '';
    target.userId = '';
    target.error = '';
    target.loadingHistory = false;
  }

  /**
   * 打开一条历史会话：把会话键换成它，再把当时的对话内容铺上来。
   *
   * <p><b>先 stop() 再改键</b>：这次点击的语义是"换一个会话"，让上一轮的回答继续往
   * 新会话里写字，是这里唯一不可接受的中间态。stop 只掐连接不清内容，
   * 被停掉那条消息的半截正文留在它自己的会话里（切回去还在）。
   *
   * <p>先清空 turns 再 await，而不是等结果回来再一次性替换：否则加载期间页面上
   * 还摆着上一个会话的对话，用户会以为"点了没反应"。
   *
   * <p>userId / sessionId 直接取自 run 表的聚合结果（两个独立列），不需要
   * 从 {@code <userId>:<sessionId>} 拼串里拆 —— 那是状态表的形态，不是 run 表的。
   * 把这两个值原样传回 chat 接口，就会落到同一个记忆分区里，也就是"接着这条会话继续聊"。
   */
  async function openSession(targetUserId: string, targetSessionId: string): Promise<void> {
    const agent = agentId();
    if (!agent || !targetUserId || !targetSessionId) return;
    ensure(agent);
    const target = store[agent];

    /*
     * 这次打开的序号。左栏里连点两条会话是完全可能的，而两次取数的先后
     * **不由点击顺序决定** —— 没有这个序号的话，先点的那条如果后回来，
     * 会把后点那条的内容覆盖掉，页面上表现为"点了 A，显示的是 B"。
     * 只有序号还是最新的那次才允许写回结果（含清 loadingHistory）。
     */
    const seq = (openSeq.get(agent) ?? 0) + 1;
    openSeq.set(agent, seq);

    stop();
    target.sessionId = targetSessionId;
    target.userId = targetUserId;
    target.turns = [];
    target.error = '';
    target.loadingHistory = true;
    try {
      const loaded = await loadConversation(agent, targetUserId, targetSessionId);
      if (openSeq.get(agent) !== seq) return;
      target.turns = loaded;
    } catch (cause) {
      // 读历史失败不是致命错误：会话键已经切过去了，用户仍然可以直接接着聊。
      // 所以只把原因挂到页面级错误上，不把状态回滚 —— 回滚会让"接着聊"也没了。
      if (openSeq.get(agent) !== seq) return;
      target.error = describe(cause);
    } finally {
      if (openSeq.get(agent) === seq) target.loadingHistory = false;
    }
  }

  return {
    turns, sessionId, userId, sending, loadingHistory, error, lastTurn,
    send, stop, reset, openSession,
  };
}

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** 帧字段是 unknown，取值统一过这里，省掉满屏的 as string。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 把异常翻成人能看的一句话。
 *
 * 直接用 `cause.message`：后端的失败响应体里已经写清了原因（哪个 agent 不存在、
 * 消息为什么被拒），apiClient 的 readApiFailure 会把它读成 ApiError.message。
 * 这里再按状态码猜一遍就是两处维护 —— 后端改文案前端不跟，而且猜错了会把排查
 * 方向带偏（这条文案原先就把"新建 agent 没热装配"显示成了"agent 不存在或未装配"，
 * 看着像请求发错了地方）。ApiError 继承自 Error，所以一个分支就够。
 */
function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
