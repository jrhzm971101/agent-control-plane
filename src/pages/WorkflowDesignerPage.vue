<script setup lang="ts">
/*
 * 工作流设计器 —— 一张节点图 + 生命周期操作 + 运行记录。
 *
 * <h2>一、画布为什么是手写的 SVG</h2>
 * 官方前端也是手写的（WorkflowGraph.tsx，约 130 行）：按入边算列深度的分层布局 +
 * 三次贝塞尔曲线 + 箭头 marker。不引 react-flow / x6 这类库的理由很实际 ——
 * 本项目的图只有 agent / condition / join 三类节点、顺序执行、几十个节点上限，
 * 而这类库要额外带来拖拽画布、缩放、坐标持久化、命中测试等一整套状态，
 * 那套状态还得和"谁是真源"（spec 里的 nodes/edges）保持同步，是净负担。
 *
 * <h2>二、谁是真源</h2>
 * 真源永远是 spec：{ nodes, edges }。画布上所有坐标都是<b>现算的派生值</b>，
 * 不落库、不回写。所以页面上没有"拖节点"这个动作 —— 位置由拓扑决定，
 * 拖了也存不下来（存了就得处理"两个节点叠在一起"这类问题，而它对流程毫无意义）。
 * 想改的是<b>连接关系</b>与<b>节点配置</b>，那两件事在右侧面板里做。
 *
 * <h2>三、保存 / 校验 / 发布 三件事各自管什么</h2>
 *   - 保存草稿：只落库。图可以半成品（后端保存时不做完整校验）；
 *   - 校验：只查问题、不落库。用<b>本地正在编辑的这份</b>内容，不是库里的；
 *   - 发布：后端先校验（不通过回 400 + 逐条问题），通过后写快照并让新版本生效。
 * 所以「发布失败」与「校验不通过」看到的是同一批问题，不必猜为什么。
 *
 * <h2>四、节点状态叠加（跑完一次之后看图）</h2>
 * 运行记录里的「在图上看」会把某次执行的节点状态叠到画布上：走通的边变绿、
 * 被跳过的边变灰虚线、未执行的节点保持中性色。这是排查"分支为什么没走"
 * 最直接的一屏，也是为什么画布要认得 run 明细这层数据。
 */
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import {
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  listAgents,
  listWorkflowRuns,
  publishWorkflow,
  rollbackWorkflow,
  runWorkflow,
  saveWorkflow,
  validateWorkflow,
  violationsOf,
  workflowVersions,
} from '@/api/controlplane';
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeState,
  WorkflowRunDetail,
  WorkflowRunRow,
  WorkflowSpec,
} from '@/api/controlplane/types';
import { notifyFailure, notifyPublish, notifySuccess } from '@/features/controlplane/feedback';
import {
  WORKFLOW_STAGE_TEXT,
  WORKFLOW_STAGE_TONE,
  workflowRunBlockedReason,
  workflowStageOf,
  type WorkflowStage,
} from '@/features/controlplane/workflowStage';
import { queryKeys } from '@/lib/queryKeys';
import { agentDetailLink, traceLink } from '@/lib/links';
import { formatDuration, formatRelative } from '@/lib/format';
import { agentDisplayName } from '@/lib/agentDisplay';
import PageHeader from '@/components/ui/PageHeader.vue';
import AppCard from '@/components/ui/AppCard.vue';
import PaneCard from '@/components/ui/PaneCard.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import JsonBlock from '@/components/ui/JsonBlock.vue';
import VersionsPanel from '@/components/controlplane/VersionsPanel.vue';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();

const workflowKey = computed(() => String(route.params.workflowKey ?? ''));

// ==================== 取数 ====================

const { data: detail, isLoading, error } = useQuery({
  queryKey: computed(() => queryKeys.workflow(workflowKey.value)),
  queryFn: () => getWorkflow(workflowKey.value),
  enabled: computed(() => workflowKey.value.length > 0),
});

const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

const displayNameOf = computed(() => agentDisplayName(agents.value));

// tab 切换时才拉对应数据：设计器的两个附属列表（运行记录 / 版本）不必在进页面时就发两份请求
const runsEnabled = ref(false);
const { data: runs, isLoading: runsLoading } = useQuery({
  queryKey: computed(() => queryKeys.workflowRuns(workflowKey.value)),
  queryFn: () => listWorkflowRuns(workflowKey.value, 50),
  enabled: computed(() => workflowKey.value.length > 0 && runsEnabled.value),
});

const versionsEnabled = ref(false);
const { data: versions, isLoading: versionsLoading } = useQuery({
  queryKey: computed(() => queryKeys.workflowVersions(workflowKey.value)),
  queryFn: () => workflowVersions(workflowKey.value),
  enabled: computed(() => workflowKey.value.length > 0 && versionsEnabled.value),
});
// ==================== 本地草稿 ====================

/*
 * 本地编辑态。与 detail 分开保存，是为了让"我改了什么"这件事可判断（dirty），
 * 也为了保存失败时不清掉用户正在编辑的内容。
 */
const draft = reactive({
  displayName: '',
  description: '',
  nodes: [] as WorkflowNode[],
  edges: [] as WorkflowEdge[],
});

/** 服务器最近一次的 spec 快照（JSON 串）。用它判 dirty，避免写一遍深比较。 */
const savedSnapshot = ref('');

const specOf = (): WorkflowSpec => ({ nodes: draft.nodes, edges: draft.edges });
const snapshot = () =>
  JSON.stringify({ displayName: draft.displayName, description: draft.description, spec: specOf() });

const dirty = computed(() => snapshot() !== savedSnapshot.value);

/*
 * 「详情 → 草稿」那一次灌入写在下面「选中态」之后，不在这里。
 * 原因不是排版：它要写 selectedNodeKey，而 immediate 的回调在 setup 当场就执行，
 * 放在那个 ref 声明之前会抛 ReferenceError（Cannot access before initialization）。
 * 加 `immediate: false` 又能绕开报错，但那就退回本文档要修的那个 bug 了。
 */

// ==================== 页头状态口径 ====================

/*
 * 页头只读 detail 上的治理字段，不读 draft —— draft 里没有它们。
 * 三态判定与清单页共用同一份实现（features/controlplane/workflowStage.ts）：
 * 列表说「已发布」而详情说「待发布」是最难解释的一类不一致。
 */
const stage = computed<WorkflowStage>(() =>
  workflowStageOf({
    status: detail.value?.status ?? 'DRAFT',
    publishedVersion: detail.value?.publishedVersion ?? null,
  }),
);

/** 草稿版本号。detail 还没到时先按 1 显示，避免页头闪一个空格。 */
const currentVersion = computed(() => detail.value?.version ?? 1);

/** 线上版本号；null = 从未发布，页头据此决定要不要显示「线上 vN」。 */
const publishedVersion = computed(() => detail.value?.publishedVersion ?? null);

const STAGE_TEXT = WORKFLOW_STAGE_TEXT;
const STAGE_TONE = WORKFLOW_STAGE_TONE;

// ==================== 选中态 ====================

const selectedNodeKey = ref('');
/*
 * 初始 tab 取自地址里的 ?tab=…：清单页行操作里的「运行」就是靠
 * /workflows/<key>?tab=runs&run=1 把人直接送进运行记录（见下面的 pendingRun）。
 *
 * 手改地址栏写了个不存在的 tab 不会炸：el-tabs 找不到对应的 pane 就什么都不显示，
 * 而下面 watch(activeTab) 里是 if 判断而不是查表，也不会误开别的列表。
 */
const activeTab = ref(typeof route.query.tab === 'string' ? route.query.tab : 'design');

const selectedNode = computed(() => draft.nodes.find((node) => node.key === selectedNodeKey.value));

const nodeByKey = computed(() => new Map(draft.nodes.map((node) => [node.key, node])));

/**
 * 节点 key → 这个节点指向的 agent 名（非 agent 节点给空串）。
 *
 * <p>运行记录表里的一行只有 nodeKey，而"这一步交给了谁"要看节点定义 ——
 * 在这里做一次本地 join，比让后端在运行行里冗余一遍 agent 名更省：节点定义本来就在页面上。
 */
function agentIdOfNode(nodeKey: string): string {
  return nodeByKey.value.get(nodeKey)?.agentId ?? '';
}

/**
 * agent 名 → 类型，用来决定跳能力域还是编排域（见 links.ts 的 agentDetailLink）。
 *
 * <p>取值来自页面已缓存的 agent 清单（与下拉候选同源），查不到时给 null，
 * 由 agentDetailLink 回落 /agents —— 详情页读接口里的真实类型，落错入口只会少几个 tab。
 */
function agentTypeOf(name: string): string | null {
  return (agents.value ?? []).find((row) => row.agentName === name)?.agentType ?? null;
}

// ==================== 详情 → 草稿 ====================

/*
 * 把服务器那份灌进草稿。immediate: true 不是保险，是必需。
 *
 * 详情在第二次进入时很可能<b>已经在缓存里</b>（staleTime 15s，从清单页点回来就是这种情况），
 * 那时 detail 在组件挂载时就有值，watch 看不到任何"变化"，回调永远不触发 ——
 * 表现是整个页面空着：标题回落成 workflow-key、画布显示「还是一张空图」、连线 0 条，
 * 而且因为 savedSnapshot 还是 ''，页头还会挂一个假的「有未保存改动」。
 *
 * 同一个坑在 ModelsPage / ChannelsPage 里是绕开的（那两处是抽屉，用"打开时显式 refetch"填）。
 * 这里是路由页，缓存里的那份正是希望立刻显示的内容，所以就地 immediate 灌一次，
 * 不为它多发一次请求。
 */
watch(
  detail,
  (row) => {
    if (!row) return;
    draft.displayName = row.displayName ?? '';
    draft.description = row.description ?? '';
    draft.nodes = (row.spec?.nodes ?? []).map((node) => ({ ...node }));
    draft.edges = (row.spec?.edges ?? []).map((edge) => ({ ...edge }));
    savedSnapshot.value = snapshot();
    selectedNodeKey.value = draft.nodes[0]?.key ?? '';
  },
  { immediate: true },
);

// ==================== 节点编辑 ====================

const NODE_TYPES = [
  { value: 'agent', label: 'Agent' },
  { value: 'condition', label: '条件' },
  { value: 'join', label: '汇合' },
];

/** 节点类型在页面上的叫法；未知类型（占位的那五个）原样回显，免得显示成空白。 */
const nodeTypeLabel = (type: string) => NODE_TYPES.find((item) => item.value === type)?.label ?? type;

/** 这个类型当前版本能不能跑；不能跑的只提示、不拦编辑（拦了就没法保存草稿）。 */
const isSupportedType = (type: string) => NODE_TYPES.some((item) => item.value === type);

/**
 * key 输入框的本地副本。
 *
 * <p>为什么不直接把 :model-value 绑到 selectedNode.key：改名被拒（格式不对 / 重名）时
 * 那个 ref 不变，Vue 就不会重渲染这个输入框，界面上会停在用户刚敲的那个非法值上 ——
 * 看着像"改成功了"，而库里还是旧 key。用本地副本 + 提交后回写真实值，成败都能对齐。
 */
const keyDraft = ref('');

watch(
  selectedNode,
  (node) => {
    keyDraft.value = node?.key ?? '';
  },
  { immediate: true },
);

/** 提交 key 改名（失焦或回车触发）。无论成败都把输入框拉回真实值。 */
function commitKeyRename() {
  const node = selectedNode.value;
  if (!node) return;
  const next = keyDraft.value.trim();
  if (next !== node.key) {
    renameNode(node, next);
  }
  keyDraft.value = node.key;
}

function addNode(type: string) {
  const key = nextNodeKey(type);
  const node: WorkflowNode = { key, type, label: defaultLabel(type) };
  if (type === 'agent') node.agentId = '';
  if (type === 'condition') node.condition = '';
  if (type === 'join') node.join = { mode: 'all' };
  draft.nodes.push(node);
  selectedNodeKey.value = key;
  /*
   * 新节点自动接在当前最后一个节点后面：绝大多数流程就是往下接的，
   * 逼用户每次都手工连一条边是纯多余的步骤（连错了删掉也比重连一遍快）。
   */
  const tail = draft.nodes[draft.nodes.length - 2];
  if (tail && tail.key !== key) {
    draft.edges.push({ from: tail.key, to: key });
  }
}

function nextNodeKey(type: string): string {
  const base = type === 'agent' ? 'step' : type;
  let index = 1;
  while (draft.nodes.some((node) => node.key === `${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function defaultLabel(type: string): string {
  if (type === 'agent') return '调用 Agent';
  if (type === 'condition') return '判断';
  return '汇合';
}

function removeNode(key: string) {
  draft.nodes = draft.nodes.filter((node) => node.key !== key);
  /*
   * 连带删掉与它相连的边。留着会指向一个不存在的节点，而校验器会把那当成
   * "边的端点不存在"报出来 —— 用户会以为是校验器错了。
   */
  draft.edges = draft.edges.filter((edge) => edge.from !== key && edge.to !== key);
  if (selectedNodeKey.value === key) {
    selectedNodeKey.value = draft.nodes[0]?.key ?? '';
  }
}

/**
 * 改节点 key。
 *
 * key 是表达式里的寻址方式，所以：格式与去重先拦住；边的端点跟着改；
 * 但<b>表达式里</b>的 node.<key>.text 不自动改 —— 字符串替换很容易改坏
 * （比如把 node.step1 改成 node.step10 时误伤 node.step10 的引用），
 * 所以只统计出有多少处要人自己看，并把它显示出来。
 */
function renameNode(node: WorkflowNode, next: string) {
  const trimmed = next.trim();
  const previous = node.key;
  if (!trimmed || trimmed === previous) return;
  if (draft.nodes.some((item) => item.key === trimmed)) {
    notifyFailure(new Error(`节点 key 重复：${trimmed}`), '改不动');
    return;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    notifyFailure(new Error('key 只能由字母、数字、下划线组成，且不能以数字开头'), '改不动');
    return;
  }
  node.key = trimmed;
  for (const edge of draft.edges) {
    if (edge.from === previous) edge.from = trimmed;
    if (edge.to === previous) edge.to = trimmed;
  }
  const referencing =
    draft.nodes.filter(
      (item) => item.type === 'condition' && (item.condition ?? '').includes(`node.${previous}`),
    ).length +
    draft.edges.filter((edge) => (edge.condition ?? '').includes(`node.${previous}`)).length;
  if (referencing > 0) {
    ElMessage.warning(
      `已把 key 从 ${previous} 改成 ${trimmed}，但有 ${referencing} 处表达式还写着 node.${previous}，请手工改掉。`,
    );
  }
  if (selectedNodeKey.value === previous) selectedNodeKey.value = trimmed;
}
// ==================== 边编辑 ====================

const newEdge = reactive({ from: '', to: '', condition: '' });

function addEdge() {
  if (!newEdge.from || !newEdge.to) {
    notifyFailure(new Error('起点与终点都要选'), '连不上');
    return;
  }
  if (newEdge.from === newEdge.to) {
    notifyFailure(new Error('节点不能指向自己（自环）'), '连不上');
    return;
  }
  if (draft.edges.some((edge) => edge.from === newEdge.from && edge.to === newEdge.to)) {
    notifyFailure(new Error(`这条边已经存在：${newEdge.from} → ${newEdge.to}`), '连不上');
    return;
  }
  draft.edges.push({
    from: newEdge.from,
    to: newEdge.to,
    condition: newEdge.condition.trim() || null,
  });
  newEdge.condition = '';
}

function removeEdge(index: number) {
  draft.edges.splice(index, 1);
}

/**
 * 上移 / 下移一条边。
 *
 * 这个动作有<b>语义</b>，不是排版偏好：condition 节点的出边按声明顺序求值，
 * 取第一条成立的。所以"兜底边"（不写条件那条）必须排在最后 ——
 * 顺序调错的表现是"兜底分支被顺带执行了一遍"，而画布上完全看不出来。
 */
function moveEdge(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= draft.edges.length) return;
  const [edge] = draft.edges.splice(index, 1);
  draft.edges.splice(target, 0, edge);
}

// ==================== 画布布局 ====================
//
// 分层：每个节点的列 = 从入口出发的最长路径长度。用最长路径而不是最短，
// 是为了让"同层节点不互相遮挡"这个前提成立 —— 多条路径汇聚时，
// 按最短路径排会让下游节点被上游的边穿过。

interface Box {
  key: string;
  label: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: WorkflowNodeState | null;
}

const BOX_W = 176;
const BOX_H = 62;
const COL_GAP = 92;
const ROW_GAP = 34;

const depthOf = computed(() => {
  const depth = new Map<string, number>();
  const remaining = new Map<string, number>();
  for (const node of draft.nodes) remaining.set(node.key, 0);
  for (const edge of draft.edges) {
    if (remaining.has(edge.to)) remaining.set(edge.to, (remaining.get(edge.to) ?? 0) + 1);
  }

  // Kahn 拓扑序：入度 0 的先来；后继取"自己与所有前驱的最大值 + 1"。
  const queue = draft.nodes.filter((node) => (remaining.get(node.key) ?? 0) === 0).map((n) => n.key);
  for (const key of queue) depth.set(key, 0);
  let steps = 0;
  const limit = draft.nodes.length * draft.nodes.length + 1;

  while (queue.length > 0 && steps < limit) {
    steps += 1;
    const key = queue.shift() as string;
    const current = depth.get(key) ?? 0;
    for (const edge of draft.edges.filter((item) => item.from === key)) {
      depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, current + 1));
      const left = (remaining.get(edge.to) ?? 1) - 1;
      remaining.set(edge.to, left);
      if (left === 0) queue.push(edge.to);
    }
  }
  /*
   * 有环时上面会剩下节点算不到深度（校验器会报环）。这里给它们补一个兜底列，
   * 让画布仍然画得出来 —— 画不出来就没法在那个环上点删、也就改不动。
   */
  for (const node of draft.nodes) {
    if (!depth.has(node.key)) depth.set(node.key, depth.size);
  }
  return depth;
});

const boxes = computed<Box[]>(() => {
  const byColumn = new Map<number, string[]>();
  for (const node of draft.nodes) {
    const column = depthOf.value.get(node.key) ?? 0;
    const list = byColumn.get(column) ?? [];
    list.push(node.key);
    byColumn.set(column, list);
  }
  const result: Box[] = [];
  for (const [column, keys] of [...byColumn.entries()].sort((a, b) => a[0] - b[0])) {
    keys.forEach((key, row) => {
      const node = nodeByKey.value.get(key);
      if (!node) return;
      result.push({
        key,
        label: node.label?.trim() || key,
        type: node.type,
        x: 24 + column * (BOX_W + COL_GAP),
        y: 24 + row * (BOX_H + ROW_GAP),
        w: BOX_W,
        h: BOX_H,
        state: nodeStateOf(key),
      });
    });
  }
  return result;
});

const canvasSize = computed(() => {
  const right = boxes.value.reduce((max, box) => Math.max(max, box.x + box.w), BOX_W);
  const bottom = boxes.value.reduce((max, box) => Math.max(max, box.y + box.h), BOX_H);
  return { width: right + 32, height: bottom + 32 };
});

const boxByKey = computed(() => new Map(boxes.value.map((box) => [box.key, box])));

interface Wire {
  key: string;
  path: string;
  condition: string | null;
  tone: 'plain' | 'taken' | 'skipped';
  arrow: string;
}

const wires = computed<Wire[]>(() =>
  draft.edges.flatMap((edge, index) => {
    const from = boxByKey.value.get(edge.from);
    const to = boxByKey.value.get(edge.to);
    if (!from || !to) return [];
    const startX = from.x + from.w;
    const startY = from.y + from.h / 2;
    const endX = to.x;
    const endY = to.y + to.h / 2;
    const bend = Math.max(28, (endX - startX) / 2);
    const path = `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
    const tone = edgeStateOf(edge.from, edge.to);
    return [
      {
        key: `${edge.from}->${edge.to}-${index}`,
        path,
        condition: edge.condition ?? null,
        tone,
        arrow: `arrow-${tone}`,
      },
    ];
  }),
);
// ==================== 运行叠加 ====================

/** 在画布上叠加某次执行的节点状态；null = 不叠加。 */
const overlay = ref<{ runId: string; nodeStates: Map<string, WorkflowNodeState> } | null>(null);

function nodeStateOf(key: string): WorkflowNodeState | null {
  return overlay.value?.nodeStates.get(key) ?? null;
}

/**
 * 边状态只能"按语义还原"。
 *
 * 真源里没有边状态：TAKEN / SKIPPED 是引擎执行时的内存量，不落库（节点行才有状态）。
 * 所以这里按能确定的规则上色：下游被跳过 ⇒ 这条边被跳过；下游跑过或上游成功 ⇒ 走过。
 *
 * <p>会有歧义的情形：一个节点有多条入边而它被执行了，此时无法只从节点状态反推出
 * 究竟哪几条入边走过。所以这里只做到"不歧义才上色"；精确的边状态要看运行详情里
 * condition 节点的 branchTaken（它明确写了选了哪条）。
 */
function edgeStateOf(from: string, to: string): 'plain' | 'taken' | 'skipped' {
  if (!overlay.value) return 'plain';
  const target = overlay.value.nodeStates.get(to);
  if (target === 'SKIPPED') return 'skipped';
  if (target === 'SUCCEEDED' || target === 'RUNNING') return 'taken';
  const source = overlay.value.nodeStates.get(from);
  if (source === 'SUCCEEDED') return 'taken';
  return 'plain';
}

const NODE_FILL: Record<string, string> = {
  PENDING: '#f5f6f8',
  RUNNING: '#eef4ff',
  SUCCEEDED: '#eefaf1',
  FAILED: '#fdeeee',
  SKIPPED: '#f3f4f6',
};

const NODE_STROKE: Record<string, string> = {
  PENDING: '#dcdfe6',
  RUNNING: '#8fb4f5',
  SUCCEEDED: '#8fd0a6',
  FAILED: '#eba3a3',
  SKIPPED: '#d5d8de',
};

const STATE_TEXT: Record<string, string> = {
  PENDING: '未执行',
  RUNNING: '执行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  SKIPPED: '跳过',
};

const overlayNodes = computed(() => (overlay.value ? [...overlay.value.nodeStates.values()] : []));

/**
 * 叠加视图右上角的一句话汇总：这次执行里各状态各有多少个节点。
 *
 * 放在画布标题条而不是另开一块，是因为它描述的就是"这张图上现在的颜色是什么意思"，
 * 分开摆会让人以为多了一个模块。
 */
const overlaySummary = computed(() => {
  const states = overlayNodes.value;
  if (states.length === 0) return '';
  const order: WorkflowNodeState[] = ['SUCCEEDED', 'FAILED', 'SKIPPED', 'RUNNING', 'PENDING'];
  return order
    .map((state) => ({ state, count: states.filter((item) => item === state).length }))
    .filter((item) => item.count > 0)
    .map((item) => `${STATE_TEXT[item.state]} ${item.count}`)
    .join(' · ');
});

// ==================== 校验 ====================

const problems = ref<string[]>([]);
const validated = ref(false);

const validateMutation = useMutation({
  mutationFn: () => validateWorkflow(workflowKey.value, specOf()),
  onSuccess: (result) => {
    problems.value = result.problems;
    validated.value = true;
    if (result.ok) {
      notifySuccess('校验通过');
    } else {
      // 校验不通过是"一次正常的询问结果"，不是请求出错 —— 所以走 warning 而不是 error
      notifyFailure(new Error(`发现 ${result.problems.length} 个问题，见右侧列表`), '校验未通过');
    }
  },
  onError: (e) => notifyFailure(e, '校验请求失败'),
});

// ==================== 保存 / 发布 / 回滚 / 删除 ====================

const changeNote = ref('');

const saveMutation = useMutation({
  mutationFn: () =>
    saveWorkflow(workflowKey.value, {
      displayName: draft.displayName.trim(),
      description: draft.description.trim() || null,
      spec: specOf(),
    }),
  onSuccess: async () => {
    notifySuccess('已保存草稿');
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflow(workflowKey.value) });
  },
  onError: (e) => notifyFailure(e, '保存失败'),
});

const publishMutation = useMutation({
  mutationFn: async () => {
    /*
     * 先保存再发布。否则发布的是库里那份旧内容，而页面上显示的是新的 ——
     * 那是"我明明改了、发布完却没变"的经典来源。
     */
    if (dirty.value) {
      await saveMutation.mutateAsync();
    }
    return publishWorkflow(workflowKey.value, changeNote.value.trim() || undefined);
  },
  onSuccess: async (result) => {
    notifyPublish(result);
    changeNote.value = '';
    problems.value = [];
    validated.value = false;
    versionsEnabled.value = true;
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflow(workflowKey.value) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflowVersions(workflowKey.value) });
  },
  onError: (e) => {
    /*
     * 发布失败与「校验不通过」是同一批问题（后端先校验、再写快照），
     * 所以把 400 里的 violations 灌进同一块校验卡 —— 文件头那句
     * "不必猜为什么发布失败" 要落到界面上，否则用户只能看到一条通知、刷新就没了。
     */
    const violations = violationsOf(e);
    if (violations.length > 0) {
      problems.value = violations;
      validated.value = true;
    }
    notifyFailure(e, '发布失败');
  },
});

const rollbackMutation = useMutation({
  mutationFn: (version: number) => rollbackWorkflow(workflowKey.value, version),
  onSuccess: async (result) => {
    // 回滚只把内容写回草稿，线上不动 —— 提示里必须说清"还要再发一次"
    notifySuccess('已回滚到草稿');
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflow(workflowKey.value) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflowVersions(workflowKey.value) });
  },
  onError: (e) => notifyFailure(e, '回滚失败'),
});

const deleteMutation = useMutation({
  mutationFn: () => deleteWorkflow(workflowKey.value),
  onSuccess: async () => {
    notifySuccess('已删除工作流');
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
    await router.push('/workflows');
  },
  onError: (e) => notifyFailure(e, '删除失败'),
});

async function confirmDelete() {
  try {
    await ElMessageBox.confirm(
      `确定删除「${draft.displayName || workflowKey.value}」吗？历史运行记录会保留，但定义与版本快照会一起消失。`,
      '删除工作流',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  deleteMutation.mutate();
}

function handleMoreCommand(command: string): void {
  if (command === 'validate') {
    validateMutation.mutate();
    return;
  }
  if (command === 'delete') void confirmDelete();
}
// ==================== 试跑 ====================

const runDialog = ref(false);
const runInput = ref('{}');
const runUser = ref('');
const runNote = ref('');
const runInputProblem = ref('');

/*
 * 「现在能不能运行」的判断收在 features/controlplane/workflowStage.ts ——
 * 清单页行操作里的「运行」要用同一份，各写一遍必然出现
 * "清单页亮着、设计器灰着"这种没法解释的不一致。
 */
const runBlockedReason = computed(() =>
  workflowRunBlockedReason({ publishedVersion: publishedVersion.value, dirty: dirty.value }),
);

/**
 * 从清单页点「运行」进来时，自动打开运行对话框。
 *
 * <p>清单页那边只把人带过来（/workflows/<key>?tab=runs&run=1），不重复实现一遍输入框与
 * 提交逻辑：运行的 UI 只有这一处，两份实现必然漂移 —— 而"清单页跑出来的结果和设计器里
 * 跑出来的不一样"是最难查的一类问题。
 *
 * <p>四个细节都是必需的：
 * <ul>
 *   <li><b>等详情落地再判断</b>：该不该跑要看 publishedVersion，详情没到手时算不出来
 *       （那时 runBlockedReason 会给出"还没有发布过"，对一个已发布的工作流是错的）；</li>
 *   <li><b>还要等草稿灌进来</b>（savedSnapshot 非空）。同上一条一样是"算不准"而不是
 *       "算不出"：这个 watch 与上面那个 watch(detail) 都是被 detail 变化触发的，两个
 *       watch 谁先跑不是我们能定的 —— 实测这里会先于灌草稿那一步执行，于是 dirty 读到的
 *       是 savedSnapshot 还空着的瞬间，一个刚打开、什么都没改的工作流会被判成
 *       "有未保存的改动"，按钮灰着、连自动弹窗都变成一句"暂时不能运行"。
 *       以 savedSnapshot 为闸门，两个 watch 的先后就无关紧要了；把它一起放进 sources，
 *       是因为闸门本身要变一次才轮得到重新判断（那次重判时 pendingRun 已是 false，属空转）。</li>
 *   <li><b>immediate</b>：详情可能挂载时就已经在缓存里，那时 watch 看不到任何变化；</li>
 *   <li><b>无论开没开都清掉 run 参数</b>（replace 不是 push）：留着的话刷新或按后退
 *       会再弹一次对话框，而那时用户并没有想再跑一遍。</li>
 * </ul>
 */
const pendingRun = ref(route.query.run === '1');

watch(
  () => [isLoading.value, detail.value, savedSnapshot.value] as const,
  () => {
    if (!pendingRun.value) return;
    // savedSnapshot 为空 = 上面那次"详情 → 草稿"的灌入还没发生，此时 dirty 必然为 true，
    // 判断出来的结论是假的，所以先按兵不动（闸门变了会把这个 watch 再叫醒一次）。
    if (isLoading.value || !detail.value || savedSnapshot.value === '') return;
    pendingRun.value = false;
    void router.replace({ query: activeTab.value === 'design' ? {} : { tab: activeTab.value } });
    const reason = runBlockedReason.value;
    if (reason === '') {
      runDialog.value = true;
    } else {
      // 给一句人话而不是静默不动：按钮灰掉的原因在清单页那边看不到
      notifyFailure(new Error(reason), '暂时不能运行');
    }
  },
  { immediate: true },
);

const runMutation = useMutation({
  mutationFn: () =>
    runWorkflow(workflowKey.value, {
      input: JSON.parse(runInput.value || '{}') as Record<string, unknown>,
      userId: runUser.value.trim() || undefined,
      triggerRef: runNote.value.trim() || '页面运行',
    }),
  onSuccess: async (run) => {
    runDialog.value = false;
    notifySuccess(
      '执行完成',
      run.state === 'SUCCEEDED'
        ? `耗时 ${formatDuration((run.endedAtMs ?? run.startedAtMs) - run.startedAtMs)}`
        : `以 ${run.failureCode} 结束：${run.failureMessage ?? ''}`,
    );
    // 跑完直接切到运行记录：用户点「试跑」要的就是"这次跑成什么样"
    activeTab.value = 'runs';
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflowRuns(workflowKey.value) });
  },
  onError: (e) => notifyFailure(e, '执行失败'),
});

/** 试跑前先确认 JSON 能解析：让后端回一个 400 再翻译成页面文案，比这里直接判麻烦。 */
function checkRunInput(): boolean {
  try {
    const parsed = JSON.parse(runInput.value || '{}') as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      runInputProblem.value = '输入必须是一个 JSON 对象，例如 { "month": "2026-09" }';
      return false;
    }
    runInputProblem.value = '';
    return true;
  } catch (e) {
    runInputProblem.value = `不是合法 JSON：${(e as Error).message}`;
    return false;
  }
}

function submitRun() {
  if (!checkRunInput()) return;
  runMutation.mutate();
}

// ==================== 运行记录详情 ====================

const runDetail = ref<WorkflowRunDetail | null>(null);
const runDetailId = ref('');
const runDetailOpen = ref(false);
const runDetailLoading = ref(false);

async function openRunDetail(runId: string) {
  runDetailOpen.value = true;
  runDetailId.value = runId;
  runDetailLoading.value = true;
  runDetail.value = null;
  try {
    runDetail.value = await getWorkflowRun(runId);
  } catch (e) {
    notifyFailure(e, '读运行详情失败');
  } finally {
    runDetailLoading.value = false;
  }
}

/** 把这次执行的节点状态叠到画布上，并切回设计器。 */
function showOnCanvas() {
  const current = runDetail.value;
  if (!current) return;
  overlay.value = {
    runId: current.run.runId,
    nodeStates: new Map(current.nodes.map((node) => [node.nodeKey, node.state])),
  };
  runDetailOpen.value = false;
  activeTab.value = 'design';
}

function clearOverlay() {
  overlay.value = null;
}

const RUN_STATE_TEXT: Record<string, string> = {
  RUNNING: '执行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
};

function runTone(state: string): 'ok' | 'err' | 'rw' {
  if (state === 'SUCCEEDED') return 'ok';
  if (state === 'FAILED') return 'err';
  return 'rw';
}

function nodeTone(state: string): 'ok' | 'err' | 'off' | 'wait' {
  if (state === 'SUCCEEDED') return 'ok';
  if (state === 'FAILED') return 'err';
  if (state === 'SKIPPED') return 'off';
  return 'wait';
}

const runDuration = (run: WorkflowRunRow) =>
  formatDuration((run.endedAtMs ?? run.startedAtMs) - run.startedAtMs);

const outEdgesOf = (key: string) => draft.edges.filter((edge) => edge.from === key);

/**
 * 画布上的节点名。
 *
 * SVG 的 text 不折行，长说明会把方框撑破（方框宽是写死的 176），所以在这里截断；
 * 完整文本挂在节点上的 <title> 里，鼠标停上去能看全。
 */
const canvasLabel = (box: Box) => (box.label.length > 13 ? `${box.label.slice(0, 12)}…` : box.label);

/** 节点行的耗时；还没轮到它（没有 startedAtMs）时给「—」，而不是一个假的 0。 */
const nodeCost = (row: { startedAtMs: number | null; endedAtMs: number | null }) =>
  row.startedAtMs === null
    ? '—'
    : formatDuration((row.endedAtMs ?? row.startedAtMs) - row.startedAtMs);

/**
 * 运行结果的一句话摘要：几个节点成功、几个被跳过、几个失败。
 *
 * <p>为什么不去解析 output 里的文本：run 的 output 是「每个节点各自的产出」这棵
 * 嵌套结构（{@code { nodes: { <key>: { state, output } } }}），表格里放不下，
 * 而且扫表时没人会逐字读它 —— 要的是"这次跑透了没有"。完整输出在运行详情抽屉里。
 */
function summarizeRun(output: Record<string, unknown> | null): string {
  const nodes = output?.['nodes'];
  if (nodes === null || nodes === undefined || typeof nodes !== 'object') return '—';
  const states = Object.values(nodes as Record<string, { state?: unknown }>).map((node) =>
    String(node?.state ?? ''),
  );
  const parts = [`成功 ${states.filter((state) => state === 'SUCCEEDED').length}`];
  const skipped = states.filter((state) => state === 'SKIPPED').length;
  const failed = states.filter((state) => state === 'FAILED').length;
  if (skipped > 0) parts.push(`跳过 ${skipped}`);
  if (failed > 0) parts.push(`失败 ${failed}`);
  return parts.join(' · ');
}

/** JSON 压成一行并截断，用于运行详情里节点行的「输出」；完整内容看下面的 JSON 块。 */
function preview(value: unknown, max = 160): string {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '—';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** JsonBlock 的内容：空值写成「（空）」，免得渲染一个字面的 null 让人以为出了错。 */
const jsonOf = (value: unknown) =>
  value === null || value === undefined ? '（空）' : JSON.stringify(value, null, 2);

/** el-table 的 row-click 回的是整行，包一层取 runId（免得在模板里写箭头与类型断言）。 */
const openRunFromRow = (row: { runId: string }) => openRunDetail(row.runId);

/** 保存按钮的可用性：显示名必填；没改过就不给点（避免无意义地推进版本号）。 */
const canSave = computed(
  () => draft.displayName.trim().length > 0 && dirty.value && !saveMutation.isPending.value,
);

/*
 * tab 切换时补拉数据 + 顺手提醒未保存的改动。
 *
 * <p>immediate 是必需的：从清单页的「运行」进来时 activeTab 一开始就是 'runs'
 * （初值取自 ?tab=，见上面 selectedNodeKey 那一段），watch 看不到"切换"这个动作，
 * runsEnabled 就永远不被置位 —— 表现是运行记录那一页一直空着，而库里其实有记录。
 */
watch(
  activeTab,
  (tab) => {
    if (tab === 'runs') runsEnabled.value = true;
    if (tab === 'versions') versionsEnabled.value = true;
  },
  { immediate: true },
);

</script>
<template>
  <!--
    三种形态：加载中 / 读不到 / 正常。
    「读不到」不是边缘态：地址栏里的 key 打错、或者这个工作流刚被别处删掉，都会走到这里，
    所以给的是一条回去的路，而不是一句报错。
  -->
  <div v-if="isLoading" class="loading">加载中…</div>

  <AppCard v-else-if="error">
    <EmptyState :title="`读不到工作流「${workflowKey}」`" :hint="(error as Error).message">
      <template #action>
        <el-button type="primary" @click="router.push('/workflows')">回到工作流清单</el-button>
      </template>
    </EmptyState>
  </AppCard>

  <template v-else>
    <PageHeader
      :title="draft.displayName || workflowKey"
      :subtitle="draft.description || undefined"
    >
      <template #meta>
        <div class="row wrap badges">
          <AppBadge :variant="STAGE_TONE[stage]">{{ STAGE_TEXT[stage] }}</AppBadge>
          <span class="hint mono">草稿 v{{ currentVersion }}</span>
          <span v-if="publishedVersion" class="hint mono">线上 v{{ publishedVersion }}</span>
          <span class="hint mono">{{ workflowKey }}</span>
          <AppBadge v-if="dirty" variant="rw">有未保存改动</AppBadge>
        </div>
      </template>
      <template #actions>
        <!--
          「运行」必须出现在页头，而不是只藏在「运行记录」tab 里 ——
          实测反馈就是"建好了工作流，但页面上没有运行的地方"（那时它只在二级 tab 里，
          而 tab 默认不激活，按钮虽然在 DOM 里但肉眼看不到）。
          tooltip 用 :disabled 开关，并且外面要包一层 span：button 一旦 disabled
          就不再派发 mouseenter，不包的话鼠标移上去什么都不弹，等于没有解释。
        -->
        <el-tooltip
          :disabled="runBlockedReason === ''"
          :content="runBlockedReason"
          placement="bottom"
        >
          <span>
            <el-button :disabled="runBlockedReason !== ''" @click="runDialog = true">
              运行
            </el-button>
          </span>
        </el-tooltip>
        <el-button
          :loading="saveMutation.isPending.value"
          :disabled="!canSave"
          @click="saveMutation.mutate()"
        >
          保存草稿
        </el-button>
        <el-button
          type="primary"
          :loading="publishMutation.isPending.value"
          @click="publishMutation.mutate()"
        >
          发布
        </el-button>
        <el-dropdown trigger="click" popper-class="agent-more-menu" @command="handleMoreCommand">
          <el-button>
            更多
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                command="validate"
                :disabled="validateMutation.isPending.value"
              >
                校验
              </el-dropdown-item>
              <el-dropdown-item divided command="delete" class="is-danger">
                删除
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </PageHeader>

    <el-tabs v-model="activeTab" class="tabs">
      <!-- ==================== 设计 ==================== -->
      <el-tab-pane label="设计" name="design">
        <div class="split">
          <PaneCard title="流程图" :right="overlaySummary">
            <div v-if="overlay" class="ovbar">
              <span class="hint">叠加中的运行：<span class="mono">{{ overlay.runId }}</span></span>
              <span class="spacer" />
              <el-button size="small" @click="clearOverlay">清除叠加</el-button>
            </div>

            <EmptyState
              v-if="boxes.length === 0"
              title="还是一张空图"
            />
            <div v-else class="canvas-wrap">
              <svg class="canvas" :width="canvasSize.width" :height="canvasSize.height">
                <!-- 三种箭头各一个 marker：默认 / 走通 / 跳过。颜色与下面的线一致。 -->
                <defs>
                  <marker
                    id="arrow-plain"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#c3c6d4" />
                  </marker>
                  <marker
                    id="arrow-taken"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#7cc79b" />
                  </marker>
                  <marker
                    id="arrow-skipped"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#cfd2dc" />
                  </marker>
                </defs>

                <!-- 先画线再画节点：节点压在线上，箭头才不会插进方框里 -->
                <g>
                  <path
                    v-for="wire in wires"
                    :key="wire.key"
                    :d="wire.path"
                    class="wire"
                    :class="`wire--${wire.tone}`"
                    :marker-end="`url(#${wire.arrow})`"
                  />
                </g>

                <g
                  v-for="box in boxes"
                  :key="box.key"
                  class="nbox"
                  :class="{ 'nbox--sel': box.key === selectedNodeKey }"
                  @click="selectedNodeKey = box.key"
                >
                  <title>{{ box.label }}（{{ box.key }}）</title>
                  <rect
                    :x="box.x"
                    :y="box.y"
                    :width="box.w"
                    :height="box.h"
                    rx="8"
                    :fill="NODE_FILL[box.state ?? 'PENDING']"
                    :stroke="NODE_STROKE[box.state ?? 'PENDING']"
                    stroke-width="1.5"
                  />
                  <text :x="box.x + 13" :y="box.y + 25" class="nd__name">
                    {{ canvasLabel(box) }}
                  </text>
                  <text :x="box.x + 13" :y="box.y + 43" class="nd__meta">
                    {{ nodeTypeLabel(box.type) }} · {{ box.key }}
                  </text>
                  <text
                    v-if="box.state"
                    :x="box.x + box.w - 13"
                    :y="box.y + 25"
                    class="nd__state"
                    text-anchor="end"
                  >
                    {{ STATE_TEXT[box.state] }}
                  </text>
                </g>
              </svg>
            </div>

          </PaneCard>          <div class="stack side">
            <!-- ---------- 节点清单 ---------- -->
            <PaneCard title="节点">
              <div class="row wrap">
                <el-button
                  v-for="item in NODE_TYPES"
                  :key="item.value"
                  size="small"
                  @click="addNode(item.value)"
                >
                  + {{ item.label }}
                </el-button>
              </div>

              <EmptyState
                v-if="draft.nodes.length === 0"
                title="还没有节点"
              />
              <ol v-else class="olist mt">
                <li
                  v-for="node in draft.nodes"
                  :key="node.key"
                  class="orow orow--pick"
                  :class="{ 'orow--sel': node.key === selectedNodeKey }"
                  @click="selectedNodeKey = node.key"
                >
                  <AppBadge :variant="isSupportedType(node.type) ? 'external' : 'off'">
                    {{ nodeTypeLabel(node.type) }}
                  </AppBadge>
                  <span class="orow__name">{{ node.label || node.key }}</span>
                  <span class="spacer" />
                  <span class="mono orow__key">{{ node.key }}</span>
                  <el-button link size="small" type="danger" @click.stop="removeNode(node.key)">
                    删
                  </el-button>
                </li>
              </ol>

            </PaneCard>

            <!-- ---------- 选中节点的配置 ---------- -->
            <PaneCard v-if="selectedNode" title="节点配置">
              <el-form label-position="top">
                <el-form-item label="节点 key">
                  <el-input
                    v-model="keyDraft"
                    class="mono"
                    @blur="commitKeyRename"
                    @keyup.enter="commitKeyRename"
                  />
                </el-form-item>

                <el-form-item label="说明">
                  <el-input v-model="selectedNode.label" placeholder="这一步做什么" />
                </el-form-item>

                <el-form-item v-if="selectedNode.type === 'agent'">
                  <template #label>
                    <span class="row">
                      <span>目标 agent</span>
                      <!--
                        这个节点只是"引用"了某个 agent，真正的配置在它自己的详情页。
                        没有这个入口时的动作是：记住下拉里那个名字 → 侧栏翻到 Agents/Harness
                        → 再搜索一遍。选好的那一刻正是最可能想去看它配置的时候。
                      -->
                      <router-link
                        v-if="selectedNode.agentId"
                        class="hint lk"
                        :to="agentDetailLink(selectedNode.agentId, agentTypeOf(selectedNode.agentId))"
                      >
                        去编排
                      </router-link>
                    </span>
                  </template>
                  <el-select
                    v-model="selectedNode.agentId"
                    filterable
                    placeholder="选一个已装配的 agent"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="item in agents ?? []"
                      :key="item.agentName"
                      :label="displayNameOf(item.agentName)"
                      :value="item.agentName"
                    />
                  </el-select>
                </el-form-item>

                <template v-if="selectedNode.type === 'condition'">
                  <el-form-item label="分支表达式">
                    <el-input
                      v-model="selectedNode.condition"
                      type="textarea"
                      :rows="3"
                      class="mono"
                      placeholder="input.month != null"
                    />
                  </el-form-item>

                  <el-form-item label="出边">
                    <ol v-if="outEdgesOf(selectedNode.key).length > 0" class="olist">
                      <li
                        v-for="(edge, index) in outEdgesOf(selectedNode.key)"
                        :key="`${edge.to}-${index}`"
                        class="orow"
                      >
                        <span class="ordnum">{{ index + 1 }}</span>
                        <span class="mono orow__fixed">{{ edge.to }}</span>
                        <span v-if="edge.condition" class="mono hint orow__soft" :title="edge.condition">
                          {{ edge.condition }}
                        </span>
                        <template v-else>
                          <span class="spacer" />
                          <AppBadge variant="wait">兜底</AppBadge>
                        </template>
                      </li>
                    </ol>
                  </el-form-item>
                </template>

                <el-form-item
                  v-if="selectedNode.type === 'join' && selectedNode.join"
                  label="汇合模式"
                >
                  <el-select v-model="selectedNode.join.mode" style="width: 100%">
                    <el-option label="全部到齐（all）" value="all" />
                  </el-select>
                </el-form-item>

                <AppNote v-if="!isSupportedType(selectedNode.type)" tone="warn">
                  当前版本不支持节点类型「{{ selectedNode.type }}」，发布校验将拒绝。
                </AppNote>
              </el-form>
            </PaneCard>

            <!-- ---------- 连线 ---------- -->
            <PaneCard title="连线">
              <el-form label-position="top">
                <div class="f2">
                  <el-form-item label="从">
                    <el-select
                      v-model="newEdge.from"
                      filterable
                      placeholder="起点"
                      style="width: 100%"
                    >
                      <el-option
                        v-for="node in draft.nodes"
                        :key="node.key"
                        :label="node.label || node.key"
                        :value="node.key"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="到">
                    <el-select v-model="newEdge.to" filterable placeholder="终点" style="width: 100%">
                      <el-option
                        v-for="node in draft.nodes"
                        :key="node.key"
                        :label="node.label || node.key"
                        :value="node.key"
                      />
                    </el-select>
                  </el-form-item>
                </div>

                <el-form-item label="边上的条件（可空）">
                  <el-input
                    v-model="newEdge.condition"
                    class="mono"
                    placeholder="input.amount &gt; 100"
                  />
                </el-form-item>

                <el-button :disabled="draft.nodes.length < 2" @click="addEdge">
                  连一条边
                </el-button>
              </el-form>

              <h3 class="mt2">已有连线 · {{ draft.edges.length }}</h3>
              <EmptyState
                v-if="draft.edges.length === 0"
                title="还没有连线"
              />
              <ol v-else class="olist">
                <li
                  v-for="(edge, index) in draft.edges"
                  :key="`${edge.from}-${edge.to}-${index}`"
                  class="orow"
                >
                  <span class="ordnum">{{ index + 1 }}</span>
                  <span class="mono orow__edge orow__fixed">{{ edge.from }} → {{ edge.to }}</span>
                  <span v-if="edge.condition" class="mono hint orow__soft" :title="edge.condition">
                    {{ edge.condition }}
                  </span>
                  <template v-else>
                    <span class="spacer" />
                    <AppBadge variant="wait">默认</AppBadge>
                  </template>
                  <el-button
                    link
                    size="small"
                    :disabled="index === 0"
                    @click="moveEdge(index, -1)"
                  >
                    ↑
                  </el-button>
                  <el-button
                    link
                    size="small"
                    :disabled="index === draft.edges.length - 1"
                    @click="moveEdge(index, 1)"
                  >
                    ↓
                  </el-button>
                  <el-button link size="small" type="danger" @click="removeEdge(index)">
                    删
                  </el-button>
                </li>
              </ol>
            </PaneCard>

            <!-- ---------- 校验结果 ---------- -->
            <PaneCard title="校验结果">
              <div v-if="!validated" class="muted">未校验</div>
              <div v-else-if="problems.length === 0" class="row">
                <AppBadge variant="ok">通过</AppBadge>
              </div>
              <ol v-else class="plist">
                <li v-for="(item, index) in problems" :key="index" class="prow">{{ item }}</li>
              </ol>
            </PaneCard>
          </div>
        </div>
      </el-tab-pane>      <!-- ==================== 运行记录 ==================== -->
      <el-tab-pane label="运行记录" name="runs">
        <TableCard
          title="运行记录"
          :count="(runs ?? []).length"
          :loading="runsLoading"
        >
          <template #actions>
            <!-- 与页头那个「运行」共用 runBlockedReason，理由见那里 -->
            <el-tooltip
              :disabled="runBlockedReason === ''"
              :content="runBlockedReason"
              placement="bottom"
            >
              <span>
                <el-button
                  type="primary"
                  :disabled="runBlockedReason !== ''"
                  @click="runDialog = true"
                >
                  运行一次
                </el-button>
              </span>
            </el-tooltip>
          </template>

          <EmptyState
            v-if="(runs ?? []).length === 0"
            title="还没有运行过"
          />
          <el-table
            v-else
            :data="runs ?? []"
            row-key="runId"
            highlight-current-row
            @row-click="openRunFromRow"
          >
            <el-table-column label="运行" min-width="220">
              <template #default="{ row }">
                <div class="cell-main mono">{{ row.runId }}</div>
                <div class="cell-sub">{{ row.triggerRef || row.triggerType }}</div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="96">
              <template #default="{ row }">
                <AppBadge :variant="runTone(row.state)">
                  {{ RUN_STATE_TEXT[row.state] ?? row.state }}
                </AppBadge>
              </template>
            </el-table-column>
            <el-table-column label="定义版本" width="92">
              <template #default="{ row }">
                <span class="mono">v{{ row.revision ?? '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="用户" width="120">
              <template #default="{ row }">
                <span class="muted mono">{{ row.userId || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="开始" width="118">
              <template #default="{ row }">
                <span class="muted">{{ formatRelative(row.startedAtMs) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="耗时" width="92" align="right">
              <template #default="{ row }">
                <span class="mono">{{ runDuration(row) }}</span>
              </template>
            </el-table-column>
            <!--
              结果只给一句话，然后靠 show-overflow-tooltip 截断。
              不把 output 的 JSON 抖进表格：它是一整棵 { nodes: {…} } 的嵌套结构，
              在表格里既看不全、又会把行高撑成三行。扫表时真正要回答的是
              「这次跑透了没有」，所以这里只数节点状态；完整输出在运行详情里看。
            -->
            <el-table-column label="结果" width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <span v-if="row.state === 'FAILED'" class="hint err">
                  {{ row.failureCode }}：{{ row.failureMessage }}
                </span>
                <span v-else-if="row.state === 'RUNNING'" class="hint">还在跑…</span>
                <span v-else class="hint">{{ summarizeRun(row.output) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="84" align="right">
              <template #default="{ row }">
                <el-button size="small" @click.stop="openRunDetail(row.runId)">详情</el-button>
              </template>
            </el-table-column>
          </el-table>
        </TableCard>
      </el-tab-pane>

      <!-- ==================== 版本 ==================== -->
      <el-tab-pane label="版本" name="versions">
        <div class="split">
          <PaneCard title="版本历史">
            <VersionsPanel
              :versions="versions ?? []"
              :loading="versionsLoading"
              :published-version="publishedVersion"
              @rollback="(version: number) => rollbackMutation.mutate(version)"
            />
          </PaneCard>

          <PaneCard title="发布">
            <el-form label-position="top">
              <el-form-item label="变更说明">
                <el-input v-model="changeNote" placeholder="例如 加上飞书通知节点" />
              </el-form-item>
            </el-form>

            <el-button
              type="primary"
              :loading="publishMutation.isPending.value"
              @click="publishMutation.mutate()"
            >
              发布当前草稿
            </el-button>
          </PaneCard>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- ==================== 运行 ==================== -->
    <el-dialog v-model="runDialog" title="运行一次" width="620px" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="输入（一个 JSON 对象）">
          <el-input v-model="runInput" type="textarea" :rows="6" class="mono" />
          <div v-if="runInputProblem" class="hint err mt">{{ runInputProblem }}</div>
        </el-form-item>

        <div class="f2">
          <el-form-item label="userId（可选）">
            <el-input v-model="runUser" placeholder="可选" />
          </el-form-item>
          <el-form-item label="触发来源">
            <el-input v-model="runNote" placeholder="页面运行" />
          </el-form-item>
        </div>
      </el-form>

      <template #footer>
        <el-button @click="runDialog = false">取消</el-button>
        <el-button type="primary" :loading="runMutation.isPending.value" @click="submitRun">
          开始跑
        </el-button>
      </template>
    </el-dialog>

    <!-- ==================== 运行详情 ==================== -->
    <el-drawer v-model="runDetailOpen" size="820px" :with-header="false" destroy-on-close>
      <header class="dw__hd">
        <div class="dw__ttl">
          <span class="strong">运行详情</span>
          <span class="mono hint">{{ runDetailId }}</span>
        </div>
        <span class="spacer" />
        <el-button size="small" type="primary" @click="showOnCanvas">
          在图上看这次执行
        </el-button>
      </header>

      <div class="dw__bd">
        <div v-if="runDetailLoading" class="loading">加载中…</div>

      <template v-else-if="runDetail">
        <div class="row wrap badges">
          <AppBadge :variant="runTone(runDetail.run.state)">
            {{ RUN_STATE_TEXT[runDetail.run.state] ?? runDetail.run.state }}
          </AppBadge>
          <span class="hint mono">定义 v{{ runDetail.run.revision ?? '-' }}</span>
          <span class="hint">耗时 {{ runDuration(runDetail.run) }}</span>
          <span class="hint">{{ formatRelative(runDetail.run.startedAtMs) }}开始</span>
        </div>

        <AppNote v-if="runDetail.run.failureMessage" tone="warn" class="mt2">
          <b>{{ runDetail.run.failureCode }}</b>：{{ runDetail.run.failureMessage }}
        </AppNote>

        <h3 class="mt2">节点</h3>
        <el-table :data="runDetail.nodes" size="small" border>
          <el-table-column label="节点" min-width="180">
            <template #default="{ row }">
              <div class="cell-main">{{ nodeByKey.get(row.nodeKey)?.label || row.nodeKey }}</div>
              <div class="cell-sub mono">{{ row.nodeKey }} · {{ row.nodeType }}</div>
            </template>
          </el-table-column>
          <!--
            「这一步交给了谁」是看运行记录时最常问的问题，而节点行里只有 nodeKey ——
            agent 名在节点定义上（nodeByKey），所以这里做一次本地 join 并给出详情入口。
            非 agent 节点（condition / join）没有 agentId，显示成 — 而不是留白，
            留白会被读成"这一页渲染坏了"。
          -->
          <el-table-column label="Agent" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <router-link
                v-if="agentIdOfNode(row.nodeKey)"
                class="lk"
                :to="agentDetailLink(agentIdOfNode(row.nodeKey)!, agentTypeOf(agentIdOfNode(row.nodeKey)!))"
              >
                {{ displayNameOf(agentIdOfNode(row.nodeKey)!) }}
              </router-link>
              <span v-else class="hint">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="96">
            <template #default="{ row }">
              <AppBadge :variant="nodeTone(row.state)">
                {{ STATE_TEXT[row.state] ?? row.state }}
              </AppBadge>
            </template>
          </el-table-column>
          <el-table-column label="耗时" width="86" align="right">
            <template #default="{ row }">
              <span class="mono">{{ nodeCost(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="分支 / 链路" min-width="240">
            <template #default="{ row }">
              <span v-if="row.branchTaken" class="mono">→ {{ row.branchTaken }}</span>
              <router-link v-else-if="row.agentRunId" :to="traceLink(row.agentRunId)" class="mono">
                {{ row.agentRunId }}
              </router-link>
              <span v-else class="hint">—</span>
            </template>
          </el-table-column>
          <el-table-column label="说明 / 输出" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="hint">{{ row.failureMessage || preview(row.output, 120) }}</span>
            </template>
          </el-table-column>
        </el-table>

        <h3 class="mt2">这次运行的输入</h3>
        <JsonBlock :content="jsonOf(runDetail.run.input)" />

        <h3 class="mt2">这次运行的输出</h3>
        <JsonBlock :content="jsonOf(runDetail.run.output)" />
      </template>

        <EmptyState
          v-else
          title="没有拿到这次运行的数据"
        />
      </div>
    </el-drawer>
  </template>
</template>
<style scoped>
.badges {
  margin-top: 6px;
}
/* 表单里的两列栅格；窄屏落成一列。与 AgentDetailPage 同一套写法 */
.f2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 var(--s4);
}
/* el-tabs 的 content 默认 overflow:hidden，会把卡片里的下拉浮层裁掉 */
.tabs :deep(.el-tabs__content) {
  overflow: visible;
}
.side {
  min-width: 0;
}

/* ---------- 画布 ---------- */
.canvas-wrap {
  overflow: auto;
  max-height: 620px;
  border: 1px solid var(--bd-soft);
  border-radius: var(--r-md);
  background: var(--panel-soft);
}
.canvas {
  display: block;
}
.ovbar {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-bottom: var(--s3);
}
/* 线的三种语气：默认中性、走通变绿并加粗、被跳过变灰虚线 */
.wire {
  fill: none;
  stroke-width: 1.5;
  transition: stroke var(--dur) var(--ease);
}
.wire--plain {
  stroke: #c3c6d4;
}
.wire--taken {
  stroke: #7cc79b;
  stroke-width: 2;
}
.wire--skipped {
  stroke: #cfd2dc;
  stroke-dasharray: 4 4;
}
.nbox {
  cursor: pointer;
}
.nbox rect {
  transition: stroke var(--dur) var(--ease);
}
.nbox--sel rect {
  stroke: var(--pri);
  stroke-width: 2;
}
.nd__name {
  font: 600 13px var(--sans);
  fill: var(--t1);
  pointer-events: none;
}
.nd__meta {
  font: 11.5px var(--mono);
  fill: var(--t3);
  pointer-events: none;
}
.nd__state {
  font: 600 11.5px var(--sans);
  fill: var(--t2);
  pointer-events: none;
}

/* ---------- 行列表：节点 / 连线 / 出边共用一套外观 ---------- */
.olist {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--bd-soft);
  border-radius: var(--r-md);
  overflow: hidden;
}
.orow {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-height: 42px;
  padding: var(--s2) var(--s3);
  border-bottom: 1px solid var(--bd-soft);
  font-size: 13px;
}
.orow:last-child {
  border-bottom: none;
}
.orow--pick {
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.orow--pick:hover {
  background: var(--panel-soft);
}
/* 选中态用浅紫底而不是描边：列表里已经每行都有描边，再加一层会显得很吵 */
.orow--sel {
  background: var(--pri-soft);
}
.orow__name {
  min-width: 0;
  overflow: hidden;
  color: var(--t1);
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.orow__key {
  color: var(--t3);
}
/*
 * 行内文本的单行策略：分两类，不是一律截断。
 *
 * <ul>
 *   <li><b>orow__fixed</b>：连线的两端、节点 key —— 这是这一行<b>唯一</b>必须看清的信息，
 *       永远不缩（宁可行挤一点）；</li>
 *   <li><b>orow__soft</b>：条件表达式 —— 它可以很长，允许截断并右对齐，完整内容看 title。</li>
 * </ul>
 * 两者都禁折行：同一张列表里混着 40px 与 70px 的行高，扫起来很碎。
 */
.orow .orow__fixed {
  flex: 0 0 auto;
  white-space: nowrap;
}
.orow .orow__soft {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Element Plus 给相邻 button 之间留了 12px；行内这几个图标按钮不需要那么宽 */
.orow :deep(.el-button + .el-button) {
  margin-left: 2px;
}
.orow__edge {
  color: var(--t1);
}

/* ---------- 校验问题 ---------- */
.plist {
  margin: 0;
  padding: 0;
  list-style: none;
}
.prow {
  padding: var(--s2) var(--s3);
  border-left: 2px solid var(--red-line);
  border-radius: var(--r-xs);
  background: var(--red-bg);
  color: var(--red);
  font-size: 13px;
  line-height: 1.6;
}
.prow + .prow {
  margin-top: var(--s2);
}

/* ---------- 表格单元格里的主 / 副两行 ---------- */
.cell-main {
  overflow: hidden;
  color: var(--t1);
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-sub {
  margin-top: 2px;
  overflow: hidden;
  color: var(--t3);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint.err {
  color: var(--red);
}

/* ---------- 抽屉自带的头（与 ModelsPage 同一套写法） ---------- */
/* 抽屉 body 自带 20px 内边距，所以这里只补自己的纵向节奏，不再加左右 padding */
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
  padding-top: var(--s4);
}

@media (max-width: 1100px) {
  .f2 {
    grid-template-columns: 1fr;
  }
}
</style>
