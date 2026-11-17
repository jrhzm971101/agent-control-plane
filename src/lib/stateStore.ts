/*
 * 「状态存储」在页面上只有开 / 关两种取值，但后端那一列是字符串（md_agent_runtime.state_store）。
 * 这个文件是这两者之间唯一的翻译层，三个页面（新建 Agent / 新建 Harness / 详情页编辑）共用，
 * 免得同一个字段在不同页面说成不同的话。
 *
 * <h2>值本身没有意义</h2>
 * 装配期只判"非空"（ConfigurableAgentBuilder#notBlankStateStore）：值以前是文件存储的目录路径，
 * 现在落地位置由 agent-platform.state-store-database 决定、表名由 state_table 决定。
 * 所以填 mysql / 1 / 任意字符串，行为完全一样 —— 既然如此，就固定一个能自解释的值。
 *
 * <h2>为什么要归一化而不是原样显示</h2>
 * 存量行里可能还是 /opt/xxx 这类路径串。下拉里没有那个选项，直接绑上去会显示成空白 ——
 * 看起来像"没开"，而用户顺手一保存就把这一列的语义改掉了，他以为自己只是看了一眼。
 * 所以在读取处就归一：非空一律显示"开启"，保存时统一写 'mysql'。
 *
 * <h2>表名不在页面上选</h2>
 * 表名取 md_agent_runtime.state_table，为空回落 agent 名（冻结值，所以改 agent 名不会丢上下文）。
 * 页面没有 state_table 的入口，因此实际落点是 md_agent_state.<agent-name>。
 * 表名要过白名单 [A-Za-z0-9_-]{1,64}，与 agent-name 的校验规则完全一致 ——
 * 这也意味着开了状态存储的 agent 名不能带中文或点号（创建弹窗已经拦住了）。
 */

/** 提交值：后端只判非空，用 'mysql' 让库里那一列自解释（"开了，且落在 MySQL"）。 */
export const STATE_STORE_ON = 'mysql';

/**
 * 关闭用空串而不是 null。
 *
 * el-select 的"清空"会回 null，而表单初值、归一化结果、提交前的判断如果混用 null / ''，
 * 就会出现"关掉了但看起来还开着"这类只在某些路径下复现的问题。空串只留一种表示。
 */
export const STATE_STORE_OFF = '';

export interface StateStoreOption {
  value: string;
  label: string;
}

/**
 * 下拉候选。文案里写清后果而不是只写"开启 / 关闭"：
 * 这一个开关决定企微、飞书、页面三处的多轮对话有没有上下文，
 * 而"没有上下文"在页面上的表现是"它好像忘了我说过什么"，离这个下拉很远。
 */
export const STATE_STORE_OPTIONS: StateStoreOption[] = [
  { value: STATE_STORE_ON, label: '开启 —— 会话上下文落 MySQL，多轮对话有记忆' },
  { value: STATE_STORE_OFF, label: '关闭 —— 不落库，每次调用都是全新上下文' },
];

/**
 * 库里读出来的值 → 下拉能识别的值。
 *
 * 非空一律归到 STATE_STORE_ON，理由见文件头：存量值可能是路径串，而下拉里没有那个选项。
 */
export function normalizeStateStore(value: string | null | undefined): string {
  return value ? STATE_STORE_ON : STATE_STORE_OFF;
}

/**
 * 下拉值 → 提交值。
 *
 * 必须把空串交回 null：后端读的是"这一列有没有值"，
 * 提交空串在多数 JDBC 映射下会存成 ''（而不是 NULL），虽然当前两套判断都能识别，
 * 但库里会同时存在 '' 与 NULL 两种"关闭"，下次写查询时必然踩到其中一个。
 */
export function toStateStorePayload(value: string | null | undefined): string | null {
  return value ? value : null;
}