/*
 * 统一传输层。所有 api/* 模块只能通过这里发请求，
 * 便于以后统一加鉴权、重试、埋点（对齐官方 frontend/src/lib/apiClient.ts）。
 */
import { authHeaders, renewSession } from './auth';

export class ApiError extends Error {
  readonly status: number;

  /**
   * 后端返回的结构化错误体（原样保留）。
   *
   * 控制面的删除保护会回 409 + { error, referencingAgents } —— 页面要列出
   * 「还有谁在引用它」，才能在用户点确认前给出可执行的下一步。只留一句 message
   * 会让页面只能干说"删不掉"，所以这里把整个 body 一起带上。
   */
  readonly detail: unknown;

  constructor(message: string, status: number, detail: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * 平台接口前缀。它是**部署形态**的一部分，不是接口契约的一部分。
 *
 * <p>一体化平台（md-admin-platform）的约定是「一个后端服务占一个与它同名的一级路径」：
 * agent 服务的 context-path 就是 /agent-platform，网关 md-gateway 的路由
 * （{@code Path=/agent-platform/**}）**原样转发、不做 StripPrefix**，所以前端发出去的
 * 每条请求都得自己带上这一段 —— 少一段就是 404，而页面只会显示一张错误卡片，
 * 看不出是"路径少了一截"还是"后端没实现"。
 *
 * <p>本地独立跑后端（md-agent-bootstrap，端口 9090，接口根还是 /api）时，
 * .env.local 里留空即可：空串会让下面所有拼接退化成"直接打后端根路径"，
 * 也就是这个字段出现之前的行为。
 *
 * <p>末尾斜杠在这里统一削掉。配置里多写一个 `/`（`/agent-platform/`）会拼出
 * `/agent-platform//api/...`：多数网关能容忍双斜杠，但 Spring 的路由匹配不一定，
 * 而这种错只在部署环境出现、本地永远复现不了 —— 在配置层面消灭掉比出问题时排查便宜。
 *
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').trim().replace(/\/+$/, '');

/**
 * 给「相对后端根」的路径补上平台前缀。
 *
 * <p><b>为什么拼接挂在 apiResponse 而不是 buildUrl</b>：请求最终只有一个出口
 * （apiResponse 里的那次 fetch）。把前缀挂在这个出口上，任何一条新写的请求 ——
 * 包括直接消费原始 Response 的 SSE 订阅 —— 都自动带上前缀，不需要每个调用点
 * 记得先调一次 buildUrl。反过来（前缀写在 buildUrl 里）只要有人漏调一次，
 * 就会在部署环境里凭空少一段前缀，而本地（前缀为空）完全看不出异常。
 * 这不是假想的风险：执行链路的 SSE 订阅（features/traces/api.ts）就漏了 buildUrl，
 * 本地一直正常，一带前缀就会 404。
 *
 * <p><b>幂等</b>：已经带了前缀的路径不再重复拼，重复调用也不会拼出
 * `/agent-platform/agent-platform/api/...`。
 *
 * <p>base 参数只为可测性而存在（API_BASE 是模块级常量，测试改不动它），
 * 业务代码一律用默认值。
 */
export function withApiBase(path: string, base: string = API_BASE): string {
  if (!base) return path;
  if (path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * 拼查询串。返回值是「相对后端根」的路径 —— 平台前缀由 apiResponse 统一补
 * （见 withApiBase 的说明），这里刻意不再拼一次。
 */
export function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function apiResponse(path: string, init?: RequestInit): Promise<Response> {
  return apiResponseOnce(path, init, true);
}

async function apiResponseOnce(
  path: string,
  init: RequestInit | undefined,
  allowRenew: boolean,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  // 登录票挂在这个出口上，和前缀同一个理由：SSE 订阅、直连拿 Response 的调用
  // 都自动带上票，不用每个调用点记得加一次。
  for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // 前缀在这里补，且只在这里补：调用方一律只写「相对后端根」的路径。
  const response = await fetch(withApiBase(path), { ...init, headers });

  /*
   * 401：票不能用了，换一张再原样重放一次。
   *
   * 只重放一次 —— 重放回来还是 401，说明问题不在票上（比如这个账号没有被授权
   * 进智能体平台，网关会拿 platforms 认领判定后回 403/401），再换下去就是死循环。
   * 换不回来票时不再重放，直接走下面的报错，页面显示 401 而不是无限重试。
   */
  if (response.status === 401 && allowRenew) {
    const renewed = await renewSession();
    if (renewed) return apiResponseOnce(path, init, false);
  }

  if (!response.ok) {
    const failure = await readApiFailure(response);
    throw new ApiError(failure.message, response.status, failure.detail);
  }
  return response;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiResponse(path, init);
  return (await response.json()) as T;
}

/**
 * 解析失败响应：优先读后端 { error } / { message }，回落到状态文本。
 *
 * 返回 message 与原始 body 两份：调用方要展示的就用 message，
 * 要据此分支（如 409 的引用清单）的就用 detail。响应体只能读一次，
 * 所以两件事必须在同一个函数里做完。
 */
async function readApiFailure(response: Response): Promise<{ message: string; detail: unknown }> {
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof body.error === 'string' && body.error) return { message: body.error, detail: body };
      if (typeof body.message === 'string' && body.message) {
        return { message: body.message, detail: body };
      }
      return { message: `请求失败 (${response.status})`, detail: body };
    } catch {
      if (text.length < 400) return { message: text, detail: null };
    }
  }
  return { message: `请求失败 (${response.status})`, detail: null };
}

/** 只要一句可展示的文案时用这个。 */
export async function readApiError(response: Response): Promise<string> {
  return (await readApiFailure(response)).message;
}
