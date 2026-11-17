/*
 * 概览（GET /api/overview）。
 *
 * 这一屏的每个数字都来自<b>同一个时刻</b>的一次请求，所以整个载荷只有一个端点：
 * 拆成多个端点不仅做不到原子性，还会让页面自己去做 join —— 于是
 * 「Agent 14 个、已发布 15 个」这种自相矛盾的画面迟早会出现。
 *
 * 三条口径写在这里，页面不许再算一遍：
 *
 * 1. 时间窗口是<b>服务器本地时区</b>的自然日（与 Cron、日志的日报口径一致），
 *    边界由后端算好，前端只负责展示。前端拿本地时区去算「今天」是错的：
 *    两边时区不同时，页面上的"今日"会比后端统计的窗口多一段或少一段。
 *
 * 2. 增量不在这里拼成 "+12%" 这种字符串。后端给的是 today.total 与 yesterdayTotal
 *    两个原始数字，口径（今日 vs 昨日、是否含进行中）留在页面上可见，
 *    而不是藏在一个后端拼好的百分数里。
 *
 * 3. 健康度是「比率」不是「数量」：条形的长度与标签上的数字必须是同一个含义，
 *    否则 122 个工具画成满格、3/4 个 MCP 也画成满格，读者无法比较。
 */
import { apiJson, buildUrl } from '@/lib/apiClient';
import type { RunSummary } from './types';

/** Agent 数量与生命周期分布。 */
export interface AgentStats {
  total: number;
  harness: number;
  react: number;
  /** 发布过至少一次的（publishedVersion != null）。 */
  published: number;
  enabled: number;
}

/** 能力资源规模。mcpServers 是条目数（不是工具数），本地工具数由容器扫 bean 得出。 */
export interface ToolStats {
  local: number;
  mcpServers: number;
  mcpEnabled: number;
}

/**
 * 今日执行情况。
 *
 * yesterdayTotal 是昨日同一口径的执行次数：页面用它自己算增量 ——
 * 这样"涨了多少"这件事的分子分母都摆在明面上。
 */
export interface ExecutionStats {
  total: number;
  success: number;
  failed: number;
  running: number;
  yesterdayTotal: number;
}

/** 今日耗时。窗口内没有执行时 averageMs/p95Ms 都是 0，页面据 total === 0 显示「—」。 */
export interface LatencyStats {
  averageMs: number;
  p95Ms: number;
  /** 单次最慢的 agent 名；没有执行时为 null。 */
  slowestAgent: string | null;
  slowestMs: number;
}

/** 今日 token 与缓存命中率（命中 token / 输入 token；输入为 0 时是 '0%'）。 */
export interface TokenStats {
  today: number;
  /** 已经是带百分号的字符串（后端算好的），页面不要再换算。 */
  cacheHitRate: string;
}

/** 模型规模。defaultKey 为 null 表示走 application.yml 的兜底 Bean —— 页面上要如实显示。 */
export interface ModelStats {
  total: number;
  enabled: number;
  defaultKey: string | null;
}

/** 指标卡的全部数据。 */
export interface OverviewMetrics {
  agents: AgentStats;
  tools: ToolStats;
  executionsToday: ExecutionStats;
  latency: LatencyStats;
  tokens: TokenStats;
  models: ModelStats;
}

/** 健康度条形图的一行：ratio 用于画条，value 是人读的「12 / 14」。 */
export interface HealthBar {
  label: string;
  ratio: number;
  value: string;
}

/**
 * 「需要关注」的一条。
 *
 * tone 只有 err / wait 两种（与后端规则一一对应）：err 是"现在就是坏的"，
 * wait 是"现在没事但埋着雷"。页面不做二次映射，直接喂给 StatusDot。
 */
export interface AttentionItem {
  title: string;
  meta: string;
  detail: string;
  tone: 'err' | 'wait';
}

/**
 * 「最近变更」的一条 —— 来源是版本快照表，也就是<b>发布与回滚</b>事件。
 *
 * 为什么不叫"最近编辑"：保存草稿不写快照，所以这里看不到"谁改了个备注"。
 * 标题写成"最近变更"而内容其实是发布流水，是刻意的取舍 ——
 * 报一个不存在的口径比少一个口径更糟。
 */
export interface ChangeItem {
  subject: string;
  resourceType: string;
  action: string;
  note: string | null;
  atMs: number;
  actor: string | null;
}

/** 概览的整个载荷。runs 与 GET /api/traces 同一形状，点行可直接跳链路详情。 */
export interface Overview {
  metrics: OverviewMetrics;
  health: HealthBar[];
  attention: AttentionItem[];
  changes: ChangeItem[];
  runs: RunSummary[];
  generatedAtMs: number;
}

export async function fetchOverview(): Promise<Overview> {
  return apiJson<Overview>(buildUrl('/api/overview'));
}
