/*
 * 侧边导航模型。
 *
 * <h2>分组轴：按「一次 agent 的生命周期位置」切，不按实现模块切</h2>
 * 一次 agent 的完整旅程是「先声明它是什么 → 它要引用的东西 → 外部怎么找到它 →
 * 它跑成什么样 → 它落下了什么」，分组就沿这条线切：
 *
 * <ol>
 *   <li><b>运行状态</b> —— 它跑成什么样（对话 / 执行链路 / 会话记录）；</li>
 *   <li><b>编排定义</b> —— 声明一个 agent 是什么：用哪个模型、挂哪些工具与技能、
 *       多个 agent 怎么串（模型 / Agents / Harness 工作台 / 工作流）；</li>
 *   <li><b>能力资源</b> —— 上面那些定义会引用、但不属于任何单个 agent 的东西；</li>
 *   <li><b>接入</b> —— 外部渠道怎么找到这些 agent（Channels / Gateway）；</li>
 *   <li><b>运行产物</b> —— 它落下、之后只读的东西（工作区 / 状态存储）；</li>
 *   <li><b>业务</b> —— 环境。它装的是公司内部的地址与凭据，属于接入方提供的业务数据，
 *       平台自身的功能不依赖它（没有环境也能定义并跑 agent），所以单独一组放最后。</li>
 * </ol>
 *
 * <h2>数组里的顺序按使用频率，不按上面那套生命周期顺序</h2>
 * 「运行状态」排在最前，且组内第一条是「对话」：这一页是日常打开次数最多的入口，
 * 找它的人不该先越过五个分组标题。上面 <ol> 的编号只解释"为什么这样分组"，
 * 不表示数组里的先后 —— 两套顺序不一致是刻意的，别照着编号去调数组。
 *
 * <p>分组与条目都在这里声明，AppShell 只负责渲染。
 * <b>title 必须唯一</b>：AppShell 拿它当 v-for 的 key。
 */
export interface NavItem {
  key: string;
  label: string;
  path: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const navGroups: NavGroup[] = [
  {
    title: '',
    items: [{ key: 'overview', label: '概览', path: '/' }],
  },
  {
    title: '运行状态',
    /*
     * 三个页面回答同一个问题：这次调用实际发生了什么。
     * 对话是最粗的一层（只有输入与输出），执行链路是过程，会话记录按会话把它们聚合起来 ——
     * 所以三者一组，按「从粗到细、再回到聚合」排列。
     */
    items: [
      { key: 'chat', label: '对话', path: '/chat' },
      { key: 'traces', label: '执行链路', path: '/traces' },
      { key: 'sessions', label: '会话记录', path: '/sessions' },
    ],
  },
  {
    title: '编排定义',
    // 模型排在最前：选谁当"脑子"是定义一个 agent 的第一步，其余三项都排在它的下游。
    // 「Agents」放能力型（REACT）：给提示词、挂工具与技能。
    // 「Harness 工作台」放编排型：它是别的 agent 的容器，关心的是工作区与子 agent。
    // 两个名字都不带 REACT/HARNESS 字样 —— 那是框架实现的名字，不是读者要理解的概念。
    items: [
      { key: 'models', label: '模型', path: '/models' },
      { key: 'agents', label: 'Agents', path: '/agents' },
      { key: 'harness', label: 'Harness 工作台', path: '/harness' },
      { key: 'workflows', label: '工作流', path: '/workflows' },
    ],
  },
  {
    title: '能力资源',
    /*
     * 这些是上面「编排定义」里的 agent 会引用的东西，但本身不属于任何一个 agent。
     * 不并进「编排定义」那一组：进了那一组，删掉一个 skill 时会以为"只影响当前这个 agent"。
     */
    items: [
      { key: 'tools', label: '工具', path: '/tools' },
      { key: 'skills', label: 'Skills', path: '/skills' },
      { key: 'prompts', label: 'Prompt', path: '/prompts' },
      { key: 'mcp', label: 'MCP 服务', path: '/mcp' },
      { key: 'middleware', label: 'Middleware', path: '/middleware' },
    ],
  },
  {
    title: '接入',
    items: [
      { key: 'channels', label: 'Channels', path: '/channels' },
      // Gateway 放在 Channels 下面：「渠道进来的消息最终交给谁」由它决定，
      // 读者先看到入口、再看到落点，顺序与排查问题的顺序一致。
      { key: 'gateway', label: 'Gateway', path: '/gateway' },
    ],
  },
  {
    title: '运行产物',
    /*
     * 工作区与状态存储不是"怎么定义 agent"，而是 agent 跑过之后留在盘上/库里的东西。
     *
     * 工作区原先挂在「编排」组里，理由是"它决定 agent 能读到哪些文件"。现在改成按
     * <b>产物归谁</b>来判：进这两页的人通常是去"看看它留下了什么"，
     * 而不是去"改一个 agent 的定义" —— 后者在「编排定义」组里做完了。
     */
    items: [
      { key: 'workspace', label: '工作区', path: '/workspace' },
      { key: 'storage', label: '状态存储', path: '/storage' },
    ],
  },
  {
    title: '业务',
    items: [{ key: 'environments', label: '环境', path: '/environments' }],
  },
];

export const allNavItems: NavItem[] = navGroups.flatMap((group) => group.items);

/** 路由名 → 顶栏标题；导航之外的路由（如 Agent 详情）单独兜底。 */
export function titleForPath(path: string): string {
  if (path.startsWith('/agents/')) return 'Agent 详情';
  // Harness 详情复用 Agent 详情组件，但标题要说它自己的名字，
  // 否则用户从 Harness 列表点进来会看到顶栏写着「Agent 详情」，像是走错了页面。
  if (path.startsWith('/harness/')) return 'Harness 工作台';
  // 对话页带 agent 参数（/chat/<agentId>），顶栏标题仍是「对话」而不是那个 id
  if (path.startsWith('/chat/')) return '对话';
  if (path.startsWith('/traces/')) return '链路详情';
  // 工作区与状态存储都拆成了「列表 + 详情」两级。详情页的顶栏标题仍用列表页的名字：
  // 那个名字是这一块的领域名，读者找的就是它；换成一个 agent 名或表名，
  // 顶栏会变成一行随时会变的机器标识，反而丢失了位置感。
  if (path.startsWith('/workspace/')) return '工作区';
  // 工作流也拆成了「列表 + 设计器」两级，设计器顶栏沿用列表页的领域名（理由同上）
  if (path.startsWith('/workflows/')) return '工作流';
  if (path.startsWith('/storage/')) return '状态存储';
  const hit = allNavItems.find((item) => item.path === path);
  return hit?.label ?? '控制台';
}
