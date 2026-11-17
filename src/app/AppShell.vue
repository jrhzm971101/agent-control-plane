<script setup lang="ts">
/*
 * 控制台外壳：左侧导航 + 顶栏 + 内容区。
 *
 * 内容区只放 <router-view />，页面自己负责标题与操作按钮。
 * 顶栏只放搜索与门户；已打开页面的标签单独占一条横向标签带，
 * 位于顶栏下方、与内容区左对齐。两段式头部能让标签和全局操作各归其位，
 * 页面切换不再和搜索入口挤在同一条线上。
 *
 * 分层只靠底色差：顶栏与侧栏共用「外壳色」（--bg，灰紫），内容区是纯白（--panel），
 * 边界自然就出来了，不需要投影把「区块」和「背景」硬切开。
 * 品牌区占顶栏左侧、与侧栏同宽，视觉上和侧栏连成一列 —— 这是方舟的排法。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Box,
  ChatLineSquare,
  ChatDotRound,
  Close,
  Connection,
  Coin,
  Cpu,
  Document,
  Filter,
  Folder,
  Grid,
  Guide,
  HomeFilled,
  Message,
  Odometer,
  Operation,
  Search,
  Share,
  Star,
  Tools,
  TopRight,
  User,
} from '@element-plus/icons-vue';
import CommandPalette from './CommandPalette.vue';
import RouteBoundary from './RouteBoundary.vue';
import { navGroups } from './nav';
import { otherPlatforms, PORTAL_URL, type PlatformEntry } from './platforms';
import { tabKeyForRoute, tabTitleForRoute, type PageTab } from './tabs';

const route = useRoute();
const router = useRouter();
const paletteOpen = ref(false);

/*
 * 平台切换抽屉。与搜索弹窗（paletteOpen）同一套路：壳里只放触发器，内容写在这一处。
 *
 * 形态与搜索窗不同是有意的：搜索窗是"打字找东西"，居中最顺手；
 * 而这里的触发器钉在左上角品牌区，抽屉就从左侧滑出 —— 触发器在哪条边上，
 * 面板就从哪条边上出来，动作和结果才对得上（见下面模板里的注释）。
 *
 * 候选列表不含当前平台 —— 列一个点了没反应的自己，除了让列表变长没有任何作用。
 */
const platformOpen = ref(false);
const platformOptions = otherPlatforms();

/*
 * 整页跳转。跨应用只有这一种做法（理由见 app/platforms.ts 的文件头），
 * 所以这里刻意不用 router —— 用 router 的话，跳一个别的应用的路径会落到本应用的兜底路由，
 * 表现是"点了切换平台，页面重渲染了一次，位置没变"。
 */
function navigateTo(url: string): void {
  window.location.assign(url);
}

function goPlatform(item: PlatformEntry): void {
  platformOpen.value = false;
  navigateTo(item.path);
}

function goPortal(): void {
  platformOpen.value = false;
  navigateTo(PORTAL_URL);
}

const iconMap = {
  overview: Odometer,
  chat: ChatLineSquare,
  traces: Share,
  sessions: ChatDotRound,
  agents: User,
  harness: Connection,
  workspace: Folder,
  workflows: Operation,
  tools: Tools,
  skills: Star,
  prompts: Document,
  mcp: Box,
  middleware: Filter,
  channels: Message,
  /* Gateway 用路标（Guide）：它管的正是「消息往哪个 agent 走」这件事。
     同一份 iconMap 里 Connection 已经给了 Harness 工作台、Share 给了执行链路，
     Guide 与之语义都不重叠。 */
  gateway: Guide,
  models: Cpu,
  environments: Grid,
  storage: Coin,
} as const;

/*
 * 页面标签页。
 *
 * 这里维护的是「打开过哪些页面」，而不是「路由历史」：从侧栏进同一页只激活已有标签，
 * 不会再生一条。标签的 path 每次路由变化都更新为 fullPath，所以 Agent 详情里选过的
 * 子页签、列表页里填过的查询串，点回来时都还在。
 *
 * KeepAlive 的 key 由「页面 key + 打开序号」组成：切走再切回保持原状态；
 * 关闭后重新打开则拿到一份新实例，不会把已关闭页面的旧草稿带回来。
 */
const TAB_STORAGE_KEY = 'agent-control-plane:open-tabs';
/*
 * 测试里每挂载一次 AppShell 都会重置组件，但 sessionStorage 在同一个 jsdom 里是共享的，
 * 恢复上一次用例留下的标签会让「当前只有一条标签」这类断言失真，所以测试模式不恢复。
 */
const PERSIST_TABS = import.meta.env.MODE !== 'test';

interface StoredTabs {
  tabs: PageTab[];
  seq: number;
}

/** 读取上一次会话留下的标签；任何异常都退化成空列表，不能影响控制台启动。 */
function readStoredTabs(): StoredTabs {
  if (!PERSIST_TABS) return { tabs: [], seq: 0 };
  try {
    const raw = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (!raw) return { tabs: [], seq: 0 };
    const parsed = JSON.parse(raw) as Partial<StoredTabs>;
    if (!Array.isArray(parsed.tabs)) return { tabs: [], seq: 0 };

    const restored: PageTab[] = [];
    const seen = new Set<string>();
    for (const item of parsed.tabs) {
      if (!item || typeof item.key !== 'string' || typeof item.path !== 'string') continue;
      if (typeof item.title !== 'string' || seen.has(item.key)) continue;
      // 路由改过之后旧地址可能已经不存在，恢复到兜底页反而像是"标签坏了"。
      if (!router.resolve(item.path).name) continue;
      seen.add(item.key);
      restored.push({
        key: item.key,
        path: item.path,
        title: item.title,
        instance: typeof item.instance === 'number' ? item.instance : restored.length + 1,
      });
    }

    return {
      tabs: restored,
      seq: Math.max(Number(parsed.seq) || 0, ...restored.map((tab) => tab.instance)),
    };
  } catch {
    return { tabs: [], seq: 0 };
  }
}

const storedTabs = readStoredTabs();
const tabs = ref<PageTab[]>(storedTabs.tabs);
const activeTabKey = ref('');
const activeViewKey = ref('');
const tabsRef = ref<HTMLElement | null>(null);
const bodyRef = ref<HTMLElement | null>(null);
const scrollTops = new Map<string, number>();
let tabInstanceSeq = storedTabs.seq;

/** 切页前记住当前内容区的滚动位置，切回来时恢复。 */
function rememberScroll(): void {
  if (bodyRef.value && activeTabKey.value) {
    scrollTops.set(activeTabKey.value, bodyRef.value.scrollTop);
  }
}

function syncTab(): void {
  const key = tabKeyForRoute(route);
  const changed = key !== activeTabKey.value;
  if (changed) rememberScroll();

  const existing = tabs.value.find((tab) => tab.key === key);
  if (existing) {
    existing.path = route.fullPath;
    existing.title = tabTitleForRoute(route);
    activeViewKey.value = `${existing.key}#${existing.instance}`;
  } else {
    const tab: PageTab = {
      key,
      path: route.fullPath,
      title: tabTitleForRoute(route),
      instance: ++tabInstanceSeq,
    };
    tabs.value.push(tab);
    activeViewKey.value = `${tab.key}#${tab.instance}`;
  }
  activeTabKey.value = key;

  if (changed) {
    void nextTick(() => {
      if (bodyRef.value) bodyRef.value.scrollTop = scrollTops.get(key) ?? 0;
      // 标签超出可视宽度时，切页后把当前标签带回视野，避免高亮项藏在滚动区外。
      const activeTab = tabsRef.value?.querySelector<HTMLElement>('.tab.on');
      // 测试环境的 DOM 未实现该 API，只在浏览器里做滚动。
      if (typeof activeTab?.scrollIntoView === 'function') {
        activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }
}

watch(() => route.fullPath, syncTab, { immediate: true });

/*
 * 标签栏平时只在内存里，浏览器一旦整页刷新（dev 依赖优化、手按 F5、改 vite 配置）
 * 就会全部消失。这里写进 sessionStorage：刷新后恢复列表，当前路由对应的标签
 * 仍由 syncTab 重新激活。用 sessionStorage 而不是 localStorage，
 * 是为了让新开的浏览器会话拿到干净的标签，不与上一次的残留混在一起。
 */
if (PERSIST_TABS) {
  watch(
    tabs,
    () => {
      try {
        sessionStorage.setItem(
          TAB_STORAGE_KEY,
          JSON.stringify({ tabs: tabs.value, seq: tabInstanceSeq }),
        );
      } catch {
        // 隐私模式 / 配额不足：忽略即可，标签栏本身仍然可用。
      }
    },
    { deep: true, immediate: true },
  );
}

function activateTab(tab: PageTab): void {
  if (tab.key !== activeTabKey.value) void router.push(tab.path);
}

function closeTab(tab: PageTab): void {
  const index = tabs.value.findIndex((item) => item.key === tab.key);
  if (index < 0) return;
  const wasActive = tab.key === activeTabKey.value;
  const fallback = tabs.value[index + 1] ?? tabs.value[index - 1] ?? null;
  tabs.value.splice(index, 1);
  scrollTops.delete(tab.key);
  if (!wasActive) return;

  // 先让当前页保持渲染，等目标路由确认后再由 syncTab 换 key，避免中间态闪一下。
  activeTabKey.value = '';
  void router.replace(fallback ? fallback.path : '/');
}

const isActive = (path: string) =>
  path === '/' ? route.path === '/' : route.path === path || route.path.startsWith(`${path}/`);

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    paletteOpen.value = true;
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="app">
    <!-- 品牌区放在外壳左上角，和顶栏同一行 -->
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <!-- 品牌标识：AgentScope 官方 mark，与官网左上角、以及 /favicon.svg 是同一份图形 -->
        <img src="/brand-logo.svg" alt="" />
      </div>
      <div class="brand__tx">
        <b>Agent Platform</b>
        <em>编排与运行控制台</em>
      </div>
      <!--
        切换平台。格状图标是"应用全家桶"的通用隐喻（各家控制台同款）。
        这里只放图标不放文字：品牌区的宽度就是侧栏宽度（--side-w，244px），
        再加一句文字会把 "Agent Platform" 挤成省略号。
      -->
      <button
        class="switchbtn"
        type="button"
        title="切换平台"
        aria-label="切换平台"
        @click="platformOpen = true"
      >
        <el-icon :size="15"><Grid /></el-icon>
      </button>
    </div>

    <div class="top">
      <!-- 顶栏只保留全局动作：搜索与门户。页面标签在下方独立成带。 -->
      <button class="srch" type="button" @click="paletteOpen = true">
        <el-icon :size="14"><Search /></el-icon>
        <span>搜索 agent / 工具 / MCP…</span>
        <kbd>⌘K</kbd>
      </button>
      <!--
        返回统一门户。放在顶栏最右、而不是品牌区：品牌区的宽度就是侧栏宽度，
        塞不下第二颗带文字的按钮（见上面那颗切换按钮的注释）。

        始终可点，不要在这里加 disabled。曾经按 portalIsSelf 把它禁掉过，
        理由是"本地开发时门户地址就是本应用根路径，点下去只是回到概览页"。
        但顶栏常驻一颗永久灰着的按钮，比"点了之后没跳远"更像坏了 ——
        灰是在渲染前就宣告此路不通，而通不通取决于部署形态，用户看不到那个条件。
        现在照跳，把实际目标地址写进 title，由用户自己判断。
      -->
      <button
        class="portbtn"
        type="button"
        title="返回统一门户"
        @click="goPortal"
      >
        <el-icon :size="14"><HomeFilled /></el-icon>
        <span>门户</span>
      </button>
    </div>

    <!--
      已打开页面的标签带。与内容区共用左边界，不跨到品牌区与侧栏上方；
      页面标题由内容区自己的 PageHeader 承担，这里不再重复。
    -->
    <nav ref="tabsRef" class="tabs" role="tablist" aria-label="已打开页面">
      <div
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ on: tab.key === activeTabKey }"
        :title="tab.title"
        role="tab"
        :aria-selected="tab.key === activeTabKey"
        tabindex="0"
        @click="activateTab(tab)"
        @keydown.enter.prevent="activateTab(tab)"
        @keydown.space.prevent="activateTab(tab)"
      >
        <span class="tab__t">{{ tab.title }}</span>
        <button
          class="tab__x"
          type="button"
          :aria-label="`关闭 ${tab.title}`"
          @click.stop="closeTab(tab)"
        >
          <el-icon :size="12"><Close /></el-icon>
        </button>
      </div>
    </nav>

    <aside class="side">
      <nav class="nav" aria-label="主导航">
        <template v-for="group in navGroups" :key="group.title || 'root'">
          <div v-if="group.title" class="grp">{{ group.title }}</div>
          <router-link
            v-for="item in group.items"
            :key="item.key"
            class="item"
            :class="{ on: isActive(item.path) }"
            :to="item.path"
          >
            <el-icon :size="15">
              <component :is="iconMap[item.key as keyof typeof iconMap]" />
            </el-icon>
            <span class="item__lb">{{ item.label }}</span>
          </router-link>
        </template>
      </nav>

      <div class="sfoot">
        <span class="sfoot__av">AD</span>
        <span class="sfoot__tx">
          <em>已登录</em>
          <b>admin</b>
        </span>
        <button class="sfoot__set" type="button" @click="paletteOpen = true">设置</button>
      </div>
    </aside>

    <main class="main">
      <!-- flush：内容区去掉内边距并交出滚动权，由页面自己管整屏布局（对话页用） -->
      <div ref="bodyRef" class="body" :class="{ flush: route.meta.flush }">
        <div class="wrap" :class="{ wide: route.meta.wide }">
          <!-- 兜一层错误边界：单页渲染异常不应该把整个控制台带白屏。 -->
          <RouteBoundary>
            <router-view v-slot="{ Component }">
              <keep-alive :max="20">
                <component :is="Component" :key="activeViewKey || route.path" />
              </keep-alive>
            </router-view>
          </RouteBoundary>
        </div>
      </div>
    </main>

    <CommandPalette v-model="paletteOpen" />

    <!--
      切换平台抽屉。
      内容与门户首页的三张卡片同源（见 app/platforms.ts）：同样的三条、同样的 code，
      只是这里排成竖列。

      形态是「从左侧滑出」而不是居中弹窗：触发器就在左上角品牌区，抽屉从同一条边上出来，
      视觉上像是从那颗按钮上长出来的；居中弹窗与触发器之间隔着半个屏幕，动作和结果对不上。
      竖列在抽屉的窄栏里也更自然 —— 每条都要放一句说明，横排会把说明压成省略号。
    -->
    <el-drawer v-model="platformOpen" title="切换平台" direction="ltr" size="360px">
      <div class="plats">
        <button
          v-for="item in platformOptions"
          :key="item.code"
          class="plat"
          type="button"
          @click="goPlatform(item)"
        >
          <span class="plat__tile">{{ item.en.slice(0, 1) }}</span>
          <span class="plat__tx">
            <b>{{ item.name }}</b>
          </span>
          <el-icon class="plat__go" :size="14"><TopRight /></el-icon>
        </button>

        <button class="plat" type="button" @click="goPortal">
          <span class="plat__tile plat__tile--home">门</span>
          <span class="plat__tx">
            <b>统一门户</b>
          </span>
          <el-icon class="plat__go" :size="14"><TopRight /></el-icon>
        </button>
      </div>

    </el-drawer>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: var(--side-w) minmax(0, 1fr);
  grid-template-rows: var(--top-h) var(--tab-h) minmax(0, 1fr);
  grid-template-areas:
    'brand top'
    'side tabs'
    'side main';
  height: 100vh;
  background: var(--panel);
}

/* ---------- 侧栏 ---------- */
.side {
  grid-area: side;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
.brand {
  grid-area: brand;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 var(--s4);
  background: var(--bg);
  border-bottom: 1px solid var(--bd);
}
.logo {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: var(--r-md);
  /* 标识本身是彩色渐变，底衬再上色会互相打架；而外壳底色比内容区深，
     纯白底必须配一条极浅描边，否则方块边界会糊掉。 */
  background: var(--panel);
  border: 1px solid var(--bd);
}
/* 标识是横向图形（约 1.29:1）：只定宽度，高度按比例，避免拉伸变形 */
.logo img {
  display: block;
  width: 24px;
  height: auto;
}
.brand__tx b {
  display: block;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
.brand__tx em {
  display: block;
  font-style: normal;
  font-size: 12px;
  color: var(--t3);
  letter-spacing: 0.02em;
}

/* ---------- 导航 ---------- */
.nav {
  flex: 1;
  overflow-y: auto;
  padding: var(--s1) var(--s3) var(--s3);
}
.grp {
  padding: var(--s4) var(--s2) 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--t3);
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px;
  margin-bottom: 2px;
  border-radius: var(--r-md);
  color: var(--t2);
  font-size: 15px;
  font-weight: 500;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.item:hover {
  background: var(--panel-tint);
  color: var(--t1);
}
.item.on {
  background: var(--pri-soft);
  color: var(--pri-ink);
  font-weight: 600;
}
.item__lb {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sfoot {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s3) var(--s4);
}
.sfoot__av {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  background: var(--pri-soft);
  color: var(--pri-ink);
  font-size: 11.5px;
  font-weight: 700;
}
.sfoot__tx {
  min-width: 0;
}
.sfoot__tx em {
  display: block;
  font-style: normal;
  font-size: 11px;
  color: var(--t3);
}
.sfoot__tx b {
  display: block;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sfoot__set {
  margin-left: auto;
  padding: 0;
  border: none;
  background: none;
  color: var(--t3);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.sfoot__set:hover {
  color: var(--pri);
}

/* ---------- 主区 ---------- */
.main {
  grid-area: main;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  /* 内容画布用淡紫外壳色，页面里的卡片 / 表格 / 面板保持纯白，
     靠底色与白色表面的明度差形成层次；不再让整页都是白色。 */
  background: var(--bg);
}
/* 顶栏与下方标签带之间用一条贯穿整宽的浅描边分开：
   两段都是外壳色，不加线时标签会像浮在同一块灰色上。 */
.top {
  grid-area: top;
  display: flex;
  align-items: center;
  gap: var(--s3);
  border-bottom: 1px solid var(--bd);
  padding: 0 var(--s6);
  background: var(--bg);
  justify-content: flex-end;
}
.tabs {
  grid-area: tabs;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: var(--tab-h);
  padding: 0 var(--s6);
  background: var(--panel);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.srch {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  width: 288px;
  height: var(--ctl-h);
  padding: 0 10px;
  background: var(--panel);
  border: 1px solid var(--bd);
  /* 与其它输入框同一档 6px */
  border-radius: var(--r-sm);
  color: var(--t3);
  font-family: inherit;
  font-size: 13.5px;
  cursor: text;
  transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease);
}
.srch:hover {
  border-color: var(--bd-strong);
}
.srch span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srch kbd {
  margin-left: auto;
  padding: 0 5px;
  background: var(--panel-soft);
  border: 1px solid var(--bd);
  border-radius: var(--r-xs);
  color: var(--t3);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 18px;
}
.tabs::-webkit-scrollbar {
  display: none;
}
.tab {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  max-width: 240px;
  height: 30px;
  padding: 0 8px 0 12px;
  background: var(--panel);
  border: 1px solid var(--bd-strong);
  border-radius: var(--r-sm);
  color: var(--t3);
  font-size: 13px;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.tab:hover {
  background: var(--panel-soft);
  border-color: var(--bd-strong);
  color: var(--t1);
}
.tab.on {
  background: var(--pri-soft);
  border-color: var(--pri-line);
  color: var(--pri-ink);
  box-shadow: none;
}
.tab:focus-visible {
  outline: 2px solid var(--pri-line);
  outline-offset: 2px;
}
.tab__t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab__x {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--t3);
  opacity: 0.55;
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}
.tab:hover .tab__x,
.tab.on .tab__x {
  opacity: 1;
}
.tab__x:hover {
  background: var(--panel-tint);
  color: var(--t1);
}
.body {
  flex: 1;
  overflow-y: auto;
  /* 标题区上方只留一档 20px，页尾留 40px 供滚动收尾；
     原先 32 / 80 的上下留白在大屏上会显得空。 */
  padding: var(--s5) var(--s6) var(--s8);
}
.wrap {
  max-width: var(--wrap);
}
.wrap.wide {
  max-width: var(--wrap-wide);
}
/*
 * flush 页面（对话页）：去掉内边距、容器不再限宽、把自己撑满一整格。
 *
 * 三件事必须一起做 —— 只去 padding 的话，页面里的 height:100% 仍然会去量
 * .wrap 的高度，而 .wrap 没设高度就只是内容高，"粘底部的输入框"会失效。
 */
.body.flush {
  padding: 0;
  overflow: hidden;
}
.body.flush .wrap {
  max-width: none;
  height: 100%;
}

@media (max-width: 900px) {
  .srch span {
    display: none;
  }
  .srch {
    width: auto;
  }
}

/* ---------- 平台切换 ---------- */
/*
 * 品牌区那颗：只留图标，靠 margin-left:auto 贴到品牌区最右。
 * 不给它常驻底色 —— 品牌区整块是外壳色，多一个填色方块会把"品牌"和"按钮"混成一件事。
 */
.switchbtn {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  margin-left: auto;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: none;
  color: var(--t3);
  cursor: pointer;
  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.switchbtn:hover {
  background: var(--panel-tint);
  color: var(--t1);
}

/* 顶栏那颗：与搜索框同一档高度（--ctl-h）与圆角（6px），并排时不会一高一低。 */
.portbtn {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  height: var(--ctl-h);
  padding: 0 11px;
  border: 1px solid var(--bd);
  border-radius: var(--r-sm);
  background: var(--panel);
  color: var(--t2);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease);
}
.portbtn:hover {
  border-color: var(--bd-strong);
  background: var(--panel-soft);
  color: var(--t1);
}

/* 抽屉里的平台条目。竖列而不是栅格：每条都要放下一句说明，横排会把说明压成省略号。 */
.plats {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}
.plat {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: 12px;
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  background: var(--panel);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease);
}
.plat:hover {
  border-color: var(--pri-line);
  background: var(--panel-soft);
}
/* 首字母方块：用 en 的首字母而不是 code，是因为 en 恰好也是用户在两处见到的那个英文名 */
.plat__tile {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: var(--r-md);
  background: var(--pri-soft);
  color: var(--pri-ink);
  font-size: 13px;
  font-weight: 700;
}
.plat__tile--home {
  background: var(--panel-tint);
  color: var(--t2);
}
.plat__tx {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.plat__tx b {
  font-size: 13.5px;
  font-weight: 550;
  color: var(--t1);
}
.plat__go {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--t3);
}
</style>
