/** 徽标与状态点的取值集合，页面不要另造字面量。 */
export type BadgeVariant =
  | 'harness'
  | 'react'
  | 'managed'
  | 'hosted'
  | 'external'
  | 'ro'
  | 'rw'
  | 'off'
  | 'err'
  | 'ok'
  | 'wait';

export type DotTone = 'ok' | 'run' | 'err' | 'wait';

export interface KVItem {
  label: string;
  value: string;
  mono?: boolean;
  badge?: { text: string; variant: BadgeVariant };
  /**
   * 值下面的一行灰色补充说明。
   *
   * 「调用参数默认值」那块必须能解释"没配的那部分去哪了"：只有「端点 = https://…」
   * 这种键值对是不够的，括号里的那半句（来源、空值的含义）才是让人能下判断的部分。
   * 它是值的一部分而不是独立的一块，所以挂在这里、由 KVList 一起排版。
   */
  note?: string;
  /**
   * 把值变成一条跳转地址（见 lib/links.ts 的构造器）。不传就是纯文本。
   *
   * <p>为什么挂在值上而不是在页面里另起一行按钮：键值对里出现的东西（会话 ID、agent 名、
   * 状态表名）本身就是**资源的标识**，用户想点的是那个标识本身。
   * 另起一排"查看会话 / 查看 agent"的按钮，既多占一行，又要在每个页面各写一遍
   * "哪个字段该配哪个按钮" —— 那正是这一列要避免的事。
   *
   * <p>类型是 string 而不是 LocationRaw：这一层的地址全部由 links.ts 构造，
   * 那批函数的返回值就是字符串，引入对象形式反而要多写一层转换。
   */
  to?: string;
}

export interface RunItem {
  id: string;
  title: string;
  meta?: string;
  note?: string;
  tone: DotTone;
}