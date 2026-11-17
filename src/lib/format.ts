/** 展示层格式化：所有页面的耗时 / 用量 / 时间都走这里，保证口径一致。 */

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

/** token 用量按 k / M 收敛，避免表格里出现 412321 这种难读数字。 */
export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return '—';
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US');
}

/**
 * 字节数按 B / KB / MB 收敛。
 *
 * 单独一个函数而不是复用 formatTokens：两者的量级口径不同（1024 vs 1000），
 * 混用会让「1.5 MB 的状态」和「1.5 M token」在页面上长得一模一样却含义不同。
 * 状态体积的分布跨度很大（实测样本从几十 KB 到 1.6 MB），所以小值保留一位小数，
 * 否则 1 KB 与 1.9 KB 会都显示成 "1 KB"。
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 时间字符串 → 毫秒。
 *
 * 多一步 replace 是必要的，不是防御性写法：后端确实会给出两种形态 ——
 * MySQL 的 DATETIME 直接取出来是 "2026-09-22 15:30:05"（空格分隔），
 * 而 Jackson 序列化 LocalDateTime 时是 "2026-09-22T15:30:05"。
 * 带空格的那种在 Chrome / Node 里能解析，Safari 会得到 Invalid Date，
 * 页面表现是时间列整列显示 "—"，完全看不出是解析问题。统一成 ISO 再解析，两端都稳。
 */
function parseTime(value: string | number): number {
  if (typeof value === 'number') return value;
  return Date.parse(value.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
}

/** 相对时间：控制台里 90% 的时间列都用这个，比绝对时间更有信息量。 */
export function formatRelative(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined) return '—';
  const time = parseTime(iso);
  if (Number.isNaN(time)) return '—';
  const diff = now - time;
  if (diff < 0) return '刚刚';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(time).toISOString().slice(0, 10);
}

export function formatDateTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const time = parseTime(iso);
  if (Number.isNaN(time)) return '—';
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 长 ID 折叠成 wo7U1…rqlw 形式，表格里保持单行可读。 */
export function ellipsizeMiddle(value: string, head = 5, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
