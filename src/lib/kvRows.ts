/*
 * 键值对与「行数组」之间的互转。
 *
 * 为什么需要这一对函数：接口里的 headers / query-params 是对象，而编辑界面必须是
 * 有序的行数组 —— 对象表达不了"正在输入的空键"（键一空，那行就从对象里消失了，
 * 输入框会被立刻清空）。所以编辑态用数组、提交态用对象，中间靠这两个函数转。
 *
 * 放在 lib 而不是组件里：KeyValueEditor 与用它保存的页面（MCP 页）都要用，
 * 各自实现一遍必然出现"清空规则不一致"（一边丢空键、一边留空串）。
 */

export interface KVRow {
  key: string;
  value: string;
}

/** 行数组 -> 对象；空键行丢弃（那是"新建了一行但没填"，不是一条配置）。 */
export function toRecord(rows: KVRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) result[key] = row.value;
  }
  return result;
}

/** 对象 -> 行数组；键按字典序排，避免每次打开抽屉顺序都不一样。 */
export function fromRecord(record: Record<string, string> | null | undefined): KVRow[] {
  if (!record) return [];
  return Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, value: record[key] ?? '' }));
}