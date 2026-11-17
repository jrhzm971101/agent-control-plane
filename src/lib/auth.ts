/*
 * 登录票的读取与续期。
 *
 * 票是**统一门户**（md-portal-homepage）登录时写进 localStorage 的，这里只读 ——
 * 门户与子平台在同一个 origin（同一个 nginx 端口的不同路径前缀），localStorage
 * 天然共享，所以从门户点进 /agent/ 时不需要在 URL 上带任何东西。
 *
 * 两个 KEY 必须与门户的 src/lib/session.ts 保持一致，改一边要改另一边：
 * 对不上的症状是「从门户跳进来满屏 401」，而本地（既没有门户、门禁也关着）
 * 永远复现不了。
 *
 * 这份实现与 md-data-hub 的 src/lib/apiClient.ts 是同一套逻辑（暂时复制，
 * 等第三个前端出现再抽公共包）。在本项目里单独成文件而不是塞进 apiClient：
 * 那边只做传输，这边还要担「平台前缀拼接」，两块混在一起会把
 * 「前缀只在出口补一次」那段注释压得读不动。
 */

/*
 * 联调期总开关：与后端 md.security.enabled 一一对应，一起开一起关。
 *
 * true = 不发 Authorization 头。**不是为了绕过门禁**，而是因为后端即便把路径
 * 全放行，请求里带着一个过期/伪造的票依旧会被拦成 401（实测）——
 * 「鉴权关了还得带着一张正确的票」是本末倒置。
 *
 * 生产必须保持 false（不设即为 false）。本地独立跑 md-agent-bootstrap 时，
 * 若浏览器里还留着门户的旧票，就在 .env.local 里把它打开。
 */
export const AUTH_DISABLED = import.meta.env.VITE_AUTH_DISABLED === 'true';

/** 与门户共用的存储键。改这里必须同时改 md-portal-homepage/src/lib/session.ts。 */
const TOKEN_KEY = 'md.token';
const REFRESH_KEY = 'md.refresh';

/**
 * 换票的来源。留空 = 同源（走入口 nginx 与网关）。
 *
 * 刻意与 VITE_API_BASE 分开：后者是本平台的**业务接口**前缀（部署时是
 * /agent-platform），而换票打的是 iam 的 /api/auth/refresh，不归 agent-platform 管。
 * 混用一个变量会把换票请求发到 /agent-platform/api/auth/refresh，必然 404 ——
 * 而 404 的换票在界面上表现为「票过期后被登出」，看不出是路径拼错了。
 */
const IAM_BASE = import.meta.env.VITE_IAM_BASE ?? '';

export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    // 隐私模式下 localStorage 会抛异常。读不到票就当没登录，
    // 让请求以 401 的形式暴露出来，而不是把整个应用卡在这里。
    return '';
  }
}

function readRefresh(): string {
  try {
    return localStorage.getItem(REFRESH_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeTokens(access: string, refresh: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  } catch {
    // 忽略：存储不可用时仅本次会话生效
  }
}

function clearTokens(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  } catch {
    // 忽略
  }
}

/** 登录票请求头。关闭鉴权时一个都不发。 */
export function authHeaders(): Record<string, string> {
  const token = AUTH_DISABLED ? '' : readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 单飞：并发的多个 401 只会真的换一次票，其余请求等这同一个 Promise。
 *
 * 不做单飞会出事 —— 概览页一屏会同时发好几个查询，每个 401 都去换一次票，
 * 而刷新票是一次一换的：第 2 个开始拿的就是已作废的旧刷新票，会命中 iam 的
 * 重放检测，把整条票链作废，好端端地把用户踢下线。
 */
let renewing: Promise<string | null> | null = null;

export function renewSession(): Promise<string | null> {
  if (!renewing) {
    renewing = doRenew().finally(() => {
      renewing = null;
    });
  }
  return renewing;
}

/** /api/auth/refresh 的响应体（md-iam 的 R<TokenResp>）。 */
interface TokenRespBody {
  code?: number;
  data?: { token?: string; refreshToken?: string };
}

/** 换票。@returns 新的访问票；换不到返回 null（票已失效、或只是网络抖动）。 */
async function doRenew(): Promise<string | null> {
  const current = readRefresh();
  if (!current) return null;

  let text: string;
  try {
    const response = await fetch(`${IAM_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: current }),
    });
    if (!response.ok) {
      // 刷新票也废了（过期 / 已登出 / 判定重放）：清掉，页面回到未登录态。
      clearTokens();
      return null;
    }
    text = await response.text();
  } catch {
    // 网络问题，不是票的问题：原样保留，下一次请求还会再来试。
    return null;
  }

  let body: TokenRespBody | null;
  try {
    body = JSON.parse(text) as TokenRespBody;
  } catch {
    body = null;
  }
  if (!body || body.code !== 0 || !body.data?.token) {
    clearTokens();
    return null;
  }
  // 换票是轮换式的：iam 每次都给一张新的刷新票，必须一起收好。
  writeTokens(body.data.token, body.data.refreshToken || current);
  return body.data.token;
}
