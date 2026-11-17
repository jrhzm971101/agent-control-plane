/*
 * 对话的取数 —— 只有一条通道：POST + SSE 流式响应。
 *
 * 为什么没有 mock 分支：
 * 「对话」这件事的价值就在于它真的打到了 agent；给它造一份假回答，
 * 只能测出前端拼字符串对不对，测不出后端、模型、工具任何一环。
 * 所以这一页始终打真后端，连通性问题是它该暴露的信息（页面会直接显示错误）。
 *
 * 为什么是 fetch 而不是原生 EventSource：EventSource 只能发 GET，
 * 消息正文塞进 query 会撞长度上限。代价是要自己切帧 —— 下面 splitSseFrames
 * 就是这件事，它是个纯函数，单测在 sseFrames.test.ts。
 */
import { apiJson, apiResponse, buildUrl } from '@/lib/apiClient';
import { isChatFrameType, type ChatFrame } from './model';

/** 切出来但还没解析的原始帧。 */
export interface RawSseFrame {
  /** event: 行的值；后端会写，但前端以 data 里的 type 为准。 */
  event: string;
  /** data: 行的值（多行 data 用换行拼回）。 */
  data: string;
}

/**
 * 把缓冲区切成完整帧，并交出尾部残帧。
 *
 * <p>为什么必须返回残帧：网络分片不保证在帧边界上断开，
 * 丢掉尾部就会随机吞掉一帧（表现为「回答中间少一段」），而且几乎无法复现。
 */
export function splitSseFrames(buffer: string): { frames: RawSseFrame[]; rest: string } {
  // SSE 规范允许 \r\n / \n / \r 三种换行；统一成 \n 之后只需处理一种分隔
  const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const frames: RawSseFrame[] = [];
  let rest = normalized;
  let boundary = rest.indexOf('\n\n');
  while (boundary >= 0) {
    const parsed = parseFrame(rest.slice(0, boundary));
    if (parsed) frames.push(parsed);
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

/** 单个帧块 → 原始帧。只有注释（心跳）或没有 data 的块返回 null。 */
function parseFrame(block: string): RawSseFrame | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    // 空行与以冒号开头的行是注释 —— 心跳帧（:keep-alive）就长这样，天然被忽略
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    // 规范：冒号后若紧跟一个空格，那个空格属于分隔符，不属于值
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // id: / retry: 刻意忽略 —— 本接口不支持续传，记住了反而会以为能续
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** 原始帧 → 领域帧。data 不是 JSON、或缺 type / type 不在词表里，都返回 null。 */
export function decodeChatFrame(raw: RawSseFrame): ChatFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    // 单帧解析失败不能抛出：那会把整条流打断，而前面的文本已经渲染出来了
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (!isChatFrameType(type)) return null;
  const payload = (parsed as { data?: unknown }).data;
  const data = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
  return { type, data };
}

/**
 * 发一轮对话，边收边回调。
 *
 * <p>异常一律往外抛（含 HTTP 非 2xx 与网络中断）：调用方要区分「agent 报错」
 * 与「请求都没发出去」——前者后端会给 error 帧，后者只有这里能发现。
 * 中途中止（AbortError）也照抛，由调用方按「用户自己按了停止」处理。
 */
export async function streamChat(
  agentId: string,
  message: string,
  sessionId: string,
  userId: string,
  onFrame: (frame: ChatFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await apiResponse(buildUrl(`/api/agents/${encodeURIComponent(agentId)}/chat`), {
    method: 'POST',
    // sessionId 为空时整个字段省略，交给后端现生成并在 run 帧里回执；
    // userId 同理：省略时后端用它自己的默认用户，实际生效的值仍会写在 run 帧回执里。
    // 用条件展开而不是先建对象再逐个赋值：字段只有两三个时这样读起来更像"请求体长什么样"。
    body: JSON.stringify({
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(userId ? { userId } : {}),
    }),
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.body) throw new Error('对话流没有响应体');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = splitSseFrames(buffer);
    buffer = rest;
    for (const raw of frames) {
      const frame = decodeChatFrame(raw);
      if (frame) onFrame(frame);
    }
  }
}

/** 下拉里要用的字段；只是列表的一个投影，不是后端的响应形状。 */
export interface ChatAgent {
  /** 运行时 / 路由键 —— 传给接口、放进 URL 的都是它。 */
  name: string;
  /** 展示名 —— 下拉里给人看的是它；缺了它会退回 name（见 fetchChatAgents）。 */
  displayName: string;
  type: string;
}

/**
 * 可对话的 agent 列表。
 *
 * <p><b>必须做一次映射，不能直接声明成后端的响应形状</b>：本页打的是
 * {@code GET /api/agents}，控制面重构后它返回的是 {@code AgentRow[]
 * （agentName / agentType + 引用清单 + 是否已装配）}。早先这里直接把它断言成
 * {@code {name, type}}，于是下拉里两项都是 undefined —— 展开下拉时
 * {@code item.type.toLowerCase()} 会当场抛错，页面被错误边界接住变成白屏，
 * 而"自动选中第一个 agent"也一直是静默失效的（name 是 undefined，
 * 路由参数被当成空值丢掉）。
 *
 * <p>映射放在这一层而不是页面里：调用方只需要"能选的名字 + 类型"，
 * 让它自己从 AgentRow 里挖字段，等于每个消费点都要知道一遍后端的列名。
 */
export async function fetchChatAgents(): Promise<ChatAgent[]> {
  const rows = await apiJson<Array<{ agentName: string; displayName: string; agentType: string }>>(
    buildUrl('/api/agents'),
  );
  // 不在这里按类型过滤：HARNESS 与 REACT 都能被 /api/agents/{id}/chat 调到，
  // 能不能对话由后端 hasAgent 说话，前端多做一次筛选只会让"下拉里没有"变成难查的谜。
  //
  // displayName 用 `|| agentName` 兜底而不是直接用：这一页是"用户随手打开就用"的入口，
  // 数据里的空洞（历史行没回填展示名）不该表现成一个没有名字的下拉项 ——
  // 那会让人以为列表坏了，而不是"这个 agent 少了展示名"。
  return rows.map((row) => ({
    name: row.agentName,
    displayName: row.displayName || row.agentName,
    type: row.agentType,
  }));
}
