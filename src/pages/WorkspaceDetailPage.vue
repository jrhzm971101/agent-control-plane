<script setup lang="ts">
/*
 * 工作区 · 详情（/workspace/:agentName）：浏览并维护某一个 agent 的工作区文件。
 *
 * ===========================================================================
 * 一、为什么"能改什么"完全由后端说了算，前端一个字都不另写
 *
 * 可写范围是一个白名单：根级 AGENTS.md / MEMORY.md / tools.json，加上 subagents/** 与
 * knowledge/**。白名单之外的 memory/ plans/ agents/ skills/ 只读可见，code/ 与一切
 * 点开头的目录完全不暴露。这一页<b>不复制这份名单</b>，只消费每个条目上的 writable：
 *
 *   - writable=false：不给编辑与删除入口。只读目录能进来，唯一目的是"看得见" ——
 *     memory/ 是可读不可写的：它的写入者是框架，页面改完会被下一次写入静默覆盖，
 *     而删掉它等于在另一个页面（状态存储）里做的事，不该在这里也开一个入口；
 *   - 前端若另抄一份白名单，两份必然会漂移，而漂移的表现是"前端说能写、后端 400"，
 *     这是最难向用户解释的一类失败。
 *
 * 所以页面上的规则永远只有一句：后端说可写，才给写入口。
 *
 * ===========================================================================
 * 二、为什么"新建"要填整条相对路径，而不是只填一个文件名
 *
 * 后端不提供 mkdir（多一个入口就多一处要过路径校验的地方），目录是在写入文件时
 * 顺带创建的。而根级白名单目录（subagents/、knowledge/）在还没写过任何文件之前
 * <b>不存在于框架的 ls 结果里</b>，页面自然也列不出它们 —— 那时用户没法"先进入目录
 * 再新建"。所以新建时填的是完整相对路径（例如 subagents/planner.md），一步到位。
 *
 * ===========================================================================
 * 三、为什么保存是"覆盖写"而不是"新建 + 更新"两个按钮
 *
 * 后端只有 PUT 一种写语义（文件不存在则创建）。页面照抄这个语义，不自己分叉：
 * 分叉之后必然出现"点了新建实际覆盖了别人的文件"这类只有用户才会踩到的坑。
 * 同理，重命名由"另存 + 删除"两步完成，页面不提供改名 —— 后端没有 rename，
 * 页面上做一个假的只会让人觉得改名失败了。
 *
 * ===========================================================================
 * 四、隔离维度（userId）为什么是下拉框，且候选值由后端给
 *
 * 工作区按用户隔离（命名空间 agents/<id>/users/<uid>）。**基线层**是 agent 出厂长什么样，
 * 选中某个 userId 才是那个人现在长什么样。两种视图不可互相替代，
 * 所以基线层是**合法值**而不是"没填"：它是下拉框里的第一项，不是清空后的兜底。
 *
 * 候选值来自后端（/api/workspace/users，从 md_agent_run 的 user_id 聚合）而不是前端拼的：
 * "有哪些 userId"只有后端知道，前端既没有 KV 命名空间，也不该去猜 console 这类角色名。
 * 名单里的每个身份都是真的在这台 agent 上跑过的人。
 *
 * allow-create 是必需的：新用户第一次开口之前不会出现在候选里，
 * 而"提前照着某个人的 ID 看一眼工作区"也是正常诉求。手输保留，但从"唯一入口"降级为兜底。
 */
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import {
  deleteWorkspaceFile,
  listWorkspaceAgents,
  listWorkspaceFiles,
  listWorkspaceUsers,
  readWorkspaceFile,
  saveWorkspaceFile,
} from '@/api/controlplane';
import type { WorkspaceAgentRow, WorkspaceEntry } from '@/api/controlplane/types';
import { messageOf, notifyFailure, notifySuccess } from '@/features/controlplane/feedback';
import { ApiError } from '@/lib/apiClient';
import { queryKeys } from '@/lib/queryKeys';
import { chatLink, harnessLink } from '@/lib/links';
import { formatBytes, formatRelative } from '@/lib/format';
import type { BadgeVariant, KVItem } from '@/components/ui/types';
import PageHeader from '@/components/ui/PageHeader.vue';
import PaneCard from '@/components/ui/PaneCard.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import KVList from '@/components/ui/KVList.vue';

const props = defineProps<{ agentName: string }>();

const router = useRouter();
const queryClient = useQueryClient();

/* agent 清单只用来说明"这个 agent 的文件存在哪"。查不到（地址写错）时下面的表会空着。 */
const { data: agents } = useQuery({
  queryKey: queryKeys.workspaceAgents,
  queryFn: listWorkspaceAgents,
});

const selected = computed<WorkspaceAgentRow | null>(
  () => (agents.value ?? []).find((row) => row.agentName === props.agentName) ?? null,
);

const backendText = computed(() => {
  const row = selected.value;
  if (!row) return '—';
  if (row.fsBackend === 'REMOTE') return 'MySQL';
  if (row.fsBackend === 'LOCAL') return '本地磁盘';
  return '未配置';
});

const backendVariant = computed<BadgeVariant>(() =>
  selected.value?.fsBackend === 'REMOTE' ? 'managed' : 'react',
);

const agentKv = computed<KVItem[]>(() => {
  const row = selected.value;
  if (!row) return [];
  return [
    { label: 'Agent', value: row.agentName, mono: true },
    { label: '文件后端', value: `${backendText.value}（md_agent_workspace.fs_backend）` },
    { label: '生效的文件系统', value: row.filesystemType ?? '未装配 filesystem', mono: true },
    { label: '工作区根路径', value: row.workspacePath ?? '—', mono: true },
  ];
});

// ==================== 隔离维度（userId） ====================

/*
 * 候选值：这个 agent 用过的身份。与「会话记录」页同源（都打在 md_agent_run 上），
 * 所以下钻、切人、回会话页看到的是同一批人，不存在"工作区里有的会话页里没有"。
 */
const { data: workspaceUsers } = useQuery({
  queryKey: computed(() => queryKeys.workspaceUsers(props.agentName)),
  queryFn: () => listWorkspaceUsers(props.agentName),
});

/** 生效的隔离维度；空串 = 基线层。请求参数一路用它，不要再往下传哨兵值。 */
const userId = ref('');

/**
 * 基线层在下拉里需要一个**非空**的哨兵值。
 *
 * el-select 把空串当作"没选"，于是控件只显示占位符，而这一页最需要让人看明白的
 * 恰恰是"现在看的是基线层"。哨兵值只在控件与计算属性之间流转，
 * 出了 {@link scopeModel} 就被换回空串 —— 传给接口的永远是空串（后端约定：空 = 基线层）。
 */
const BASELINE = '__baseline__';

const scopeModel = computed({
  get: () => userId.value || BASELINE,
  set: (next: string) => {
    userId.value = next === BASELINE ? '' : next;
  },
});

/**
 * 下拉项：基线层固定在第一个。
 *
 * 它不属于任何 userId，所以不进候选名单，但必须可选 —— 否则从某个人切回"出厂视图"
 * 就只能靠清空控件，而"清空"的含义是这一页最需要说清楚的一件事。
 *
 * 次行给的是规模与新鲜度（跑过几次、最近什么时候），用来区分"日常在用"与"只留了一条历史"。
 */
const scopeOptions = computed(() => [
  { value: BASELINE, label: '基线层', meta: '出厂模板，不属于任何用户' },
  ...(workspaceUsers.value ?? []).map((row) => ({
    value: row.userId,
    label: row.userId,
    meta: `${row.runs} 次 · ${formatRelative(row.lastActiveMs)}`,
  })),
]);

/*
 * 换 agent 时把隔离维度收回基线层。
 *
 * 同一个 userId 在另一个 agent 上不一定存在，留着它只会让人对着一棵空树猜
 * "是这个人没数据，还是选错了人"。
 */
watch(
  () => props.agentName,
  () => {
    userId.value = '';
  },
);

// ==================== 位置与当前打开的文件 ====================

/** 当前目录的工作区相对路径；空串 = 工作区根。 */
const currentDir = ref('');

/** 当前打开的文件路径；非 null 时展示编辑器。 */
const openFile = ref<string | null>(null);

/**
 * 新建态：文件还没写盘。
 *
 * 必须与"打开已有文件"分开，否则新建时查询会去打一个不存在的路径、拿回 400，
 * 用户看到的是一个红色错误页而不是一张空编辑器 —— 那会让人以为"新建失败了"。
 */
const newFile = ref(false);

/* 换 agent 或换隔离维度后，原来的目录与文件名都不再指向同一个位置，一律回到根。 */
watch([() => props.agentName, userId], () => {
  currentDir.value = '';
  openFile.value = null;
  newFile.value = false;
});

// ==================== 取数：目录 ====================

const { data: dir, isLoading: dirLoading, error: dirError } = useQuery({
  queryKey: computed(() =>
    queryKeys.workspaceDir(props.agentName, userId.value, currentDir.value),
  ),
  queryFn: () => listWorkspaceFiles(props.agentName, userId.value, currentDir.value),
});

const entries = computed(() => dir.value?.entries ?? []);

/** 面包屑：把 'a/b/c' 拆成逐级可点的路径，最后一段是当前位置。 */
const crumbs = computed(() => {
  const out = [{ label: '工作区', path: '' }];
  let acc = '';
  for (const part of currentDir.value ? currentDir.value.split('/') : []) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ label: part, path: acc });
  }
  return out;
});

function enterDir(path: string): void {
  currentDir.value = path;
  openFile.value = null;
  newFile.value = false;
}

function openEntry(row: WorkspaceEntry): void {
  if (row.directory) {
    enterDir(row.path);
    return;
  }
  newFile.value = false;
  openFile.value = row.path;
}

function backToList(): void {
  openFile.value = null;
  newFile.value = false;
  /* 新建后直接返回时，目录里可能已经多了一行 —— 顺手刷一次，免得要手动点刷新。 */
  void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAll });
}

// ==================== 取数：文件内容 ====================

const { data: file, isLoading: fileLoading, error: fileError } = useQuery({
  queryKey: computed(() =>
    queryKeys.workspaceFile(props.agentName, userId.value, openFile.value ?? ''),
  ),
  queryFn: () => readWorkspaceFile(props.agentName, userId.value, openFile.value ?? ''),
  /* 新建态不读盘：文件还不存在，读它必然失败。 */
  enabled: () => Boolean(openFile.value && !newFile.value),
});

/*
 * 编辑器草稿与服务端内容分成两份。
 *
 * 直接 v-model 到 file.content 的话，保存成功后缓存一刷新，用户正在写的字会被
 * 服务端返回的旧内容替换掉。分成两份之后，"未保存的改动"才有地方待着。
 */
const draft = ref('');
const savedDraft = ref('');

watch(
  file,
  (value) => {
    if (!value || newFile.value) return;
    draft.value = value.content;
    savedDraft.value = value.content;
  },
  { immediate: true },
);

const dirty = computed(() => draft.value !== savedDraft.value);
const canWrite = computed(() => newFile.value || file.value?.writable === true);

// ==================== 写：保存 / 删除 ====================

const saveMutation = useMutation({
  mutationFn: () =>
    saveWorkspaceFile({
      agentName: props.agentName,
      userId: userId.value,
      path: openFile.value ?? '',
      content: draft.value,
    }),
  onSuccess: async () => {
    savedDraft.value = draft.value;
    newFile.value = false;
    /*
     * 整棵工作区缓存一起失效。目录也要刷（新建文件会多出一行），
     * 而这些缓存都是小对象，重拉的代价可以忽略 —— 比"分两处精确失效、漏一处"划算得多。
     */
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAll });
    notifySuccess('已保存', openFile.value ?? '');
  },
  onError: async (error) => {
    notifyFailure(error, '保存失败');
    /* 见 deleteMutation 的说明：404 = 页面上这份东西已经过期（agent 未装配 / 文件被删）。 */
    if (error instanceof ApiError && error.status === 404) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAll });
    }
  },
});

const deleteMutation = useMutation({
  mutationFn: (path: string) => deleteWorkspaceFile(props.agentName, userId.value, path),
  onSuccess: async (result) => {
    /* 删掉的正是打开着的那个文件：编辑器必须关掉，否则它会指向一个不存在的路径。 */
    if (openFile.value === result.path) {
      openFile.value = null;
      newFile.value = false;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAll });
    notifySuccess('已删除', result.path);
  },
  onError: async (error) => {
    notifyFailure(error, '删除失败');
    /*
     * 404 只有一个含义：服务端说这东西不在了，而页面手上还留着它 ——
     * 也就是列表已经过期。这时必须刷新，否则用户会对着一行"删不掉的幽灵"反复点。
     * 保存路径上的 404 同理（agent 未装配时页面上的清单也是过期的）。
     */
    if (error instanceof ApiError && error.status === 404) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAll });
    }
  },
});

const busy = computed(() => saveMutation.isPending.value || deleteMutation.isPending.value);

async function confirmDelete(entry: { path: string; directory: boolean }): Promise<void> {
  try {
    await ElMessageBox.confirm(
      entry.directory
        ? `删除空目录「${entry.path}」？目录非空时后端会直接拒绝 —— 这一页不提供递归删除。`
        : `删除文件「${entry.path}」？工作区没有回收站，删了就没了。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消：这不是错误，静默返回
  }
  deleteMutation.mutate(entry.path);
}

// ==================== 新建 / 打开 ====================

/*
 * 本地预检：与后端 WorkspacePathGuard 的字符白名单保持一致。
 *
 * 这不是"前端做安全校验"（那必须由后端负责），只是一次体验优化：名字里带 `:` 或 `..`
 * 时立刻提示，比发一趟请求再弹红字快得多。真正的边界仍然是后端 ——
 * 这里漏判只会多一次 400，不会造成越权。
 */
const SEGMENT = /^[A-Za-z0-9_\-\u4e00-\u9fa5.]+$/;
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function pathProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return '路径不能为空';
  if (value.startsWith('/')) return '不要以 / 开头：这里要的是工作区内的相对路径';
  if (value.startsWith('.')) return '不能以点开头（点名路径不对外开放）';
  if (value.endsWith('/')) return '不能以 / 结尾';
  for (const seg of value.split('/')) {
    if (!seg) return '路径里有空的层级';
    if (seg === '.' || seg === '..') return '路径里不能出现 . 或 ..';
    if (seg.endsWith('.') || seg.endsWith(' ')) return `层级不能以点或空格结尾：${seg}`;
    if (!SEGMENT.test(seg)) return `层级含非法字符（只允许字母数字中文 _ - .）：${seg}`;
    if (RESERVED.has(seg.split('.')[0].toLowerCase())) return `层级是系统保留名：${seg}`;
  }
  return null;
}

async function createFile(): Promise<void> {
  const prefix = currentDir.value ? `${currentDir.value}/` : '';
  let value: string;
  try {
    const result = await ElMessageBox.prompt(
      '输入工作区内的相对路径',
      '新建 / 打开文件',
      {
        inputValue: prefix,
        inputPlaceholder: 'subagents/planner.md',
        confirmButtonText: '打开',
        cancelButtonText: '取消',
        inputValidator: (input: string) => pathProblem(input) ?? true,
      },
    );
    value = result.value.trim();
  } catch {
    return; // 用户取消
  }
  /*
   * 只打开一张空编辑器，不立刻写盘。
   *
   * 直接写一个空文件的话，会出现"我明明取消了，磁盘上却多了一个空文件"——
   * 而工作区没有回收站，这种"顺手留下的垃圾"没人会去清理。
   */
  newFile.value = true;
  draft.value = '';
  savedDraft.value = '';
  openFile.value = value;
}

function refresh(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAll });
}

/** 根级文件不给 size（后端不为了显示一个数字去读全文），0 显示成“—”而不是“0 B”。 */
function sizeText(row: WorkspaceEntry): string {
  if (row.directory) return '—';
  return row.size > 0 ? formatBytes(row.size) : '—';
}
</script>
<template>
  <PageHeader
    :title="`${agentName} 的工作区`"
  >
    <template #actions>
      <el-button :disabled="busy" @click="refresh">刷新</el-button>
      <!--
        工作区与编排是同一个 harness agent 的两个面：这一页管文件内容，
        /harness/<name> 管工作区配置（后端类型、展示名）。两个入口并排，
        省掉"改完文件想去调配置"时绕侧栏一次。
      -->
      <el-button @click="router.push(harnessLink(agentName))">编排配置</el-button>
      <el-button @click="router.push(chatLink(agentName))">去对话</el-button>
      <el-button @click="router.push('/workspace')">← 返回工作区列表</el-button>
    </template>
  </PageHeader>

  <div class="stack">
    <PaneCard v-if="agents && !selected" title="找不到这个 agent">
      <EmptyState
        title="地址里的 agent 不在工作区清单里"
      >
        <template #action>
          <el-button size="small" @click="router.push('/workspace')">返回工作区列表</el-button>
        </template>
      </EmptyState>
    </PaneCard>

    <PaneCard v-else title="工作区信息">
      <KVList :items="agentKv" label-width="128px" />
    </PaneCard>

    <PaneCard title="隔离维度" :right="userId || '基线'">
      <div class="dim">
        <!-- 没有 clearable：基线层本身就是列表里的第一项，再给一个"清空"就是两条路做同一件事，
             而两条路的差别（清空后显示占位符还是"基线层"）没人说得清。 -->
        <el-select
          v-model="scopeModel"
          filterable
          allow-create
          placeholder="选择隔离维度"
          style="width: 360px"
        >
          <el-option
            v-for="opt in scopeOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          >
            <span class="opt">
              <span class="opt__label">{{ opt.label }}</span>
              <span class="opt__meta">{{ opt.meta }}</span>
            </span>
          </el-option>
        </el-select>
      </div>
    </PaneCard>

    <!-- 位置条：面包屑 + 新建。始终可见，进入文件后也用它回上一层。 -->
    <section class="loc">
      <nav class="loc__crumbs" aria-label="工作区路径">
        <template v-for="(crumb, index) in crumbs" :key="crumb.path">
          <span v-if="index > 0" class="loc__sep">/</span>
          <button
            type="button"
            class="loc__c"
            :class="{ last: index === crumbs.length - 1 }"
            @click="enterDir(crumb.path)"
          >
            {{ crumb.label }}
          </button>
        </template>
      </nav>
      <div class="loc__act">
        <el-button size="small" @click="createFile">新建 / 打开文件</el-button>
      </div>
    </section>

    <!-- ---------- 文件编辑器 ---------- -->
    <TableCard v-if="openFile" :title="openFile" :loading="fileLoading && !newFile">
      <template #actions>
        <AppBadge v-if="newFile" variant="wait">尚未写入</AppBadge>
        <AppBadge :variant="canWrite ? 'rw' : 'ro'">{{ canWrite ? '可写' : '只读' }}</AppBadge>
        <el-button
          size="small"
          :loading="busy"
          :disabled="!canWrite || !dirty"
          @click="saveMutation.mutate()"
        >
          保存
        </el-button>
        <el-button size="small" :disabled="busy" @click="backToList">返回列表</el-button>
      </template>

      <EmptyState
        v-if="fileError"
        title="读不到这个文件"
        :hint="messageOf(fileError)"
      >
        <template #action>
          <el-button size="small" @click="backToList">返回列表</el-button>
        </template>
      </EmptyState>

      <div v-else class="ed">
        <!-- 只读文件也允许打开：看得见才谈得上判断，只是不给写入口。 -->
        <AppNote v-if="file?.truncated">
          内容已截断，请勿直接保存。
        </AppNote>

        <el-input
          v-model="draft"
          type="textarea"
          :rows="22"
          resize="vertical"
          class="mono-input"
          :disabled="!canWrite"
          placeholder="文件内容（纯文本 / Markdown）"
        />
        <div class="ed__ft">
          <span class="hint">{{ draft.length }} 字符</span>
          <span v-if="dirty" class="ed__dirty">有未保存的改动</span>
          <span v-else-if="!newFile" class="hint">与服务端一致</span>
        </div>
      </div>

    </TableCard>

    <!-- ---------- 目录条目表 ---------- -->
    <TableCard
      v-else
      :title="currentDir ? `${currentDir}/` : '工作区根'"
      :count="entries.length"
      :loading="dirLoading && entries.length === 0"
    >
      <EmptyState
        v-if="dirError"
        title="读不到这个目录"
        :hint="messageOf(dirError)"
      />
      <EmptyState
        v-else-if="entries.length === 0"
        title="这个目录是空的"
      />
      <el-table v-else :data="entries">
        <el-table-column label="名称" min-width="280" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="ent">
              <button type="button" class="ent__n" @click="openEntry(row)">
                {{ row.name }}<span v-if="row.directory" class="ent__slash">/</span>
              </button>
              <AppBadge :variant="row.writable ? 'rw' : 'ro'">
                {{ row.writable ? '可写' : '只读' }}
              </AppBadge>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">{{ row.directory ? '目录' : '文件' }}</template>
        </el-table-column>
        <el-table-column label="大小" width="110" align="right">
          <template #default="{ row }"><span class="mono">{{ sizeText(row) }}</span></template>
        </el-table-column>
        <el-table-column label="修改时间" width="140">
          <template #default="{ row }">
            <span :title="row.modifiedAt || ''">{{ formatRelative(row.modifiedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" align="right">
          <template #default="{ row }">
            <el-button text size="small" @click="openEntry(row)">
              {{ row.directory ? '进入' : '打开' }}
            </el-button>
            <!-- 只读条目不渲染删除按钮：置灰的按钮会让人反复点，然后怀疑是页面坏了。 -->
            <el-button
              v-if="row.writable"
              text
              type="danger"
              size="small"
              :disabled="busy"
              @click="confirmDelete(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

    </TableCard>
  </div>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}
.dim {
  display: flex;
  align-items: center;
  gap: var(--s3);
  margin-bottom: var(--s3);
}
/*
 * 下拉项两段式：左边是 ID（要能一眼比对，用等宽），右边是规模与新鲜度。
 * 右段用 @supports 之外的常规做法 —— 定宽而不是 float，长 ID 也不会把它挤出去。
 */
.opt {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s5);
}
.opt__label {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--t1);
}
.opt__meta {
  font-size: 12px;
  color: var(--t3);
}

/* ---------- 位置条 ---------- */
.loc {
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-height: 52px;
  padding: 0 var(--s5);
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  box-shadow: var(--sh-card);
}
.loc__crumbs {
  display: flex;
  align-items: center;
  gap: var(--s1);
  min-width: 0;
  flex-wrap: wrap;
}
.loc__sep {
  color: var(--bd-strong);
}
.loc__c {
  padding: 2px 6px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--pri);
  font-size: 13.5px;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.loc__c:hover {
  background: var(--pri-soft);
}
/* 最后一段是当前位置，不是可跳转的目标：做成深色文字，去掉主色 */
.loc__c.last {
  color: var(--t1);
  font-weight: 600;
  cursor: default;
}
.loc__c.last:hover {
  background: transparent;
}
.loc__act {
  margin-left: auto;
}

/* ---------- 编辑器 ---------- */
.ed > * + * {
  margin-top: var(--s3);
}
.mono-input :deep(textarea) {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
}
.ed__ft {
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.ed__dirty {
  color: var(--amb);
  font-size: 13px;
}

/* ---------- 表格里的名称格 ---------- */
.ent {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
}
.ent__n {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--t1);
  font-size: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ent__n:hover {
  color: var(--pri);
}
.ent__slash {
  color: var(--t3);
}
</style>
