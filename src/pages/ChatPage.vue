<script setup lang="ts">
/*
 * 对话 —— 直接在页面上用一下某个 agent。
 *
 * 这一页是「用」，不是「管」：没有筛选条、没有指标卡、没有表格。
 * 布局走路由的 meta.flush（见 app/router.ts）：外层内容区去掉内边距并把滚动权交给本页，
 * 否则输入框会被外层容器的滚动与底部内边距一起推出屏幕。
 *
 * 两个形态：
 * - 还没说过话 —— 整块居中，输入框放大，下面给几张建议卡片把空白填上（对齐方舟体验页的排法）；
 * - 说过话之后 —— 消息区占满中部并自己滚，输入框贴到底部。
 *   「贴底」是聊天界面的既定心智：输入框跟着最后一条消息跑，视线不用来回找。
 *
 * agent 从路由参数拿（/chat/:agentId），所以每个 agent 都有一个独立的地址 ——
 * 能刷新、能收藏、能贴给别人，而会话内容按 agent 分开存（见 features/chat/useChat.ts）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { Check, CopyDocument } from '@element-plus/icons-vue';
import { queryKeys } from '@/lib/queryKeys';
import { fetchChatAgents } from '@/features/chat/api';
import { useChat } from '@/features/chat/useChat';
import type { ChatTurn } from '@/features/chat/model';
import ChatComposer from '@/components/ChatComposer.vue';
import ChatMarkdown from '@/components/ChatMarkdown.vue';
import ChatSessionList from '@/components/ChatSessionList.vue';

const route = useRoute();
const router = useRouter();

const { data: agents, error: agentsError } = useQuery({
  queryKey: queryKeys.chatAgents,
  queryFn: fetchChatAgents,
});

/*
 * 选中的 agent 以路由参数为准，而不是组件里的一个 ref。
 * 这样「每个 agent 一个会话页面」就是地址栏里的事实；组件里再存一份 ref
 * 就会出现「地址栏写着 A、页面显示 B」的中间态。
 */
const agentId = computed(() => {
  const raw = route.params.agentId;
  return typeof raw === 'string' ? raw : '';
});

const {
  turns, sessionId, userId, sending, loadingHistory, error: chatError, lastTurn,
  send, stop, reset, openSession,
} = useChat(() => agentId.value);

const draft = ref('');
const scroller = ref<HTMLElement | null>(null);
const copyFeedback = ref<{ id: string; ok: boolean } | null>(null);
let copyFeedbackTimer = 0;

const agentList = computed(() => agents.value ?? []);

/*
 * 有没有"已经进到一个会话里"。
 *
 * 不只看 turns.length：点开一条历史会话时，会话键先到位、内容后到（中间还要等一次请求）。
 * 只看条数的话，那段时间页面会退回"首屏居中"的形态，等历史回来了再跳回对话形态 ——
 * 一次点击看起来像跳了两下。带上 sessionId 之后，点下去就立刻是对话形态。
 */
const hasThread = computed(() => turns.value.length > 0 || Boolean(sessionId.value));

const canSend = computed(() =>
  Boolean(draft.value.trim()) && !sending.value && !loadingHistory.value && Boolean(agentId.value),
);

/*
 * 进了一个会话、但里面一条消息也没有。
 *
 * 两种情况会走到这里，页面的说法是同一条：这个会话没留下可回放的上下文
 * （记忆被清过，或者这个 agent 根本没开状态存储）——两种都不影响"接着聊"。
 */
const historyEmpty = computed(() =>
  hasThread.value && !turns.value.length && !loadingHistory.value,
);

/**
 * 当前 agent 的展示名。
 *
 * <p>回落成 agentId 而不是空串：路由参数是用户能看见、也能手改的东西，
 * 列表还没回来时至少要让这句提示读得通，而不是变成"当前对话由  应答"。
 */
const agentLabel = computed(
  () => agentList.value.find((item) => item.name === agentId.value)?.displayName ?? agentId.value,
);

/* 列表拉回来之后替用户选第一个：只有一个 agent 时这是最省事的默认值，
   「什么都不选就发送」是这一页最没意义的错误。 */
watch(agentList, (list) => {
  if (!agentId.value && list.length) selectAgent(list[0].name);
}, { immediate: true });

/* agent 列表没拉回来的错误单独显示：它和「这次调用失败」不是一回事。 */
const loadError = computed(() =>
  agentsError.value ? String(agentsError.value.message ?? agentsError.value) : '',
);

/*
 * 首屏建议。只放「对任何 agent 都成立」的问题：
 * 这一页从列表里只取名字与类型（见 features/chat/api.ts 的 fetchChatAgents），
 * 拿不到每个 agent 的示例问法，
 * 写死业务问题（比如「把昨天的日志拉出来」）换个 agent 就是无效提问。
 */
const suggestions = [
  { title: '介绍一下你自己' },
  { title: '你能调用哪些工具？' },
  { title: '你的能力边界是什么？' },
  { title: '给我一个使用示例' },
];

function selectAgent(name: string): void {
  // replace 而不是 push：切换 agent 是「换内容」而不是「前进一页」，
  // 用 push 的话点几次下拉，浏览器的后退键要按很多下才离得开这一页。
  void router.replace({ name: 'chat', params: { agentId: name } });
}

/*
 * 新会话的键由后端在首帧回执（见 useChat 的 run 帧处理）。拿到它就意味着库里
 * 多了一条会话记录 —— 不刷新的话，用户刚聊完的那条要等下次进页面才会出现在左栏，
 * 看起来像"聊了但没记住"。
 *
 * 只失效列表那一族，不动详情：会话详情是另一个页面的缓存，跟这里没有关系。
 */
const queryClient = useQueryClient();
watch(sessionId, (value) => {
  if (value) void queryClient.invalidateQueries({ queryKey: queryKeys.sessionsList });
});

/*
 * 是否跟随到底部。
 *
 * 用户往上翻历史时必须停下来 —— 否则每个 delta 都把他拽回底部，
 * 「看历史」会变成「和页面抢滚动条」。留 80px 余量：贴底时浏览器取整后的
 * scrollTop 常常差 1~2px，阈值太小会让跟随忽开忽关。
 */
const stickToBottom = ref(true);
const STICK_THRESHOLD = 80;
let scrollFrame = 0;

function onStreamScroll(): void {
  const el = scroller.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
}

/** 用户主动发送时调用：意图明确，直接恢复跟随并贴底。 */
function followBottom(): void {
  stickToBottom.value = true;
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function nextFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  // jsdom 等没有 rAF 的环境退化成定时器；行为一致，只是不保证与绘制同帧。
  return window.setTimeout(callback, 16);
}

/*
 * 流式期间每个 delta 都会调用它，但真正的滚动合并到一帧一次。
 *
 * 不合并的话，SSE 一秒几十帧就是几十次「读 scrollHeight + 写 scrollTop」，
 * 而读 scrollHeight 会强制浏览器把整条长会话重新排版一遍 —— 这是历史越长、
 * 生成时越容易掉帧的直接原因。
 */
function scheduleFollowBottom(): void {
  if (scrollFrame) return;
  scrollFrame = nextFrame(() => {
    scrollFrame = 0;
    if (!stickToBottom.value) return;
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/*
 * 跟随滚动。监听的是「最后一条的长度」而不是 turns.length：
 * 增量文字是在同一条消息上长出来的，只看条数的话页面会停在原地不动。
 * 首屏形态下 scroller 还不存在，scheduleFollowBottom 自己会跳过。
 */
watch(
  () => [
    turns.value.length,
    lastTurn.value?.text.length ?? 0,
    // thinking 也要跟着看：思考区默认展开，它长高的时候页面得跟着往下让，
    // 不看这一项就会出现「思考在涨、视线停在原地」
    lastTurn.value?.thinking.length ?? 0,
    lastTurn.value?.activity ?? '',
  ] as const,
  () => {
    void nextTick(scheduleFollowBottom);
  },
);

/* 换 agent 时重新开始跟随：上一段对话滚动到哪里，和这一段无关。 */
watch(agentId, () => {
  stickToBottom.value = true;
  // 两个 agent 的消息条数/长度可能刚好相同，长度 watcher 不一定会触发，这里补一次。
  void nextTick(scheduleFollowBottom);
});

onBeforeUnmount(() => {
  if (scrollFrame) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollFrame);
    else clearTimeout(scrollFrame);
    scrollFrame = 0;
  }
  if (copyFeedbackTimer) {
    window.clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = 0;
  }
});

async function submit(): Promise<void> {
  if (!canSend.value) return;
  const content = draft.value.trim();
  // 先清空再 await：发送过程中接着打字不会被后面的赋值覆盖
  draft.value = '';
  followBottom();
  await send(content);
}

/** 点建议卡片 = 直接发出去，少一步「复制到输入框再按回车」。 */
async function useSuggestion(text: string): Promise<void> {
  if (!agentId.value || sending.value) return;
  draft.value = '';
  followBottom();
  await send(text);
}

/** 写入剪贴板：优先用 Clipboard API，非安全上下文回退到隐藏 textarea。 */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒或浏览器不支持时继续走兼容路径。
    }
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('复制失败');
}

async function copyTurn(turn: ChatTurn): Promise<void> {
  if (!turn.text) return;
  try {
    await writeClipboard(turn.text);
    copyFeedback.value = { id: turn.id, ok: true };
  } catch {
    copyFeedback.value = { id: turn.id, ok: false };
  }
  if (copyFeedbackTimer) window.clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = window.setTimeout(() => {
    copyFeedback.value = null;
    copyFeedbackTimer = 0;
  }, 1800);
}

function copyState(turn: ChatTurn): 'ok' | 'err' | '' {
  const feedback = copyFeedback.value;
  if (feedback?.id !== turn.id) return '';
  return feedback.ok ? 'ok' : 'err';
}

function copyLabel(turn: ChatTurn): string {
  const state = copyState(turn);
  if (state === 'ok') return '已复制';
  if (state === 'err') return '复制失败';
  return '复制';
}

function newConversation(): void {
  reset();
  draft.value = '';
  stickToBottom.value = true;
}

/**
 * 打开一条历史会话。
 *
 * 单独包一层而不是直接把 openSession 交给左栏：换会话后要重新开始跟随，
 * 否则上一条会话里"用户翻到了中间"的状态会带过来，新内容到达时不贴底。
 */
async function openHistoricalSession(targetUserId: string, targetSessionId: string): Promise<void> {
  stickToBottom.value = true;
  await openSession(targetUserId, targetSessionId);
}

/**
 * 展开 / 收起一条消息的思考过程。
 *
 * 顺手把 thinkingTouched 置位 —— 那是「用户亲手动过」的唯一标记，
 * 置位之后 useChat 里的自动展开 / 收起就不再干预了。
 */
function toggleThinking(turn: ChatTurn): void {
  turn.thinkingTouched = true;
  turn.thinkingOpen = !turn.thinkingOpen;
}

/**
 * 活动提示那一行显示什么。
 *
 * 后端给了动作（「正在调用 xxx」）就显示它；什么都没有时兜一句「思考中…」——
 * 空白气泡看起来像卡住了，而实际上模型正在想。
 * 条件里带上 `!turn.thinking`：思考内容已经在页面上滚了，不必再说一遍同样的话。
 */
function idleHint(turn: ChatTurn): string {
  if (turn.activity) return turn.activity;
  if (turn.status === 'streaming' && !turn.text && !turn.thinking) return '思考中…';
  return '';
}
</script>

<template>
  <div class="chat">
    <div class="chat__main">
      <!--
        左栏：这个 agent 的最近会话。点一条 = 接着那条会话继续（会话键与生效用户一起换）。
        它自己取数（/api/sessions 按 agentId 聚合），所以这一页只负责把当前会话的
        两个标识传下去用于高亮 —— 把取数写在这里会让这一页同时管"取数"与"渲染"两件事。
      -->
      <ChatSessionList
        :agent-id="agentId"
        :active-user-id="userId"
        :active-session-id="sessionId"
        @select="openHistoricalSession"
      />

      <div class="pane">
      <!-- 工具行：选 agent + 会话标识 + 新对话 -->
      <header class="bar">
        <!--
          选 agent 的按钮在等待回答时也不禁用：会话是按 agent 分开的，
          切到另一个 agent 就是进另一个会话，不该被上一个 agent 的进度拦住。
        -->
        <el-select
          class="bar__pick"
          :model-value="agentId"
          placeholder="选择 agent"
          filterable
          @change="selectAgent"
        >
          <!-- label 用展示名（选中后输入框里显示的就是它），value 仍然是运行时键 -->
          <el-option
            v-for="item in agentList"
            :key="item.name"
            :label="item.displayName"
            :value="item.name"
          >
            <span class="opt">
              <span class="opt__name">{{ item.displayName }}</span>
              <span class="opt__kind mono">{{ item.name }} · {{ item.type.toLowerCase() }}</span>
            </span>
          </el-option>
        </el-select>

        <div class="bar__right">
          <!--
            用户标识与会话键都直接露出来：它们是排查「上下文为什么没接上」
            和「这次产物写到哪个目录」时唯一有用的两条线索。后端回执之前不占位。
          -->
          <span v-if="userId" class="bar__meta">{{ userId }}</span>
          <span v-if="sessionId" class="bar__meta">{{ sessionId }}</span>
          <el-button :disabled="!hasThread || sending" @click="newConversation">新对话</el-button>
        </div>
      </header>

      <!-- 形态一：还没说过话 —— 整块居中 -->
      <div v-if="!hasThread" class="intro">
        <div class="intro__inner">
          <h2 class="intro__t">欢迎使用 Agent 平台</h2>
          <p class="intro__h">
            {{ agentId ? `当前对话由 ${agentLabel} 应答` : '正在加载 agent 列表…' }}
          </p>

          <ChatComposer
            v-model="draft"
            size="lg"
            :sending="sending"
            :sendable="canSend"
            @submit="submit"
            @stop="stop"
          />

          <div class="tips">
            <button
              v-for="tip in suggestions"
              :key="tip.title"
              class="tip"
              type="button"
              :disabled="!agentId || sending"
              @click="useSuggestion(tip.title)"
            >
              <span class="tip__t">{{ tip.title }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 形态二：说过话之后 —— 中部消息、底部输入 -->
      <template v-else>
        <div ref="scroller" class="stream" @scroll.passive="onStreamScroll">
          <div class="thread">
            <!--
              进了一个会话、但里面没有可回放的消息（见 historyEmpty 的注释）。
              加载中单独一句，因为"正在读"和"读出来是空的"对用户的含义完全不同。
            -->
            <p v-if="loadingHistory" class="hist">正在读取这条会话的上下文…</p>
            <p v-else-if="historyEmpty" class="hist">这条会话暂无历史消息。</p>
            <div v-for="turn in turns" :key="turn.id" class="msg" :class="turn.role">
              <div class="msg__wrap">
                <div class="bub">
                <!--
                  思考过程排在正文**上面**，有两个理由：
                  1. 时序上它本来就发生在正文之前；
                  2. 正文首字到达时思考区会自动收起，如果它在下面，正文会把整块往下顶 ——
                     「顶下去」和「收起来」撞在同一帧上，看起来像页面跳了一下。

                  与正文分开、可折叠，默认展开（见 model.ts 的 thinkingOpen）。
                  这里按纯文本 + pre-wrap 渲染，不再过一遍 Markdown：思考是「心路」不是「交付物」，
                  过渲染器只会让它比正文更抢眼；而且每多一处 v-html 就多一个 XSS 面。
                -->
                <div v-if="turn.thinking" class="think" :class="{ 'think--open': turn.thinkingOpen }">
                  <button
                    type="button"
                    class="think__hd"
                    :aria-expanded="turn.thinkingOpen"
                    @click="toggleThinking(turn)"
                  >
                    <span class="think__caret" />
                    思考过程
                  </button>
                  <p v-show="turn.thinkingOpen" class="think__bd">{{ turn.thinking }}</p>
                </div>

                <!--
                  agent 的回答按 Markdown 渲染（见 features/chat/markdown.ts）。
                  用户那条保持纯文本：他打什么就该看到什么，不该由渲染器替他解释星号和井号。
                  流式期间也照常渲染（markdown-it 对半截文本不抛异常），
                  光标由 CSS 挂在最后一个块级元素上，见 .bub__md--streaming。
                -->
                <ChatMarkdown
                  v-if="turn.text && turn.role === 'assistant'"
                  :text="turn.text"
                  :streaming="turn.status === 'streaming'"
                />
                <p v-else-if="turn.text" class="bub__text">{{ turn.text }}</p>

                <p v-if="idleHint(turn)" class="bub__act">
                  <span class="bub__dot" />{{ idleHint(turn) }}
                </p>
                <p v-if="turn.status === 'error'" class="bub__err">{{ turn.error || '调用失败' }}</p>
                <!--
                  链路入口：拿到 runId 才出现（见 features/chat/model.ts 的 ChatTurn.runId）。
                  只挂 agent 的回答上 —— run 是 agent 的一次执行，用户消息没有自己的 run。
                  刻意做成一行小字而不是按钮：它是排查用的坐标，不该和正文抢注意力。
                -->
                  <router-link v-if="turn.runId" class="bub__trace" :to="`/traces/${turn.runId}`">
                    执行链路 {{ turn.runId }}
                  </router-link>
                </div>

                <div v-if="turn.text" class="msg__tools">
                  <button
                    type="button"
                    class="msg__copy"
                    :class="{
                      'msg__copy--ok': copyState(turn) === 'ok',
                      'msg__copy--err': copyState(turn) === 'err',
                    }"
                    :title="copyLabel(turn)"
                    aria-label="复制这条消息"
                    @click="copyTurn(turn)"
                  >
                    <el-icon :size="13">
                      <Check v-if="copyState(turn) === 'ok'" />
                      <CopyDocument v-else />
                    </el-icon>
                    <span aria-live="polite">{{ copyLabel(turn) }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer class="foot">
          <div class="composer">
            <ChatComposer
              v-model="draft"
              :sending="sending"
              :sendable="canSend"
              @submit="submit"
              @stop="stop"
            />
          </div>
          <p v-if="loadError || chatError" class="foot__err">{{ loadError || chatError }}</p>
        </footer>
      </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 两栏：左边会话栏（组件自己管宽度，窄窗口下自己收起），右边是对话本体。
 * 整块仍然是"占满外层高度"的一格 —— 外层 .wrap 给了 height:100%，
 * 但 flex 子项不给高度时只会按内容撑，粘底部的输入框就会失效。
 */
.chat {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  height: 100%;
  min-height: 0;
  padding: var(--s5) var(--s6) var(--s6);
  background: var(--bg);
}
.chat__main {
  display: flex;
  flex: 1;
  flex-direction: row;
  gap: var(--s4);
  min-height: 0;
}
/* 对话本体：仍是「工具行 / 消息区 / 输入区」的竖排，只是不再是整页的唯一直系子节点 */
.pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--bd);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-card);
}

/* ---------- 工具行 ---------- */
/*
 * 只有一条下边框：它和内容区同色，靠这条线把「选项」和「对话」分开就够，
 * 不需要再给工具行一个底色（加了会变成第三个层次）。
 */
.bar {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex: 0 0 auto;
  height: 58px;
  padding: 0 var(--s6);
  position: relative;
}
.bar::after {
  content: '';
  position: absolute;
  right: var(--s6);
  bottom: 0;
  left: var(--s6);
  height: 1px;
  border-radius: 999px;
  background: linear-gradient(90deg, transparent, var(--bd) 12%, var(--bd) 88%, transparent);
}
.bar__pick {
  /*
   * 用 flex 基准宽度而不是 width：宽度是「想要」的，窄窗口下要能自己缩，
   * 而 flex 子项的 min-width 默认是 auto —— 不显式给 0，选择框宁可撑破
   * 工具行也不肯缩到内容宽度以下。
   */
  flex: 0 1 280px;
  min-width: 0;
}
.bar__right {
  display: flex;
  align-items: center;
  gap: var(--s3);
  margin-left: auto;
  min-width: 0;
}
.bar__meta {
  overflow: hidden;
  color: var(--t3);
  font-family: var(--mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * 下拉项：左边 agent 名，右边类型小字。
 * 用一层 flex 而不是给类型 span 加 float —— 下拉项本身的 display 是
 * Element 的样式决定的（不同版本在 block / flex 之间改过），
 * 靠 float 对齐会在换版本时悄悄失效，而 flex 在两种情况下都对。
 */
.opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
}
.opt__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.opt__kind {
  flex: 0 0 auto;
  color: var(--t3);
  font-size: 12px;
}

/*
 * 回放时的空态与加载态。刻意与消息气泡分开排：它不是"谁说的话"，
 * 而是页面在对"这里为什么是空的"做说明。
 */
.hist {
  max-width: 560px;
  margin: var(--s6) auto;
  color: var(--t3);
  font-size: 12.5px;
  line-height: 1.7;
  text-align: center;
}

/* ---------- 形态一：首屏 ---------- */
.intro {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow-y: auto;
  padding: var(--s6);
}
/*
 * 用 margin:auto 居中，而不是给 .intro 加 justify-content:center。
 * 后者在内容比容器高时会把顶部溢出到容器外面，而且滚不上去（flex 的经典坑）；
 * auto margin 在空间不够时会自己退回 0，内容从顶部开始排。
 */
.intro__inner {
  width: 100%;
  max-width: 760px;
  margin: auto;
}
.intro__t {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  text-align: center;
}
.intro__h {
  margin: var(--s3) 0 var(--s5);
  color: var(--t3);
  font-size: 13.5px;
  text-align: center;
}
.tips {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s3);
  margin-top: var(--s5);
}
.tip {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 14px;
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  background: var(--panel);
  box-shadow: var(--sh-card);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease);
}
.tip:hover:not(:disabled) {
  border-color: var(--pri-line);
  background: var(--panel-soft);
}
.tip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tip__t {
  color: var(--t1);
  font-size: 13.5px;
  font-weight: 550;
}
@media (max-width: 720px) {
  .tips {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* ---------- 形态二：消息 + 贴底输入 ---------- */
.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--s6) var(--s6) var(--s5);
}
.thread {
  max-width: 820px;
  margin: 0 auto;
}
.msg {
  display: flex;
  margin-bottom: var(--s5);
  /*
   * 长会话的 DOM 很容易到几千个节点。让浏览器跳过视口外消息的布局与绘制，
   * 滚动时只处理眼前这几条；auto 关键字会让浏览器记住每项实际渲染过的高度，
   * 避免离屏项按固定值估算导致滚动条长度反复跳变。
   */
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}
.msg.user {
  justify-content: flex-end;
}
.msg.assistant {
  justify-content: flex-start;
}
/*
 * 气泡与复制按钮一起收进这一层：用户消息的底色只包住正文，
 * 复制按钮排在气泡下方，不会把用户气泡整个撑高。
 */
.msg__wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 78%;
  min-width: 0;
}
.msg.user .msg__wrap {
  align-items: flex-end;
}
.msg.assistant .msg__wrap {
  max-width: 100%;
  align-items: stretch;
}
.bub {
  max-width: 100%;
  min-width: 0;
}
/* 用户消息给底块；agent 的回答不加底块，长文本套一层底色会很难读 */
.msg.user .bub {
  padding: 9px 14px;
  border-radius: var(--r-lg);
  background: var(--pri-soft);
  color: var(--t1);
}
.msg.assistant .bub {
  max-width: 100%;
}

/*
 * 复制动作。默认占位但不显示，悬停或键盘进入消息时浮出：
 * 既避免移动鼠标时消息上下跳，也不让每一条消息都多出一行常驻按钮。
 */
.msg__tools {
  display: flex;
  justify-content: flex-start;
  min-height: 22px;
  margin-top: 4px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-2px);
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.msg.user .msg__tools {
  justify-content: flex-end;
}
.msg:hover .msg__tools,
.msg:focus-within .msg__tools {
  opacity: 1;
  pointer-events: auto;
  transform: none;
}
.msg__copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 5px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--t3);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: color var(--dur) var(--ease), background-color var(--dur) var(--ease);
}
.msg__copy:hover {
  background: var(--panel-tint);
  color: var(--pri-ink);
}
.msg__copy--ok {
  color: var(--grn);
}
.msg__copy--err {
  color: var(--red);
}
/* 触屏没有 hover：按钮常驻，否则用户没有任何方式发现它。 */
@media (hover: none) {
  .msg__tools {
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }
}
.bub__text {
  margin: 0;
  font-size: 14px;
  line-height: 1.75;
  /* 用户那条按纯文本保留换行；agent 那条走 Markdown，见下面的 .bub__md */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/*
 * Markdown 正文。
 *
 * 为什么每条规则都套 :deep()：v-html 生成的节点不带 scoped 的 data-v 属性，
 * 不套 :deep 的选择器一条都命中不了 —— 表现是"标签渲染出来了但没有样式"。
 * 这种半生效最容易被误判成 markdown-it 的问题，所以在源头上写清楚。
 */
.bub__md {
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
.bub__md :deep(p) {
  margin: 0 0 10px;
}
/* 首尾段落不吃外边距：气泡里多出来的空白会让人以为消息之间错了位 */
.bub__md :deep(p:first-child) {
  margin-top: 0;
}
.bub__md :deep(p:last-child) {
  margin-bottom: 0;
}
.bub__md :deep(h1),
.bub__md :deep(h2),
.bub__md :deep(h3),
.bub__md :deep(h4) {
  margin: 14px 0 8px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
}
.bub__md :deep(h1:first-child),
.bub__md :deep(h2:first-child),
.bub__md :deep(h3:first-child),
.bub__md :deep(h4:first-child) {
  margin-top: 0;
}
.bub__md :deep(ul),
.bub__md :deep(ol) {
  margin: 0 0 10px;
  padding-left: 22px;
}
.bub__md :deep(li) {
  margin: 2px 0;
}
/* 行内代码：给块底色，不加描边（正文里带框的片段看着像输入框） */
.bub__md :deep(code) {
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--panel-sunken);
  font-family: var(--mono);
  font-size: 12.5px;
}
.bub__md :deep(pre) {
  margin: 0 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  background: var(--panel-sunken);
  overflow-x: auto;
}
/*
 * 块级代码要覆盖掉上面的行内样式：否则内边距叠加、底色再叠一层，
 * 内容被挤在角落里，看起来像被截断了。
 */
.bub__md :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 12.5px;
  line-height: 1.6;
}
.bub__md :deep(blockquote) {
  margin: 0 0 10px;
  padding: 2px 0 2px 12px;
  border-left: 3px solid var(--pri-line);
  color: var(--t2);
}
.bub__md :deep(a) {
  color: var(--pri-ink);
  text-decoration: none;
  border-bottom: 1px solid var(--pri-line);
}
.bub__md :deep(a:hover) {
  border-bottom-color: var(--pri-ink);
}
.bub__md :deep(table) {
  margin: 0 0 10px;
  border-collapse: collapse;
  font-size: 13px;
}
.bub__md :deep(th),
.bub__md :deep(td) {
  padding: 5px 10px;
  border: 1px solid var(--bd);
  text-align: left;
}
.bub__md :deep(th) {
  background: var(--panel-soft);
  font-weight: 600;
}
.bub__md :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid var(--bd);
}
.bub__md :deep(img) {
  max-width: 100%;
}

/*
 * 生成中的光标。
 *
 * 挂在「最后一个块级元素」的末尾，而不是加一个独立的 <span>：Markdown 渲染出来的
 * 是一串块级元素，独立 span 永远掉到正文下方另起一行，看起来像另一条消息。
 * 用直接子元素选择器（> :last-child）而不是 :last-child：后者会把最后一个段落里的
 * 行内元素（比如结尾的 <strong>）也选中，于是页面上出现两个光标。
 */
.bub__md--streaming :deep(> :last-child)::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 3px;
  border-radius: 1px;
  background: var(--pri);
  vertical-align: -2px;
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink {
  to {
    visibility: hidden;
  }
}
.bub__act {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  color: var(--t3);
  font-size: 13px;
}

/* ---------- 思考过程 ---------- */
/*
 * 折叠头做成一个铺满整行的按钮：比只点那个小三角好按。
 * 但样式刻意做得像「标签」而不是「按钮」—— 它是旁注，不该跟正文抢注意力，
 * 所以默认只给灰字 + 无边框，悬停时才浮出底色。
 */
/* 整块与下面的正文留一点空：思考区贴太紧会被读成正文的一部分 */
.think {
  margin-bottom: 8px;
}
.think__hd {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 6px 1px 3px;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  color: var(--t3);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.think__hd:hover {
  color: var(--pri-ink);
  background: var(--panel-tint);
}
/*
 * 三角用纯 CSS 画，不引图标组件：这里只有一个形状，
 * 为它挂一个图标依赖不划算。currentColor 让三角跟着上面的文字色一起变。
 */
.think__caret {
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor;
  transition: transform var(--dur) var(--ease);
}
.think--open .think__caret {
  transform: rotate(90deg);
}
/*
 * 思考正文。
 * - 左侧一条浅竖线 + 灰字：与正文拉开层级，读起来像「旁注」而不是「回答」
 * - max-height 自己滚：模型的长思考动辄几千字，全展开会把正文顶出屏幕 ——
 *   思考是要能撇一眼的，不是要占满视野的
 * - pre-wrap：思考里常靠换行分行推理，不保留换行会挤成一坨
 */
.think__bd {
  margin: 6px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--bd-strong);
  max-height: 220px;
  overflow-y: auto;
  color: var(--t3);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bub__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dot-run);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
.bub__err {
  margin: 6px 0 0;
  color: var(--red);
  font-size: 13px;
  overflow-wrap: anywhere;
}

/* 链路入口：等宽小字 + 虚线下划线，读起来像"坐标"而不是"操作按钮" */
.bub__trace {
  display: inline-block;
  margin-top: 6px;
  color: var(--t3);
  font-family: var(--mono);
  font-size: 12px;
  text-decoration: none;
  border-bottom: 1px dashed var(--bd);
}
.bub__trace:hover {
  color: var(--pri-ink);
  border-bottom-color: var(--pri-line);
}

.foot {
  flex: 0 0 auto;
  padding: 0 var(--s6) var(--s5);
}
.composer {
  max-width: 820px;
  margin: 0 auto;
}
.foot__err {
  max-width: 820px;
  margin: var(--s2) auto 0;
  color: var(--red);
  font-size: 13px;
}
</style>
