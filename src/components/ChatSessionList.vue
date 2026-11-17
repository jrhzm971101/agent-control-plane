<script setup lang="ts">
/*
 * 对话页左侧的「最近会话」。
 *
 * <h2>一、这一栏回答什么问题</h2>
 * 「我刚才是跟它聊到哪了」——在页面上聊过、在企微里聊过、飞书里聊过的，
 * 只要服务过同一个 agent，就都在这张清单里。点一条即**接着那条会话继续**：
 * 会话键与生效用户原样传回 chat 接口，于是落到同一个记忆分区
 * （框架按 (userId, sessionId) 分区，见后端 ChatStreamService 的注释）。
 *
 * <h2>二、为什么数据源是 /api/sessions 而不是状态存储</h2>
 * 状态存储的清单只有"还有记忆的"会话（记忆可能被清、也可能这个 agent 没开状态存储），
 * 而这里要回答的是"它被聊过哪些次"。run 表按 (user_id, session_id) 的聚合是唯一
 * 覆盖全部入口的口径 —— 会话记录页用的是同一个接口，只是那边带筛选与分页。
 *
 * <h2>三、为什么把 userId 也显示出来</h2>
 * 因为同一个 agent 会被很多个人聊。只显示 sessionId 的话，两条
 * "single-xxx-2026-09-29" 看起来一模一样，而它们其实是两个人的上下文 ——
 * 点错一条就是把话说给了另一个人（下文会续进对方的记忆里）。这栏里唯一能防住这件事的
 * 信息就是那个 userId，所以它必须在。
 */
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { fetchSessions, type SessionRow } from '@/api/sessions';
import { queryKeys } from '@/lib/queryKeys';
import { ellipsizeMiddle, formatRelative } from '@/lib/format';

const props = defineProps<{
  agentId: string;
  /** 当前打开的会话（后端回执的值），用来高亮那一行；还没聊过时都是空串。 */
  activeUserId: string;
  activeSessionId: string;
}>();

const emit = defineEmits<{ select: [userId: string, sessionId: string] }>();

/*
 * 一次拉多少条。
 *
 * 不翻页：这一栏要的是"最近几条"，不是"全部会话"——要找完整历史有会话记录页
 * （那里才有时间窗、来源、关键字与分页）。多给一点余量（50 而不是 10）
 * 是因为它不占额外开销：后端本来就把 run 表整表聚合出来，分页在内存里做。
 */
const FETCH_LIMIT = 50;

/* 整族失效时的前缀，与 queryKeys.sessions 的第一段必须一致（那里已经收敛成一个常量）。 */
const listQuery = computed(() => ({
  agentId: props.agentId,
  source: '',
  from: null,
  to: null,
  keyword: '',
  hasState: null,
  limit: FETCH_LIMIT,
  offset: 0,
}));

const { data, isLoading, error } = useQuery({
  queryKey: computed(() => queryKeys.sessions(listQuery.value)),
  queryFn: () => fetchSessions(listQuery.value),
  /*
   * agentId 还没定下来时不查（裸 /chat 会在列表到位后自动选第一个 agent）。
   * 不挡的话会先按"全部 agent"查一次，拿到一堆不属于这一栏的会话，
   * 而且那次结果还会被缓存下来。
   */
  enabled: () => Boolean(props.agentId),
});

const rows = computed<SessionRow[]>(() => data.value?.items ?? []);
const loadError = computed(() =>
  error.value ? String(error.value.message ?? error.value) : '',
);

/** 是不是当前打开的那条。userId 与 sessionId 要**同时**相等 —— 单看 sessionId 会误判。 */
function isActive(row: SessionRow): boolean {
  return row.userId === props.activeUserId && row.sessionId === props.activeSessionId;
}
</script>

<template>
  <aside class="rail" aria-label="最近会话">
    <div class="rail__hd">
      <b>最近会话</b>
      <span v-if="rows.length" class="rail__n">{{ rows.length }}</span>
    </div>
    <p v-if="!agentId" class="rail__msg">先选一个 agent</p>
    <p v-else-if="isLoading" class="rail__msg">加载中…</p>
    <p v-else-if="loadError" class="rail__msg rail__msg--err">{{ loadError }}</p>
    <p v-else-if="!rows.length" class="rail__msg">这个 agent 还没有会话记录</p>

    <div v-else class="rail__list">
      <!--
        key 用 userId + sessionId 两段拼：sessionId 由各入口自己算，不保证跨用户唯一
        （群聊用 chatId、单聊用 userId），只用它做 key 会在撞车时复用错节点。
      -->
      <button
        v-for="row in rows"
        :key="`${row.userId ?? ''}#${row.sessionId}`"
        class="sc"
        :class="{ on: isActive(row) }"
        type="button"
        @click="emit('select', row.userId ?? '', row.sessionId)"
      >
        <span class="sc__top">
          <!-- 记忆灯：绿=还有上下文，灰=没有（被清过，或这个 agent 没开状态存储） -->
          <span
            class="sc__dot"
            :class="{ 'sc__dot--mem': row.hasState }"
            :title="row.hasState ? '有记忆' : '无记忆'"
          />
          <span class="sc__id" :title="row.sessionId">{{ row.sessionId }}</span>
        </span>
        <span class="sc__sub">
          <span>{{ formatRelative(row.lastMs) }}</span>
          <span class="sc__sep">·</span>
          <span>{{ row.runs }} 次</span>
          <template v-if="row.userId">
            <span class="sc__sep">·</span>
            <span class="sc__user" :title="row.userId">{{ ellipsizeMiddle(row.userId, 5, 4) }}</span>
          </template>
        </span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  width: 264px;
  min-height: 0;
  padding: var(--s5) var(--s3) var(--s3);
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-card);
}
.rail__hd {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: 0 var(--s2);
}
.rail__hd b {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--t1);
}
/* 条数做成一个小胶囊：它和右侧「共 X 条」的表格口径一致，都是"这一栏里有多少" */
.rail__n {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--panel-tint);
  color: var(--t3);
  font-family: var(--mono);
  font-size: 11px;
}
.rail__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 右移 4px 给滚动条让位：不给的话最后一条的右边框会贴着滚动条 */
  padding-right: 4px;
}
.rail__msg {
  margin: var(--s3) var(--s2);
  color: var(--t3);
  font-size: 12.5px;
  line-height: 1.6;
}
.rail__msg--err {
  color: var(--red);
}

/* ---------- 一条会话 ---------- */
.sc {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  margin-bottom: 2px;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.sc:hover {
  background: var(--panel-soft);
  border-color: var(--bd);
}
/* 当前打开的那条：浅紫底 + 浅紫描边，与侧栏导航选中态同一套语言 */
.sc.on {
  background: var(--pri-soft);
  border-color: var(--pri-line);
}
.sc__top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sc__dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dot-wait);
}
.sc__dot--mem {
  background: var(--dot-ok);
}
.sc__id {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--t1);
  font-family: var(--mono);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc.on .sc__id {
  color: var(--pri-ink);
}
.sc__sub {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding-left: 12px;
  color: var(--t3);
  font-size: 11.5px;
}
.sc__sep {
  color: var(--bd-strong);
}
.sc__user {
  overflow: hidden;
  font-family: var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 窄窗口下整栏收起。它是"辅助导航"而不是主内容：宽度不够时优先保住对话本身，
 * 而且 264px 从一条 1440px 的窗口里拿走后，正文气泡会被折成很多行。
 */
@media (max-width: 1080px) {
  .rail {
    display: none;
  }
}
</style>
