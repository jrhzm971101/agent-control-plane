/*
 * 对话状态机的单测。
 *
 * 为什么把 streamChat 换成可控的假实现，而不是打真后端：
 * 这一层要钉的是「一串帧进来之后，页面状态该长成什么样」——
 * 尤其是思考区的自动展开 / 收起，它依赖「帧到达的顺序」这个时序。
 * 真后端每次回答的内容与时序都不一样，靠它测不出「正文首字到达时思考区必须收起」
 * 这种确定性规则；而假实现可以把帧捏在手里，一条一条地喂。
 *
 * 真后端联调由页面本身承担（本项目的对话页始终打真后端，没有 mock 开关）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

/*
 * 帧的投放窗口。
 *
 * 假实现不自己回放帧，而是把 onFrame 交出来（emit），由用例决定什么时候喂哪一帧 ——
 * 这样才能在「流还没结束」的中间态上做断言。hold() 是让流正常收口，
 * 不调用的话 send() 会一直挂着。
 */
const harness = vi.hoisted(() => ({
  emit: null as null | ((frame: unknown) => void),
  hold: null as null | (() => void),
  /** 让这一轮对话以失败收场（用例决定失败原因），用来验错误文案的落点。 */
  fail: null as null | ((cause: unknown) => void),
}));

vi.mock('./api', () => ({
  streamChat: (
    _agentId: string,
    _message: string,
    _sessionId: string,
    _userId: string,
    onFrame: (frame: unknown) => void,
    signal?: AbortSignal,
  ) => new Promise<void>((resolve, reject) => {
    harness.emit = onFrame;
    harness.hold = resolve;
    harness.fail = reject;
    signal?.addEventListener('abort', () => {
      const aborted = new Error('aborted');
      aborted.name = 'AbortError';
      reject(aborted);
    });
  }),
}));

/*
 * 会话回放的取数也换成可控的假实现，理由与上面那条一样：
 * 这一层要钉的是"点开一条历史会话之后，会话状态该长成什么样"，
 * 而不是"后端那个接口通不通"。取数与映射本身的正确性由 history.test.ts 与
 * routes.smoke.test.ts 的端到端那条覆盖。
 */
const historyHarness = vi.hoisted(() => ({
  load: null as null | ((agentId: string, userId: string, sessionId: string) => Promise<ChatTurn[]>),
  calls: [] as Array<[string, string, string]>,
}));

vi.mock('./history', () => ({
  loadConversation: (agentId: string, userId: string, sessionId: string) => {
    historyHarness.calls.push([agentId, userId, sessionId]);
    return historyHarness.load!(agentId, userId, sessionId);
  },
}));

import { ApiError } from '@/lib/apiClient';
import { useChat } from './useChat';
import type { ChatFrame, ChatFrameType, ChatTurn } from './model';

function frame(type: ChatFrameType, data: Record<string, unknown> = {}): ChatFrame {
  return { type, data };
}

/*
 * 每个用例用一个新 agentId。
 * 会话仓库是模块级的（切 agent 要能切回来，见 useChat.ts 的说明），
 * 所以同一个 agentId 在用例之间会留状态 —— 换 id 比清理更不容易漏。
 */
let agentSeq = 0;
function newAgent(): string {
  agentSeq += 1;
  return `agent-${agentSeq}`;
}

/** 起一轮对话但不等它结束，把控制权交回用例。 */
async function startTurn(agentId: string) {
  const chat = useChat(() => agentId);
  const pending = chat.send('你好');
  await nextTick();
  return { chat, pending };
}

/** 喂一帧并等 Vue 把响应式更新刷完。 */
async function feed(f: ChatFrame): Promise<void> {
  harness.emit?.(f);
  await nextTick();
}

function reply(chat: ReturnType<typeof useChat>): ChatTurn {
  const turn = chat.turns.value.find((t) => t.role === 'assistant');
  if (!turn) throw new Error('没有 assistant 消息');
  return turn;
}

describe('useChat 帧落地', () => {
  it('run 帧回填会话键、生效用户与 runId', async () => {
    const { chat, pending } = await startTurn(newAgent());
    await feed(frame('run', {
      sessionId: 'console-abc', userId: 'console', runId: 'mub0hii7-psy1xp',
    }));

    expect(chat.sessionId.value).toBe('console-abc');
    expect(chat.userId.value).toBe('console');
    expect(reply(chat).runId).toBe('mub0hii7-psy1xp');

    harness.hold?.();
    await pending;
  });

  it('思考增量累加到 thinking，且思考区一开始是展开的', async () => {
    const { chat, pending } = await startTurn(newAgent());
    await feed(frame('thinking', { text: '先看' }));
    await feed(frame('thinking', { text: '再看' }));

    const turn = reply(chat);
    expect(turn.thinking).toBe('先看再看');
    // 正文还没来，思考是页面上唯一有动静的东西，折叠着等于什么都不显示
    expect(turn.thinkingOpen).toBe(true);

    harness.hold?.();
    await pending;
  });

  it('正文首字到达时思考区自动收起', async () => {
    const { chat, pending } = await startTurn(newAgent());
    await feed(frame('thinking', { text: '先看' }));
    await feed(frame('delta', { text: '答案' }));

    expect(reply(chat).thinkingOpen).toBe(false);

    harness.hold?.();
    await pending;
  });

  /*
   * 这条是「用户动手了」的分支：他刚把思考区展开，正文就在这时开始到达。
   * 自动规则必须让位，否则页面会在用户眼皮底下把他刚展开的东西收回去 ——
   * 那种「点了没用」的感觉比自动收起本身更糟。
   */
  it('用户手动展开过的思考区，正文到达也不会被自动收起', async () => {
    const { chat, pending } = await startTurn(newAgent());
    await feed(frame('thinking', { text: '先看' }));

    const turn = reply(chat);
    // 模拟点击折叠头：先把自动收起触发一次（让它变成收起态），再手动展开
    turn.thinkingTouched = true;
    turn.thinkingOpen = true;

    await feed(frame('delta', { text: '答案' }));

    expect(turn.thinkingOpen).toBe(true);

    harness.hold?.();
    await pending;
  });

  it('done 帧即使没有正文也会收起思考区', async () => {
    const { chat, pending } = await startTurn(newAgent());
    await feed(frame('thinking', { text: '想完就停了' }));
    await feed(frame('done', { status: 'DONE' }));

    const turn = reply(chat);
    expect(turn.status).toBe('done');
    expect(turn.thinkingOpen).toBe(false);

    harness.hold?.();
    await pending;
  });
});

describe('useChat 动作提示', () => {
  it('tool 帧给活动提示，delta 到达后清掉', async () => {
    const { chat, pending } = await startTurn(newAgent());
    await feed(frame('tool', { name: 'k8s_check', phase: 'start' }));
    expect(reply(chat).activity).toBe('正在调用 k8s_check…');

    await feed(frame('delta', { text: '好了' }));
    expect(reply(chat).activity).toBe('');

    harness.hold?.();
    await pending;
  });

  /*
   * 思考帧不再写活动提示 —— 内容已经在页面上滚了，再说一句「思考中…」是同一件事说两遍，
   * 还会占掉「正在调用 xxx」那行。真空白的兜底由页面按 turn 的空闲状态给（ChatPage 的 idleHint）。
   */
  it('thinking 帧不写活动提示', async () => {
    const { chat, pending } = await startTurn(newAgent());
    await feed(frame('thinking', { text: '在想' }));

    expect(reply(chat).activity).toBe('');

    harness.hold?.();
    await pending;
  });
});

describe('useChat 错误文案', () => {
  /*
   * 文案必须来自后端。
   *
   * 为什么值得钉：页面把后端 error 字段当唯一真相（见 apiClient 的 readApiFailure），
   * 前端一旦按状态码另写一套"404 = agent 不存在"，后端改文案前端不跟，
   * 而且猜错时会把排查方向带偏 —— 真发生过一次：新建 agent 没热装配，
   * 页面显示"agent 不存在或未装配"，看着像请求发错了地方。
   */
  it('404 时直接显示后端给的那句话，不按状态码另写一套', async () => {
    const agent = newAgent();
    const { chat, pending } = await startTurn(agent);
    const backend = `agent 不存在或未装配: ${agent}（到 Agent 列表确认它已发布，或点一次「重载」）`;

    harness.fail?.(new ApiError(backend, 404, { error: backend }));
    await pending;

    const turn = reply(chat);
    expect(turn.status).toBe('error');
    expect(turn.error).toBe(backend);
  });

  it('后端没给文案（网络层失败）时落回 Error 自带的那句', async () => {
    const { chat, pending } = await startTurn(newAgent());

    harness.fail?.(new TypeError('Failed to fetch'));
    await pending;

    expect(reply(chat).error).toBe('Failed to fetch');
  });
});

describe('useChat 停止', () => {
  it('用户按停止不算失败：已有内容保留，状态归 done', async () => {
    const { chat, pending } = await startTurn(newAgent());
    await feed(frame('delta', { text: '半截回答' }));

    chat.stop();
    await pending;

    const turn = reply(chat);
    expect(turn.text).toBe('半截回答');
    expect(turn.status).toBe('done');
    expect(turn.error).toBe('');
    expect(chat.sending.value).toBe(false);
  });
});

/** 造一条回放用的历史消息（字段值按 features/chat/history.ts 的约定给全）。 */
function histTurn(id: string, role: 'user' | 'assistant', text: string): ChatTurn {
  return {
    id, role, text, thinking: '', thinkingOpen: false, thinkingTouched: true,
    activity: '', runId: '', status: 'done', error: '',
  };
}

describe('useChat 打开历史会话', () => {
  beforeEach(() => {
    historyHarness.calls.length = 0;
    historyHarness.load = null;
  });

  it('会话键与生效用户换成这条会话的，并把历史铺上来', async () => {
    const agent = newAgent();
    historyHarness.load = async () => [
      histTurn('h-0', 'user', '帮我查工时'),
      histTurn('h-1', 'assistant', '好的'),
    ];
    const chat = useChat(() => agent);

    await chat.openSession('wo7U1', 'single-abc');

    // 请求里的两个标识就是 run 表里的两列原值 —— 原样带回去才会落到同一个记忆分区
    expect(historyHarness.calls).toEqual([[agent, 'wo7U1', 'single-abc']]);
    expect(chat.sessionId.value).toBe('single-abc');
    expect(chat.userId.value).toBe('wo7U1');
    expect(chat.turns.value.map((t) => t.text)).toEqual(['帮我查工时', '好的']);
    expect(chat.loadingHistory.value).toBe(false);
  });

  it('读历史失败时保留会话键，只把原因挂到页面级 error 上', async () => {
    const agent = newAgent();
    historyHarness.load = async () => {
      throw new Error('状态表不存在');
    };
    const chat = useChat(() => agent);

    await chat.openSession('wo7U1', 'single-abc');

    /*
     * 会话键必须留着：读取失败只说明"上下文看不到"，不说明"不能接着聊"。
     * 回滚会话键会把"接着聊"一起弄丢，那才是用户真正要做的事。
     */
    expect(chat.sessionId.value).toBe('single-abc');
    expect(chat.error.value).toBe('状态表不存在');
    expect(chat.loadingHistory.value).toBe(false);
  });

  it('连点两条会话时以最后点的那条为准，先发的那次结果作废', async () => {
    const agent = newAgent();
    const resolvers: Array<(turns: ChatTurn[]) => void> = [];
    historyHarness.load = () =>
      new Promise<ChatTurn[]>((resolve) => {
        resolvers.push(resolve);
      });
    const chat = useChat(() => agent);

    const first = chat.openSession('u1', 's1');
    // 加载中的状态要让页面能看出来（它挡发送按钮，也决定消息区显示"正在读取"）
    expect(chat.loadingHistory.value).toBe(true);

    const second = chat.openSession('u2', 's2');

    // 后点的先回来
    resolvers[1]([histTurn('h-0', 'assistant', '第二条')]);
    await second;
    // 先点的后回来 —— 它不该覆盖上面那条
    resolvers[0]([histTurn('h-0', 'assistant', '第一条')]);
    await first;

    expect(chat.sessionId.value).toBe('s2');
    expect(chat.turns.value.map((t) => t.text)).toEqual(['第二条']);
    expect(chat.loadingHistory.value).toBe(false);
  });

  it('会话键缺一段就不发请求（run 表里 user_id 为 NULL 的会话就是这种）', async () => {
    const agent = newAgent();
    historyHarness.load = async () => [];
    const chat = useChat(() => agent);

    await chat.openSession('', 'single-abc');

    expect(historyHarness.calls).toEqual([]);
    expect(chat.sessionId.value).toBe('');
  });
});