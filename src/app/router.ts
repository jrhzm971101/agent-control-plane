/*
 * 路由表。
 *
 * 路径命名与官方控制面保持一致（/agents、/sessions、/traces …），
 * 以后接官方接口或做深链分享时不需要再改一遍。
 *
 * meta.wide：把页面容器从 1240px 放宽到 1560px。凡是「多列表格 / 多层调用树」
 * 的页面都要打开 —— 这些页面的列是按内容量排的，压在 1240px 里会把列挤到截断。
 * 偏阅读的页面（概览、Agents 卡片墙、状态存储）保持窄栏，行长才好读。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** 放宽页面容器宽度，见文件头说明。 */
    wide?: boolean;
    /**
     * 去掉内容区的外边距，并把滚动权交给页面自己。
     *
     * <p>只有「整屏自成一体」的页面需要它（目前是对话页）：输入框要贴着窗口底部，
     * 而外层内容区带着 32px 内边距与 80px 底部留白，夹在里面会被顶出可视区，
     * 还得再算一版「减去 padding 的高度」——那种写法在窗口缩放时最容易错位。
     */
    flush?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'overview',
    component: () => import('@/pages/OverviewPage.vue'),
  },
  {
    /*
     * agent 放进路径里（/chat/:agentId），于是「每个 agent 一个会话页面」这件事
     * 就是地址栏里的事实 —— 能刷新、能收藏、能贴给别人。参数可选是为了让裸的 /chat
     * 也能进来：页面会在 agent 列表到位后自动跳到第一个。
     */
    path: '/chat/:agentId?',
    name: 'chat',
    meta: { flush: true },
    component: () => import('@/pages/ChatPage.vue'),
  },
  {
    path: '/traces',
    name: 'traces',
    meta: { wide: true },
    component: () => import('@/pages/TracesPage.vue'),
  },
  {
    path: '/traces/:runId',
    name: 'trace-detail',
    meta: { wide: true },
    component: () => import('@/pages/TraceDetailPage.vue'),
    props: true,
  },
  {
    path: '/sessions',
    name: 'sessions',
    meta: { wide: true },
    component: () => import('@/pages/SessionsPage.vue'),
  },
  {
    path: '/agents',
    name: 'agents',
    component: () => import('@/pages/AgentsPage.vue'),
  },
  {
    path: '/agents/:agentId',
    name: 'agent-detail',
    meta: { wide: true },
    component: () => import('@/pages/AgentDetailPage.vue'),
    props: true,
  },
  {
    path: '/harness',
    name: 'harness',
    meta: { wide: true },
    component: () => import('@/pages/HarnessPage.vue'),
  },
  {
    /*
     * Harness 的编排编辑面。
     *
     * <p>它和 /agents/:agentId 指向同一个组件，只是把入口分成两个列表页 ——
     * 编排三域（上下文压缩 / 工作区 / 子 agent）的表单有 400 多行，
     * 复制第二份必然出现"两边各改一半"，那是脏数据的经典来源。
     * 组件内部用 agentType 判断该渲染哪些 tab，所以 HARNESS 从这里进来
     * 看到的正好是编排域，从 /agents 进来看到的正好是能力域。
     */
    path: '/harness/:agentId',
    name: 'harness-detail',
    meta: { wide: true },
    component: () => import('@/pages/AgentDetailPage.vue'),
    props: true,
  },
  {
    /*
     * 工作区文件治理。
     *
     * <p>独立一页而不是塞进 Harness 详情：详情页的「工作区」tab 管的是 workspace 的<b>配置</b>
     * （后端类型、展示名），这一页管的是里面的<b>文件内容</b>。两者改的根本不是同一张表，
     * 混在一页里会让「为什么改完这里没生效」变成需要解释的问题。
     */
    path: '/workspace',
    name: 'workspace',
    /* 列表页只有一张 agent 表（名称 / 文件后端 / 生效的文件系统 / 工作区根路径），
       列数不多但路径那一列很长，窄栏下会被折成三行。 */
    meta: { wide: true },
    component: () => import('@/pages/WorkspacePage.vue'),
  },
  {
    /*
     * 工作区详情（/workspace/:agentName）。
     *
     * <p>列表页只回答「有哪些 agent 的工作区、各自的文件后端是什么」，
     * 这一页才回答「里面到底有什么文件、内容长什么样」。拆开之后两页的消费动作
     * 各自单一：列表页是「找一个 agent」，详情页是「维护它的文件」。
     *
     * <p>agentName 走路径而不是查询串：agent 是这一页的**主体**而不是筛选条件，
     * 写进路径才有「一个 agent 一个地址」—— 能刷新、能收藏、能贴给别人。
     */
    path: '/workspace/:agentName',
    name: 'workspace-detail',
    meta: { wide: true },
    component: () => import('@/pages/WorkspaceDetailPage.vue'),
    props: true,
  },
  {
    path: '/workflows',
    name: 'workflows',
    meta: { wide: true },
    component: () => import('@/pages/WorkflowsPage.vue'),
  },
  {
    /*
     * 工作流设计器（/workflows/:workflowKey）。
     *
     * <p>与工作区、状态存储同一套两级结构：清单页回答「有哪些、各自什么状态」，
     * 这一页回答「这张图哪里不通」。拆开是因为设计器左侧要放画布、右侧要放三张编辑卡，
     * 一屏里再塞一张清单就只能靠滚动切换，而"边连线边看清单"并不是真实动作。
     *
     * <p>workflowKey 走路径而不是查询串：它是这一页的**主体**，写进路径才有
     *「一个工作流一个地址」—— 能刷新、能收藏、能贴给别人。
     */
    path: '/workflows/:workflowKey',
    name: 'workflow-designer',
    meta: { wide: true },
    component: () => import('@/pages/WorkflowDesignerPage.vue'),
    props: true,
  },
  {
    path: '/tools',
    name: 'tools',
    meta: { wide: true },
    component: () => import('@/pages/ToolsPage.vue'),
  },
  {
    path: '/skills',
    name: 'skills',
    meta: { wide: true },
    component: () => import('@/pages/SkillsPage.vue'),
  },
  {
    path: '/prompts',
    name: 'prompts',
    meta: { wide: true },
    component: () => import('@/pages/PromptsPage.vue'),
  },
  {
    path: '/mcp',
    name: 'mcp',
    meta: { wide: true },
    component: () => import('@/pages/McpPage.vue'),
  },
  {
    path: '/middleware',
    name: 'middleware',
    meta: { wide: true },
    component: () => import('@/pages/MiddlewarePage.vue'),
  },
  {
    path: '/channels',
    name: 'channels',
    meta: { wide: true },
    component: () => import('@/pages/ChannelsPage.vue'),
  },
  {
    /*
     * 网关单独一页而不是并进 Channels：它管的东西与"有哪些渠道"是两件事 ——
     * 渠道是受治理资源（草稿/发布/回滚），网关是一次装配的输入（保存即生效）。
     * 混在一页里会让"为什么这个有发布按钮、那个没有"变成需要解释的问题。
     */
    path: '/gateway',
    name: 'gateway',
    meta: { wide: true },
    component: () => import('@/pages/GatewayPage.vue'),
  },
  {
    path: '/models',
    name: 'models',
    meta: { wide: true },
    component: () => import('@/pages/ModelsPage.vue'),
  },
  {
    path: '/environments',
    name: 'environments',
    meta: { wide: true },
    component: () => import('@/pages/EnvironmentsPage.vue'),
  },
  {
    /*
     * 状态存储 · 列表页：一张「状态表」清单（= 哪些 agent 的状态落进了库）。
     *
     * <p>这一页只回答「有哪些表、各占多少、最后一次写入是什么时候」，
     * 点某一行的「查看」进 /storage/:table。
     */
    path: '/storage',
    name: 'storage',
    meta: { wide: true },
    component: () => import('@/pages/StoragePage.vue'),
  },
  {
    /*
     * 状态存储 · 表详情（/storage/:table）：这一张表里有哪些会话。
     *
     * <p>表名走路径而不是查询串，理由同工作区：从「会话记录」页点「查看记忆」
     * 过来时，落点应该是一个**地址**（能刷新、能贴给别人），而不是一次性的查询状态。
     * 关键字仍留在查询串上 —— 它是一次检索，不是主体。
     */
    path: '/storage/:table',
    name: 'storage-table',
    meta: { wide: true },
    component: () => import('@/pages/StorageTablePage.vue'),
    props: true,
  },
  {
    /*
     * 状态存储 · 会话详情（/storage/:table/:slotId）：模型下一次对话真正会读到的上下文。
     *
     * <p>slotId 就是库里 session_id 列的原值，形如 <userId>:<sessionId> —— 它含冒号，
     * 但冒号在路径段里是合法字符（RFC 3986 的 pchar 包含 ":"），
     * 所以直接放进路径即可，不需要额外编码。vue-router 会把 %xx 自动解码回来。
     */
    path: '/storage/:table/:slotId',
    name: 'storage-session',
    meta: { wide: true },
    component: () => import('@/pages/StorageSessionPage.vue'),
    props: true,
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  /*
   * base 取自 vite 的 BASE_URL —— 它就是 vite.config.ts 里的 base，
   * 默认 '/'（本地 dev 与"部署在域名根"），部署到门户的 /agent/ 段时由
   * .env.deploy 的 VITE_PUBLIC_PATH 改写。
   *
   * 这里必须跟 base 一致，否则会出现最费解的那种白屏：HTML 与 JS 都加载到了，
   * 但路由表一条也匹配不上（地址是 /agent/traces，路由只认 /traces），
   * 于是被末尾的通配规则重定向回首页 —— 看起来像"一进就跳首页"。
   */
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
