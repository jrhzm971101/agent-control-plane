/*
 * 对话的领域模型。
 *
 * 与 features/traces 的分工：那边描述「一次执行是怎么跑的」（观测），
 * 这边描述「我说了什么、它回了什么」（使用）。两者都从 agent 的事件流来，
 * 但一个要画调用树、一个要拼文本，字段没有任何交集，所以不共用类型。
 */

/**
 * 后端帧类型词表 —— 与 md-agent-platform 的 ChatStreamEvent 常量逐条对应。
 * 这里写死而不是用 string，是为了让 switch 分支漏一个时编译期就报出来。
 */
export type ChatFrameType = 'run' | 'delta' | 'thinking' | 'tool' | 'done' | 'error';

/** 一帧。data 里放什么由 type 决定，各分支见 features/chat/api.ts 的注释。 */
export interface ChatFrame {
  type: ChatFrameType;
  data: Record<string, unknown>;
}

/** 一轮对话里的一条消息。assistant 那条是「边收边长」的，所以带状态。 */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  /** 已经到达的正文：由 delta 帧顺序拼接而成，不做任何重排或去重。 */
  text: string;
  /** 思考增量，与正文分开存。页面默认不展示，但留着便于以后折叠显示。 */
  thinking: string;
  /**
   * 思考区是不是展开的。
   *
   * 初值给 true：思考刚来时它是页面上唯一有动静的东西，折叠着等于什么都没显示。
   * 正文一开始到达就自动收起（见 useChat.ts 的 autoCollapseThinking）——
   * 「思考收起、正文展开」这个动作本身就是个界面信号：开始答了。
   */
  thinkingOpen: boolean;
  /**
   * 用户是否手动点过思考区的折叠头。
   *
   * 点过之后自动展开 / 收起一律让位。用户刚手动展开又被页面自动收回去，
   * 那种「点了没用」的感觉比自动收起本身更糟 —— 所以要多记一个「他动过手了」。
   */
  thinkingTouched: boolean;
  /** 进行中的动作提示（如「正在调用 k8s_check」）；空串表示当前没有动作。 */
  activity: string;
  /**
   * 这次提问对应的一次执行（run）的 id；空串表示还没收到 run 帧。
   *
   * 后端在受理请求时就定下它并随首帧回执，中间件用的是同一个值，
   * 所以它直接就是执行链路详情页的地址参数 —— 页面上「去看这条是怎么跑的」不用再做查询。
   * 只挂在 assistant 那条上：run 是 agent 的一次执行，用户消息本身没有。
   */
  runId: string;
  /** streaming = 还没收到 done 帧。 */
  status: 'streaming' | 'done' | 'error';
  /** 失败摘要；status 不是 error 时为空串。 */
  error: string;
}

const FRAME_TYPES: readonly string[] = ['run', 'delta', 'thinking', 'tool', 'done', 'error'];

/** 词表外的帧一律丢弃：前后端版本错位时，宁可少渲染一帧，也不要渲染出乱码。 */
export function isChatFrameType(value: unknown): value is ChatFrameType {
  return typeof value === 'string' && FRAME_TYPES.includes(value);
}

/**
 * 控制台自己的用户标识 —— 页面对话默认以这个身份发起。
 *
 * 为什么不干脆不传、让后端填默认值：后端按 (userId, sessionId) 两维分区记忆
 * （状态存储里两者拼成同一个键，userId 不同就是另一份上下文）。
 * 前端显式传出去有两个好处：一是「页面发起的对话」与企微 / 飞书来的天然分开，
 * 不会共用同一份记忆；二是这个值会写在 run 帧回执里、显示在页头，
 * 排查时一眼认出这条对话是谁发起的。
 *
 * 与后端 ChatStreamService 的默认用户常量取值一致。等接入登录后，
 * 把这里换成登录用户的 id 即可 —— 调用方传的是「本次请求用哪个用户」，
 * 换数据源不需要改流式解析那一层。
 */
export const CONSOLE_USER_ID = 'console';
