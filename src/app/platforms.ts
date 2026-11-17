/*
 * 子平台目录 —— 顶栏「切换平台」弹窗与「返回统一门户」按钮的唯一数据源。
 *
 * <h2>一、为什么在前端写死一份</h2>
 * 这份数据在服务端是有出处的：一体化平台的 md_iam.platform 表
 * （code / name / home_path / api_prefix / status / sort）。门户首页的卡片读的同样是它，
 * 但门户那边也把目录写死在前端（见 md-portal-homepage/src/lib/platforms.ts 的文件头），
 * 因为 iam 还没有 GET /api/platforms 这个接口。
 *
 * 本文件与门户那份**逐条对齐**：同样的三条、同样的 code（admin / agent / data）、
 * 同样的 name、同样的 VITE_*_URL 覆盖 + 路径兜底。两边同时写死是可以接受的，
 * 两边写得不一样不行 —— 那会让"从门户点进 Agent 平台、再切到数据平台"这条路径
 * 出现两个地址，而地址不一致的问题只会在切换的那一刻暴露。等 iam 出了接口，
 * 两边各自把这份常量换成一次请求即可，字段名不用改。
 *
 * <h2>二、为什么跳转是整页跳转而不是 vue-router</h2>
 * 这三个是**不同的前端应用**，各有自己的 router 与 history。vue-router 只认自己
 * 注册过的那张路由表，push 一个别的应用的路径，结果是落到本应用的兜底路由（白屏或 404），
 * 而不是"跳过去"。跨应用只有 window.location.assign 这一种做法。
 *
 * <h2>三、地址为什么是相对路径</h2>
 * 生产上三个平台与门户同域：同一个 nginx 端口下的不同路径前缀
 * （platform.home_path 就是这些前缀，见 .env.deploy 的注释）。
 * 既然同域，相对路径天然就对了，而且换域名不用改代码。
 * 换端口 / 换域名时用 VITE_DATA_URL 这类环境变量覆盖。
 */

export interface PlatformEntry {
  /** 与 md_iam.platform.code、以及门户 platforms.ts 的 code 对齐。 */
  code: string;
  name: string;
  /** 英文名，门户卡片上做小字用的那一行，这里用作条目上的小字。 */
  en: string;
  /** 一句话说明这个平台管什么。文案与门户逐字相同，见文件头"逐条对齐"。 */
  desc: string;
  /** 页面地址（含尾斜杠）。 */
  path: string;
  /** 是不是当前这个平台：是的话弹窗里禁用它并打上「当前」。 */
  current?: boolean;
}

/**
 * 统一门户的地址。
 *
 * <p>门户不在任何一级路径前缀里 —— 它的 home_path 就是 {@code /}，所以兜底值也是 /。
 * 本地 vite dev 时本应用的 base 同样是 /，两者会重合，见 {@link portalIsSelf}。
 */
export const PORTAL_URL: string = (import.meta.env.VITE_PORTAL_URL ?? '').trim() || '/';

/**
 * 三个子平台。顺序与门户首页一致（数据平台 → Agent 平台 → 行政管理平台），
 * 用户在两处看到的是同一个排列。
 */
export const PLATFORMS: PlatformEntry[] = [
  {
    code: 'data',
    name: '数据平台',
    en: 'DataHub',
    desc: '指标字典、核心指标监控与数据异常报警。口径与血缘都记在这一处。',
    path: (import.meta.env.VITE_DATA_URL ?? '').trim() || '/data/',
  },
  {
    code: 'agent',
    name: 'Agent 智能平台',
    en: 'Agent Platform',
    desc: 'Agent 编排与工具接入，把重复的分析动作沉淀成可复用的智能体。',
    // 当前所在的平台。地址同样留了覆盖口子：本平台被部署到别的前缀时要跟着改。
    path: (import.meta.env.VITE_AGENT_URL ?? '').trim() || '/agent/',
    current: true,
  },
  {
    code: 'admin',
    name: '行政管理平台',
    en: 'Admin Platform',
    desc: '账号、角色与平台成员管理，以及跨平台的操作审计。',
    path: (import.meta.env.VITE_ADMIN_URL ?? '').trim() || '/admin/',
  },
];

/**
 * 门户地址是不是就等于本应用的根路径 —— 也就是「这个部署里没有独立门户」。
 *
 * <p>本地 vite dev 时本应用挂在 /（VITE_PUBLIC_PATH 只在 .env.deploy 里设了 /agent/），
 * 而门户地址没配时兜底也是 /，两者重合；部署产物里 base 是 /agent/、门户是 /，正常分开。
 * 想让本地也指到真门户，在 .env.local 里设 VITE_PORTAL_URL 即可。
 *
 * <p><b>它只用来改文案，不用来禁用任何按钮。</b>
 * 曾经按它把「返回统一门户」禁掉过，结果是顶栏常驻一颗永久灰着的按钮 ——
 * 那比"点了之后没跳远"更像坏了：灰是在渲染前就宣告此路不通，
 * 而通不通取决于部署形态，用户看不到那个条件。现在照跳，只在 title 里说明目标。
 */
export const portalIsSelf: boolean = PORTAL_URL === (import.meta.env.BASE_URL || '/');

/** 除了当前平台以外的平台 —— 弹窗里只列它们。 */
export function otherPlatforms(): PlatformEntry[] {
  return PLATFORMS.filter((item) => !item.current);
}