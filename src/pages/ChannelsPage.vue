<script setup lang="ts">
/*
 * 渠道治理页：表格 + 编辑抽屉。
 *
 * <h2>一、为什么这一页是表格而不是卡片墙</h2>
 * 渠道是个位数量、但字段多且需要横向比较（哪个在跑、绑了几个 agent、发布到第几版、
 * 最近一次装配成不成功）。卡片适合"点开看正文"（PromptsPage），表格适合"一眼比状态"。
 *
 * <h2>二、三层职责在页面上必须分清（按钮就是按它给的）</h2>
 *   保存 = 只落库（草稿）—— 线上行为完全不变，可以放心改；
 *   发布 = 落一份版本快照 + 置 PUBLISHED + <b>立刻重新装配通道</b>（渠道是唯一"发布即生效"的资源）；
 *   回滚 = 把某一版快照写回库并置回草稿，<b>不</b>动线上；要切换得再点一次发布。
 * 把"发布"和"保存"合成一个按钮会让人不敢改（每次保存都会动线上），
 * 而把"回滚"做成直接生效则会有"手滑切回三个月前"的风险。
 *
 * <h2>三、凭据表单为什么是动态的</h2>
 * 每个渠道类型需要的凭据不同（企微机器人两个字段、飞书五个、官方回调式又是另一套），
 * 字段清单由后端 GET /api/channels/types 返回，这里只按它渲染。
 * 于是"加一个平台"在本页是零改动 —— 写死字段名的话，每加一个平台都要回来改一遍，
 * 而漏改的表现是"新平台的凭据填不进去"。
 *
 * <h2>四、行为参数为什么也按类型显示（dmScope / 回复风格）</h2>
 * 这两列并非每个类型都会读：回调式的回复由官方 outbound 渲染（不看回复风格），
 * 长连接机器人的会话由本项目渲染器自己算（不看 dmScope，配了只进一行日志）。
 * 所以"这个类型支持哪些取值"也由 /api/channels/types 一并返回，
 * 不支持的控件不渲染、只留一句原因 —— 摆一个填了不生效的下拉，比不摆更糟。
 *
 * <h2>五、绑定规则用"条件类型 + 值"两栏，而不是七个输入框</h2>
 * 官方的匹配层级是"取这条规则里最具体的那个非空字段"（peer > parentPeer > guild+roles >
 * guild > team > account > channel）。如果页面上把七个字段都摊开，用户很容易同时填 peer 和
 * guild —— 那条规则实际只按 peer 匹配，而 guild 那栏看起来也是生效的。所以这里让人先选
 * 「条件类型」，只出现对应的值输入框；序列化时也只写那一个字段（guild+roles 例外，两个）。
 *
 * <h2>六、草稿对象为什么是手工映射出来的，而不是 structuredClone(接口返回值)</h2>
 * vue-query 的 data 是 reactive 代理，structuredClone 遇到 Proxy 会抛 DataCloneError，
 * 页面直接掉进错误边界（这个坑在本项目发生过）。手工映射同时还能顺手做两件事：
 * 把 null 归一成界面好编辑的空值、把 roles 数组摊成逗号串。
 */
import { computed, reactive, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  channelVersions,
  createChannel,
  deleteChannel,
  getChannel,
  listAgents,
  listChannels,
  listChannelTypes,
  publishChannel,
  reloadAllChannels,
  reloadChannel,
  rollbackChannel,
  saveChannel,
} from '@/api/controlplane';
import type {
  ChannelBindingEntity,
  ChannelCapability,
  ChannelEntity,
  ChannelUpsert,
  ChannelView,
  DmScope,
  ReplyStyleName,
} from '@/api/controlplane/types';
import { notifyFailure, notifySuccess } from '@/features/controlplane/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { agentDetailLink } from '@/lib/links';
import { agentDisplayName } from '@/lib/agentDisplay';
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import FilterChips from '@/components/ui/FilterChips.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import VersionsPanel from '@/components/controlplane/VersionsPanel.vue';

const queryClient = useQueryClient();

const { data: channels, isLoading, error } = useQuery({
  queryKey: queryKeys.channels,
  queryFn: listChannels,
});

/* 类型清单是凭据表单的数据源；它只随后端代码变，所以缓存久一点没关系。 */
const { data: types } = useQuery({
  queryKey: queryKeys.channelTypes,
  queryFn: listChannelTypes,
  staleTime: 5 * 60 * 1000,
});

/* agent 下拉（绑定目标 + 渠道兜底）。 */
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

const list = computed(() => channels.value ?? []);
const agentNames = computed(() => (agents.value ?? []).map((row) => row.agentName).sort());

/**
 * agentNames 的 { name, displayName } 视图，只给下拉用。
 *
 * <p>为什么不把 agentNames 本身改成对象数组：它在 JS 里被当成纯粹的"标识列表"用
 * （新建规则时取第一个、校验引用是否存在），而下拉要的是"给人看的名字"。
 * 两者合成一个结构，会让读代码的人分不清某个位置拿到的到底是键还是名字。
 */
const agentOptions = computed(() =>
  (agents.value ?? [])
    .map((row) => ({ name: row.agentName, displayName: row.displayName || row.agentName }))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

/** agent 标识 → 展示名（回落规则见 lib/agentDisplay.ts）。 */
const displayNameOf = computed(() => agentDisplayName(agents.value));

/**
 * agent 标识 → 详情地址（按类型选能力域 / 编排域，见 links.ts 的 agentDetailLink）。
 *
 * <p>渠道能绑定的 agent 两种类型都有（兜底 agent 可以是一个 REACT，绑定规则也可以是），
 * 所以不能像工作区页那样写死 /harness。
 */
function agentLinkOf(name: string): string {
  const type = (agents.value ?? []).find((row) => row.agentName === name)?.agentType ?? null;
  return agentDetailLink(name, type);
}

/*
 * 这里刻意**不**做「渠道 → 会话记录」的直达链接。
 *
 * 唯一能对上的是 run 表的 source（console / wecom / feishu / schedule），
 * 而 channelType 是 wecom-bot / wecom / feishu-bot 这一族取值 —— 两者要靠前缀猜。
 * 猜错的表现不是报错，而是"筛出来的会话跟这个渠道没关系"，比没有入口更难发现。
 * 想看这个渠道的消息去了哪，走上面的「兜底 Agent」→ 那个 agent 的会话记录，
 * 那条路径每一步都有库里的事实支撑。
 */

// ==================== 筛选 ====================

const kindChip = ref('all');
const typeFilter = ref('');
const runFilter = ref('');
const keyword = ref('');

const typeOptions = computed(() =>
  [...new Set(list.value.map((row) => row.channelType))].sort(),
);

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  {
    key: 'BOT',
    label: '长连接机器人',
    count: list.value.filter((row) => row.kind === 'BOT').length,
  },
  {
    key: 'OFFICIAL',
    label: '回调式接入',
    count: list.value.filter((row) => row.kind === 'OFFICIAL').length,
  },
  {
    key: 'trouble',
    label: '有异常',
    count: list.value.filter((row) => Boolean(row.runtime.error)).length,
  },
]);

const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return list.value.filter((row) => {
    if (kindChip.value === 'BOT' && row.kind !== 'BOT') return false;
    if (kindChip.value === 'OFFICIAL' && row.kind !== 'OFFICIAL') return false;
    if (kindChip.value === 'trouble' && !row.runtime.error) return false;
    if (typeFilter.value && row.channelType !== typeFilter.value) return false;
    if (runFilter.value === 'up' && !(row.runtime.started && row.runtime.alive)) return false;
    if (runFilter.value === 'down' && row.runtime.started) return false;
    if (!lower) return true;
    return `${row.channelId} ${row.displayName ?? ''} ${row.defaultAgentId ?? ''}`
      .toLowerCase()
      .includes(lower);
  });
});

const isFiltered = computed(
  () =>
    Boolean(keyword.value || typeFilter.value || runFilter.value) || kindChip.value !== 'all',
);

function reset() {
  kindChip.value = 'all';
  typeFilter.value = '';
  runFilter.value = '';
  keyword.value = '';
}

// ==================== 展示口径（页面用的三处判断，写在这里避免模板里堆三元） ====================

/** 运行态：停用 / 装配失败 / 运行中 / 连接中 / 未运行 —— 五种，别压成两种。 */
function runText(row: ChannelView): string {
  if (!row.enabled) return '已停用';
  if (row.runtime.error) return '装配失败';
  if (row.runtime.started && row.runtime.alive) return '运行中';
  if (row.runtime.started) return '连接中';
  return '未运行';
}

function runTone(row: ChannelView): 'ok' | 'err' | 'wait' | 'off' {
  if (!row.enabled) return 'off';
  if (row.runtime.error) return 'err';
  if (row.runtime.started && row.runtime.alive) return 'ok';
  if (row.runtime.started) return 'wait';
  return 'off';
}

/** 发布态口语化：publishedVersion 为 null（从未发布）与"改过还没发"是两件事。 */
function publishText(row: ChannelView | null | undefined): string {
  if (!row) return '未发布';
  if (row.status === 'PUBLISHED') return `已发布 v${row.publishedVersion ?? row.version ?? 1}`;
  return row.publishedVersion === null ? '未发布过' : `有改动待发布（线上 v${row.publishedVersion}）`;
}

function publishTone(row: ChannelView | null | undefined): 'ok' | 'rw' | 'off' {
  if (!row) return 'off';
  if (row.status === 'PUBLISHED') return 'ok';
  return row.publishedVersion === null ? 'off' : 'rw';
}

const kindLabel = (row: ChannelView) => (row.kind === 'OFFICIAL' ? '回调式' : '长连接');

// ==================== 编辑抽屉 ====================

/** 绑定规则的可编辑行：把"七个字段"折成"条件类型 + 值"。 */
interface RuleRow {
  tier: string;
  value: string;
  /** 仅 guild+roles 用：逗号分隔。 */
  roles: string;
  agentId: string;
  sessionScope: DmScope | '';
}

/**
 * 编辑草稿。
 *
 * 字段与 ChannelEntity 对齐（而不是复用一个 ChannelView），因为这里是"可编辑的形状"：
 * dmScope / replyStyle / 条件值都允许是空串，提交前再归一成 null。
 */
interface ChannelDraft {
  channelId: string;
  channelType: string;
  displayName: string;
  description: string;
  ownerId: string;
  defaultAgentId: string;
  dmScope: DmScope | '';
  replyStyle: ReplyStyleName | '';
  enabled: boolean;
  /** 凭据：key → 用户输入（值统一按字符串编辑；agentId 这类数字由后端自己解析）。 */
  properties: Record<string, string>;
  rules: RuleRow[];
}

const TIERS = [
  { key: 'peer', label: '精确 peer（单聊用户 / 群）' },
  { key: 'parentPeer', label: '父 peer（线程继承）' },
  { key: 'guildRoles', label: '服务器 + 角色' },
  { key: 'guild', label: '服务器 / 工作区' },
  { key: 'team', label: '团队' },
  { key: 'account', label: '账号（多机器人区分）' },
  { key: 'channel', label: '渠道 id' },
];

/*
 * 单聊会话范围与回复风格的可选值<b>不再写在这里</b>：它们随类型而变
 * （回调式没有回复风格、长连接机器人没有 dmScope），由 /api/channels/types 的 capabilities 给出。
 * 写死在页面上意味着"后端多支持了一种取值"会被这一行静默吃掉。
 */

const drawerOpen = ref(false);
const creating = ref(false);
const draft = ref<ChannelDraft | null>(null);
const changeNote = ref('');

/** 当前草稿类型的描述（凭据表单按它渲染）。 */
const draftDescriptor = computed(() => {
  const typeId = draft.value?.channelType;
  return (types.value ?? []).find((item) => item.typeId === typeId) ?? null;
});

/**
 * 草稿里能给出结论的必填项。
 *
 * <p>本页原先<b>一条前端校验都没有</b>：保存按钮永远可点，缺什么只能靠后端 400 告诉你。
 * 这里把三类必填补齐：
 * <ol>
 *   <li>channelId / 类型 —— 运行时的注册键与适配器选择，缺了连渠道都建不出来；</li>
 *   <li>展示名 —— 列表首列取它，留空整列会空掉（后端 validateChannel 也拦）；</li>
 *   <li>类型的必填凭据 —— {@code ChannelPropertySpec.required} 这个标志从建表起就存在，
 *       但<b>从来没有被读过</b>。不读它的后果不只是"晚一点报错"：collectProperties 会把
 *       空的凭据整个略过，于是保存等于把已有凭据清成 null，而页面上看不出发生了什么。</li>
 * </ol>
 */
const draftProblems = computed(() => {
  const problems: string[] = [];
  const current = draft.value;
  if (!current) return problems;
  if (!current.channelId.trim()) problems.push('渠道名（channelId）不能为空');
  if (!current.channelType.trim()) problems.push('类型不能为空');
  if (!current.displayName.trim()) problems.push('显示名不能为空');
  for (const spec of draftDescriptor.value?.properties ?? []) {
    if (spec.required && !(current.properties[spec.key] ?? '').trim()) {
      problems.push(`${spec.label} 不能为空`);
    }
  }
  return problems;
});
const canSave = computed(() => draftProblems.value.length === 0);

/**
 * 「不适用」占位 —— 类型清单还没加载回来时按它算。
 * 宁可少显示一个控件，也不要显示一个填了不生效的控件：后者用户没法自查。
 */
const NOT_APPLICABLE: ChannelCapability = { options: [], note: null };

/**
 * 某个类型对两个行为参数的支持情况。
 *
 * <p>模板与提交走同一个函数，是为了避免"页面按 A 判断、提交按 B 判断"——
 * 那会造出"控件看得见、值却被丢掉"这种两边都不报错的错位。
 */
function capabilitiesOf(typeId: string) {
  const descriptor = (types.value ?? []).find((item) => item.typeId === typeId) ?? null;
  return {
    dmScope: descriptor?.dmScope ?? NOT_APPLICABLE,
    replyStyle: descriptor?.replyStyle ?? NOT_APPLICABLE,
  };
}

const draftCaps = computed(() => capabilitiesOf(draft.value?.channelType ?? ''));

/**
 * 只有一个可选值的行为参数直接填上。
 *
 * <p>目前只有长连接机器人的回复风格属于这种（该平台只有一种渲染器）。
 * 留空会逼用户点开下拉、再从唯一一项里选一次 —— 那一步不产生任何信息。
 */
function applyCapabilityDefaults(target: ChannelDraft) {
  const caps = capabilitiesOf(target.channelType);
  if (caps.dmScope.options.length === 1 && target.dmScope === '') {
    target.dmScope = caps.dmScope.options[0] as DmScope;
  }
  if (caps.replyStyle.options.length === 1 && target.replyStyle === '') {
    target.replyStyle = caps.replyStyle.options[0] as ReplyStyleName;
  }
}

/** 正在编辑的渠道名；空串 = 新建（此时不发详情请求）。 */
const editingId = ref('');

/*
 * 详情查询（含明文凭据）。
 *
 * 它只在"要编辑某个已存在的渠道"时有意义，所以用 editingId 是否为空来开关 ——
 * 而不是用抽屉开合：新建时抽屉开着但没有 id 可查，查了也是 404。
 *
 * 注意这里不靠 watch(data) 去填草稿：详情可能早已在缓存里（第二次打开同一个渠道），
 * 那时 data 不会变化，watch 永远不触发，抽屉就空着。所以由 openEdit 主动 await refetch 后填。
 */
const detailQuery = useQuery({
  queryKey: computed(() => queryKeys.channelDetail(editingId.value)),
  queryFn: () => getChannel(editingId.value),
  enabled: computed(() => editingId.value !== ''),
});

const versionsQuery = useQuery({
  queryKey: computed(() => queryKeys.resourceVersions('channel', editingId.value)),
  queryFn: () => channelVersions(editingId.value),
  enabled: computed(() => editingId.value !== ''),
});

function emptyDraft(): ChannelDraft {
  const seed: ChannelDraft = {
    channelId: '',
    // 默认取第一个可用类型：让"新建"点开后表单就有内容，而不是一片空白等着报错
    channelType: types.value?.[0]?.typeId ?? '',
    displayName: '',
    description: '',
    ownerId: '',
    defaultAgentId: '',
    dmScope: '',
    replyStyle: '',
    enabled: true,
    properties: {},
    rules: [],
  };
  // 新建也要走一次默认值填充：否则用户必须手动选那个唯一可选的回复风格，
  // 而漏选的表现是保存后回复风格为空（后端会按平台推断，但页面上看不出这一点）。
  applyCapabilityDefaults(seed);
  return seed;
}

/**
 * 用户手动切换类型时的收尾：清掉上一个类型的凭据，再补上新类型的单选项默认值。
 *
 * <p>为什么绑在 select 的 change 上而不是 watch 字段：watch 会在"程序填入草稿"时也触发
 * （编辑已有渠道 → 填入 channelType → watch 立刻把刚填好的凭据清空）。
 * 那是很难自查的一类 bug：页面看起来正常，只是凭据永远是空的。
 */
function onTypeChange() {
  if (!draft.value) return;
  draft.value.properties = {};
  applyCapabilityDefaults(draft.value);
}

function openCreate() {
  creating.value = true;
  editingId.value = '';
  changeNote.value = '';
  draft.value = emptyDraft();
  drawerOpen.value = true;
}

function openEdit(row: ChannelView) {
  creating.value = false;
  editingId.value = row.channelId;
  changeNote.value = '';
  // 先用列表里那份顶上，抽屉立刻有内容；它是打码的，所以只作占位（见 toDraft 的 masked 分支）
  draft.value = toDraft(row, true);
  drawerOpen.value = true;
  void fillFromDetail();
}

/**
 * 取详情（明文凭据）并覆盖草稿。
 *
 * <p>显式 refetch 而不是等 watch：详情可能已在缓存里，那时 data 不会变化。
 * 取回前先记住 id，取回后比对一次 —— 用户可能在请求飞行期间就切到了另一个渠道，
 * 那时把旧响应写进草稿会让"编辑 A 却看到 B 的凭据"。
 */
async function fillFromDetail() {
  const id = editingId.value;
  const result = await detailQuery.refetch();
  if (creating.value || editingId.value !== id || !result.data) return;
  draft.value = toDraft(result.data);
}

function toDraft(view: ChannelView, masked = false): ChannelDraft {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(view.properties ?? {})) {
    // 列表接口里敏感字段是 ******；先不填，等详情接口把明文带回来后整体覆盖，
    // 免得用户在等待的瞬间看到一串星号并把它当成真值提交。
    if (masked && value === '******') continue;
    properties[key] = value === null || value === undefined ? '' : String(value);
  }
  return {
    channelId: view.channelId,
    channelType: view.channelType,
    displayName: view.displayName ?? '',
    description: view.description ?? '',
    ownerId: view.ownerId ?? '',
    defaultAgentId: view.defaultAgentId ?? '',
    dmScope: view.dmScope ?? '',
    replyStyle: view.replyStyle ?? '',
    enabled: view.enabled,
    properties,
    rules: (view.bindings ?? []).map(toRule),
  };
}

function toRule(binding: ChannelBindingEntity): RuleRow {
  let tier = 'peer';
  let value = binding.peer ?? '';
  if (binding.parentPeer) {
    tier = 'parentPeer';
    value = binding.parentPeer;
  } else if (binding.guild) {
    // roles 非空 = guild+roles 层；空 = guild 层。两者是官方里不同的层，不能合并。
    tier = binding.roles && binding.roles.length > 0 ? 'guildRoles' : 'guild';
    value = binding.guild;
  } else if (binding.team) {
    tier = 'team';
    value = binding.team;
  } else if (binding.account) {
    tier = 'account';
    value = binding.account;
  } else if (binding.channel) {
    tier = 'channel';
    value = binding.channel;
  }
  return {
    tier,
    value,
    roles: (binding.roles ?? []).join(', '),
    agentId: binding.agentId,
    sessionScope: binding.sessionScope ?? '',
  };
}

function addRule() {
  draft.value?.rules.push({
    tier: 'peer',
    value: '',
    roles: '',
    agentId: agentNames.value[0] ?? '',
    sessionScope: '',
  });
}

function removeRule(index: number) {
  draft.value?.rules.splice(index, 1);
}

/** 草稿 → 提交载荷：空串归一成 null，绑定按行序写 sortOrder。 */
function toPayload(current: ChannelDraft): ChannelUpsert {
  // 行为参数按"当前类型支不支持"决定写不写：不支持就写 null，而不是把库里的历史值原样带回去 ——
  // 留着它 = 页面上看不见、库里却躺着一个配了不生效的值（长连接机器人与 GitLab 都是这类）。
  const caps = capabilitiesOf(current.channelType);
  const entity: ChannelEntity = {
    channelId: current.channelId.trim(),
    channelType: current.channelType,
    // 展示名不走 blank()：它是必填且类型就是 string，归一成 null 既过不了类型检查、
    // 也会在后端 NOT NULL 列上撞出一个英文 SQL 报错（页面已经拦过空值，这里只做 trim）。
    displayName: current.displayName.trim(),
    description: blank(current.description),
    ownerId: blank(current.ownerId),
    defaultAgentId: blank(current.defaultAgentId),
    dmScope: caps.dmScope.options.length > 0 && current.dmScope !== '' ? current.dmScope : null,
    replyStyle:
      caps.replyStyle.options.length > 0 && current.replyStyle !== '' ? current.replyStyle : null,
    properties: collectProperties(current),
    enabled: current.enabled,
    // 治理列由后端维护（新建置 v1 / DRAFT，保存时推进草稿版本），这里给 null 占位
    status: 'DRAFT',
    version: null,
    publishedVersion: null,
    publishedAtMs: null,
    createdAtMs: null,
    updatedAtMs: null,
    createdBy: null,
    updatedBy: null,
  };
  return {
    channel: entity,
    bindings: current.rules
      .filter((rule) => rule.agentId.trim() !== '')
      .map((rule, index) =>
        toBinding(current.channelId.trim(), rule, index, caps.dmScope.options.length > 0),
      ),
  };
}

/** 凭据只提交"这个类型认识且用户真的填了"的键 —— 空值不写，免得保存出一个空凭据。 */
function collectProperties(current: ChannelDraft): Record<string, unknown> | null {
  const descriptor = (types.value ?? []).find((item) => item.typeId === current.channelType);
  if (!descriptor) return null;
  const result: Record<string, unknown> = {};
  for (const spec of descriptor.properties) {
    const value = (current.properties[spec.key] ?? '').trim();
    if (value !== '') result[spec.key] = value;
  }
  return Object.keys(result).length === 0 ? null : result;
}

function toBinding(
  channelId: string,
  rule: RuleRow,
  index: number,
  dmScopeAllowed: boolean,
): ChannelBindingEntity {
  const value = rule.value.trim();
  const roles =
    rule.tier === 'guildRoles'
      ? rule.roles
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
      : [];
  return {
    id: null,
    channelId,
    agentId: rule.agentId.trim(),
    peer: rule.tier === 'peer' ? value : null,
    parentPeer: rule.tier === 'parentPeer' ? value : null,
    guild: rule.tier === 'guild' || rule.tier === 'guildRoles' ? value : null,
    roles: roles.length > 0 ? roles : null,
    team: rule.tier === 'team' ? value : null,
    account: rule.tier === 'account' ? value : null,
    channel: rule.tier === 'channel' ? value : null,
    // 绑定级的会话范围覆盖，优先级高于渠道级 dmScope —— 类型不支持时同样要写 null，
    // 否则会从库里捞出一个页面上已经不显示、却仍在参与求值的值。
    sessionScope: dmScopeAllowed && rule.sessionScope !== '' ? rule.sessionScope : null,
    sortOrder: index,
  };
}

const blank = (value: string) => (value.trim() === '' ? null : value.trim());

// ==================== 写操作 ====================

const busy = computed(
  () =>
    saveMutation.isPending.value ||
    publishMutation.isPending.value ||
    deleteMutation.isPending.value ||
    reloadMutation.isPending.value,
);

function invalidateAll(channelId?: string) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.channels });
  if (channelId) {
    void queryClient.invalidateQueries({ queryKey: ['versions', 'channel', channelId] });
  }
}

const saveMutation = useMutation({
  mutationFn: async () => {
    const current = draft.value;
    if (!current) throw new Error('没有正在编辑的渠道');
    const payload = toPayload(current);
    return creating.value
      ? createChannel(payload)
      : saveChannel(editingId.value, payload);
  },
  onSuccess: (view) => {
    notifySuccess(creating.value ? '已新建草稿' : '已保存草稿');
    creating.value = false;
    editingId.value = view.channelId;
    draft.value = toDraft(view);
    invalidateAll(view.channelId);
  },
  onError: (err) => notifyFailure(err, '保存失败'),
});

const publishMutation = useMutation({
  mutationFn: async () => {
    // 先保存再发布：这样"点发布"永远发布的是屏幕上看到的内容，
    // 而不是"上次保存的内容 + 这次没保存的改动"（后者是最让人困惑的一类行为）。
    const current = draft.value;
    if (!current) throw new Error('没有正在编辑的渠道');
    const saved = creating.value
      ? await createChannel(toPayload(current))
      : await saveChannel(editingId.value, toPayload(current));
    creating.value = false;
    editingId.value = saved.channelId;
    return publishChannel(saved.channelId, changeNote.value || undefined);
  },
  onSuccess: (view) => {
    if (view.runtime.error) {
      // 发布成功（库里已是新版）但装配失败：必须显式告警，否则会出现
      // "页面上显示已发布、线上却还是旧实例"的哑谜。
      notifyFailure(new Error(view.runtime.error), '已发布，但装配失败');
    } else {
      notifySuccess('已发布并生效', runText(view));
    }
    draft.value = toDraft(view);
    invalidateAll(view.channelId);
  },
  onError: (err) => notifyFailure(err, '发布失败'),
});

const deleteMutation = useMutation({
  mutationFn: (channelId: string) => deleteChannel(channelId),
  onSuccess: (_result, channelId) => {
    notifySuccess('已删除');
    drawerOpen.value = false;
    draft.value = null;
    invalidateAll(channelId);
  },
  onError: (err) => notifyFailure(err, '删除失败'),
});

const reloadMutation = useMutation({
  mutationFn: (channelId: string) => reloadChannel(channelId),
  onSuccess: (view) => {
    if (view.runtime.error) notifyFailure(new Error(view.runtime.error), '重载未成功');
    else notifySuccess('已重新装配', `${view.channelId}：${runText(view)}`);
    if (draft.value && draft.value.channelId === view.channelId) draft.value = toDraft(view);
    invalidateAll(view.channelId);
  },
  onError: (err) => notifyFailure(err, '重载失败'),
});

const reloadAllMutation = useMutation({
  mutationFn: reloadAllChannels,
  onSuccess: (result) => {
    notifySuccess(
      '全量重载完成',
      `纳管 agent ${result.gateway.agentIds.length} 个，运行中渠道 ${result.channels.filter((row) => row.runtime.alive).length} 个。`,
    );
    invalidateAll();
  },
  onError: (err) => notifyFailure(err, '全量重载失败'),
});

const rollbackMutation = useMutation({
  mutationFn: (version: number) => rollbackChannel(editingId.value, version),
  onSuccess: (result) => {
    notifySuccess('已回滚到草稿');
    draft.value = toDraft(result.channel);
    void versionsQuery.refetch();
    invalidateAll(editingId.value);
  },
  onError: (err) => notifyFailure(err, '回滚失败'),
});

async function confirmDelete(row: ChannelView) {
  try {
    await ElMessageBox.confirm(
      `删除渠道「${row.channelId}」会同时删掉它的绑定规则与全部版本快照，且运行实例会被停止。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户点了取消
  }
  deleteMutation.mutate(row.channelId);
}

function deleteCurrentChannel() {
  const row = detailQuery.data.value;
  if (row) void confirmDelete(row);
}

function confirmRollback(version: number) {
  rollbackMutation.mutate(version);
}
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button :loading="reloadAllMutation.isPending.value" @click="reloadAllMutation.mutate()">
        全量重载
      </el-button>
      <el-button type="primary" @click="openCreate">+ 接入渠道</el-button>
    </template>
  </PageHeader>

  <AppNote v-if="error" tone="warn" class="mb">
    渠道列表读取失败：{{ error.message }}
  </AppNote>

  <FilterBar :result="{ count: visible.length, total: list.length, noun: '个渠道' }">
    <template #chips>
      <FilterChips v-model="kindChip" :items="chips" />
    </template>
    <FilterField label="关键字">
      <el-input v-model="keyword" placeholder="渠道名 / 展示名 / 兜底 Agent" clearable />
    </FilterField>
    <FilterField label="类型" width="200px">
      <el-select v-model="typeFilter" placeholder="全部类型" clearable>
        <el-option v-for="item in typeOptions" :key="item" :label="item" :value="item" />
      </el-select>
    </FilterField>
    <FilterField label="运行状态" width="170px">
      <el-select v-model="runFilter" placeholder="全部状态" clearable>
        <el-option label="运行中" value="up" />
        <el-option label="未运行" value="down" />
      </el-select>
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <TableCard :loading="isLoading">
    <EmptyState
      v-if="visible.length === 0"
      title="没有符合条件的渠道"
    />
    <el-table v-else :data="visible">
      <el-table-column label="渠道" min-width="200">
        <template #default="{ row }">
          <div class="cell">
            <!-- 展示名是首列主信息，channelId 降为次要索引：后者是运行时注册键，
                 也是回调式接入时要填进平台后台的回调 URL 末段 —— 仍然要看得见，
                 但"这个渠道叫什么"才是看这张表时先要回答的问题。 -->
            <span class="strong">{{ row.displayName }}</span>
            <span class="hint mono">{{ row.channelId }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="150">
        <template #default="{ row }">
          <div class="cell">
            <span>{{ row.typeLabel ?? '未知类型' }}</span>
            <AppBadge :variant="row.kind === 'OFFICIAL' ? 'external' : 'harness'">
              {{ kindLabel(row) }}
            </AppBadge>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="兜底 Agent" min-width="150">
        <template #default="{ row }">
          <!-- 兜底 agent 存的是标识，这里翻成展示名；标识用 title 保留。
               做成链接：渠道与 agent 是"入口 ↔ 落点"的关系，排查走查时两边都要能互相点过去。 -->
          <span v-if="!row.defaultAgentId" class="muted">（网关主 Agent）</span>
          <router-link
            v-else
            class="lk"
            :title="row.defaultAgentId"
            :to="agentLinkOf(row.defaultAgentId)"
          >
            {{ displayNameOf(row.defaultAgentId) }}
          </router-link>
        </template>
      </el-table-column>
      <el-table-column label="运行状态" min-width="180">
        <template #default="{ row }">
          <div class="cell">
            <AppBadge :variant="runTone(row)">{{ runText(row) }}</AppBadge>
            <span v-if="row.runtime.error" class="err mono" :title="row.runtime.error">
              {{ row.runtime.error }}
            </span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button
            link
            :loading="reloadMutation.isPending.value"
            @click="reloadMutation.mutate(row.channelId)"
          >
            重载
          </el-button>
          <el-button link type="danger" @click="confirmDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </TableCard>

  <el-drawer v-model="drawerOpen" size="880px" :with-header="false" destroy-on-close>
    <div v-if="draft" class="dw">
      <header class="dw__hd">
        <div class="dw__ttl">
          <span class="strong">{{ creating ? '接入新渠道' : draft.displayName }}</span>
          <AppBadge v-if="!creating && detailQuery.data.value" :variant="publishTone(detailQuery.data.value)">
            {{ publishText(detailQuery.data.value) }}
          </AppBadge>
          <span v-if="detailQuery.isLoading.value" class="hint">加载详情…</span>
        </div>
        <div class="row">
          <el-button :loading="busy" :disabled="!canSave" @click="saveMutation.mutate()">保存草稿</el-button>
          <el-button type="primary" :loading="busy" :disabled="!canSave" @click="publishMutation.mutate()">
            发布并生效
          </el-button>
          <el-dropdown
            v-if="!creating"
            trigger="click"
            popper-class="agent-more-menu"
            @command="deleteCurrentChannel"
          >
            <el-button :disabled="busy">
              更多
              <el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="delete" class="is-danger">删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <div class="dw__bd">
        <AppNote v-if="!canSave" tone="warn" class="mb">{{ draftProblems.join('；') }}</AppNote>
        <div class="sec">
          <div class="sec__hd"><h3>基础信息</h3></div>
          <el-form label-position="top">
            <div class="grid2">
              <el-form-item label="渠道名（channelId）">
                <el-input
                  v-model="draft.channelId"
                  :disabled="!creating"
                  class="mono"
                  placeholder="例如 deployment_agent-bot"
                />
              </el-form-item>
              <el-form-item label="类型">
                <el-select
                  v-model="draft.channelType"
                  :disabled="!creating"
                  @change="onTypeChange"
                  placeholder="选择接入方式"
                  style="width: 100%"
                >
                  <el-option
                    v-for="item in types ?? []"
                    :key="item.typeId"
                    :label="item.label"
                    :value="item.typeId"
                  />
                </el-select>
              </el-form-item>
            </div>

            <div class="grid2">
              <el-form-item label="展示名">
                <el-input v-model="draft.displayName" placeholder="例如 企微主机器人" />
              </el-form-item>
              <el-form-item>
                <template #label>
                  <span class="row">
                    <span>兜底 Agent</span>
                    <router-link
                      v-if="draft.defaultAgentId"
                      class="hint lk"
                      :to="agentLinkOf(draft.defaultAgentId)"
                    >
                      去编排
                    </router-link>
                  </span>
                </template>
                <el-select
                  v-model="draft.defaultAgentId"
                  filterable
                  clearable
                  placeholder="不填 = 用网关主 Agent"
                  style="width: 100%"
                >
                  <el-option
                    v-for="item in agentOptions"
                    :key="item.name"
                    :label="item.displayName"
                    :value="item.name"
                  >
                    <span class="row">
                      <span>{{ item.displayName }}</span>
                      <span class="spacer" />
                      <span class="hint mono">{{ item.name }}</span>
                    </span>
                  </el-option>
                </el-select>
              </el-form-item>
            </div>

            <el-form-item label="用途说明">
              <el-input v-model="draft.description" placeholder="请输入说明" />
            </el-form-item>

            <div class="grid3">
              <el-form-item label="单聊会话范围（dmScope）">
                <el-select
                  v-if="draftCaps.dmScope.options.length > 0"
                  v-model="draft.dmScope"
                  clearable
                  placeholder="官方默认 MAIN"
                  style="width: 100%"
                >
                  <el-option
                    v-for="item in draftCaps.dmScope.options"
                    :key="item"
                    :label="item"
                    :value="item"
                  />
                </el-select>
                <div v-else class="na">该类型不适用</div>
              </el-form-item>
              <el-form-item label="回复风格">
                <el-select
                  v-if="draftCaps.replyStyle.options.length > 0"
                  v-model="draft.replyStyle"
                  clearable
                  placeholder="按平台推断"
                  style="width: 100%"
                >
                  <el-option
                    v-for="item in draftCaps.replyStyle.options"
                    :key="item"
                    :label="item"
                    :value="item"
                  />
                </el-select>
                <div v-else class="na">该类型不适用</div>
              </el-form-item>
              <el-form-item label="启用">
                <el-switch v-model="draft.enabled" />
              </el-form-item>
            </div>
          </el-form>
        </div>

        <div class="sec">
          <div class="sec__hd">
            <h3>连接凭据</h3>
          </div>
          <el-form label-position="top">
            <el-form-item v-for="spec in draftDescriptor?.properties ?? []" :key="spec.key" :label="spec.label">
              <el-input
                v-model="draft.properties[spec.key]"
                :type="spec.secret ? 'password' : 'text'"
                :show-password="spec.secret"
                :placeholder="spec.placeholder ?? ''"
                class="mono"
              />
            </el-form-item>
          </el-form>
        </div>

        <div class="sec">
          <div class="sec__hd">
            <h3>路由绑定</h3>
          </div>
          <el-table :data="draft.rules" size="small" empty-text="没有绑定规则：这个渠道的消息全部走兜底 Agent">
            <el-table-column label="条件类型" width="190">
              <template #default="{ row }">
                <el-select v-model="row.tier" style="width: 100%">
                  <el-option v-for="item in TIERS" :key="item.key" :label="item.label" :value="item.key" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="值" min-width="180">
              <template #default="{ row }">
                <el-input v-model="row.value" class="mono" :placeholder="
                  row.tier === 'peer' ? 'direct:u_42 或 group:chatid' : '匹配值'
                " />
              </template>
            </el-table-column>
            <el-table-column label="角色（逗号分隔）" width="170">
              <template #default="{ row }">
                <el-input v-model="row.roles" class="mono" :disabled="row.tier !== 'guildRoles'" />
              </template>
            </el-table-column>
            <el-table-column label="交给 Agent" width="190">
              <template #default="{ row }">
                <el-select v-model="row.agentId" filterable style="width: 100%">
                  <el-option
                    v-for="item in agentOptions"
                    :key="item.name"
                    :label="item.displayName"
                    :value="item.name"
                  >
                    <span class="row">
                      <span>{{ item.displayName }}</span>
                      <span class="spacer" />
                      <span class="hint mono">{{ item.name }}</span>
                    </span>
                  </el-option>
                </el-select>
              </template>
            </el-table-column>
            <el-table-column v-if="draftCaps.dmScope.options.length > 0" label="会话范围" width="170">
              <template #default="{ row }">
                <el-select v-model="row.sessionScope" clearable placeholder="继承渠道" style="width: 100%">
                  <el-option
                    v-for="item in draftCaps.dmScope.options"
                    :key="item"
                    :label="item"
                    :value="item"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column width="70" align="right">
              <template #default="{ $index }">
                <el-button link type="danger" @click="removeRule($index)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-button class="mt" size="small" @click="addRule">+ 添加规则</el-button>
        </div>

        <div v-if="!creating" class="sec">
          <div class="sec__hd"><h3>版本历史</h3></div>
          <el-input v-model="changeNote" placeholder="变更说明" class="mb" />
          <VersionsPanel
            :versions="versionsQuery.data.value ?? []"
            :loading="versionsQuery.isLoading.value"
            :published-version="detailQuery.data.value?.publishedVersion ?? null"
            @rollback="confirmRollback"
          />
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.err {
  color: var(--red);
  font-size: 12px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dw {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.dw__hd {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex: 0 0 auto;
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--bd);
}
.dw__ttl {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
  margin-right: auto;
}
.dw__bd {
  flex: 1;
  min-height: 0;
  padding-top: var(--s4);
  overflow: auto;
}
.sec {
  padding-top: var(--s4);
  margin-top: var(--s4);
  border-top: 1px solid var(--bd-soft);
}
.sec:first-child {
  padding-top: 0;
  margin-top: 0;
  border-top: none;
}
.sec__hd {
  display: flex;
  align-items: baseline;
  gap: var(--s3);
  margin-bottom: var(--s3);
}
.sec__hd h3 {
  margin: 0;
}
.grid2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 var(--s4);
}
.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 var(--s4);
}
/* 「该类型不适用」占位：与一行控件等高，免得并排的第三个格子跟着塌下去 */
.na {
  display: flex;
  align-items: center;
  min-height: var(--ctl-h);
  color: var(--t3);
  font-size: 13px;
}
</style>
