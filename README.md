# agent-control-plane 控制台

Agent 控制面前端控制台。视觉按火山方舟（Ark）控制台皮肤实现，与 `md-data-hub` 同源：同一套设计令牌命名、同一套外壳结构。

## 技术栈

- Vue 3.5 + TypeScript 5.7 + Vite 6
- Element Plus 2.9（全量引入 + 主题令牌覆盖）
- vue-router 4、TanStack Query 5
- Vitest 2 + jsdom

## 快速开始

```bash
npm install
npm run dev        # 开发服务器 http://localhost:5273，/api 反向代理到 9090
npm test           # 单元测试
npm run typecheck  # vue-tsc 类型检查
npm run build      # 类型检查 + 生产构建（页面挂根路径、接口不带平台前缀）
npm run build:deploy  # 部署到一体化平台：页面挂 /agent/、接口带 /agent-platform 前缀
```

## 环境文件

| 文件 | 用途 | 是否提交 |
| --- | --- | --- |
| `.env.deploy` | 一体化平台部署参数：页面前缀、接口前缀、门户地址 | 是 |
| `.env.local` | 本地开发覆盖项，例如 `VITE_API_BASE`、`VITE_TRACES_MOCK` | 否 |

## 页面

| 分组 | 路由 | 页面 |
| --- | --- | --- |
| — | `/` | 概览 |
| 运行 | `/traces` | 执行链路列表（关键字 / Agent / 时间范围筛选 + 平铺列表） |
| 运行 | `/traces/:runId` | 链路详情（完整调用树；点节点弹出入参 / 出参 / 指标） |
| 运行 | `/sessions` | 会话记录 |
| 编排 | `/agents` | Agents 列表 |
| 编排 | `/agents/:agentId` | Agent 详情 |
| 编排 | `/harness` | Harness 编排 |
| 编排 | `/workflows` | 工作流 |
| 能力资源 | `/tools` | 工具 |
| 能力资源 | `/skills` | Skills |
| 能力资源 | `/prompts` | Prompt |
| 能力资源 | `/mcp` | MCP 服务 |
| 能力资源 | `/middleware` | Middleware |
| 接入 | `/channels` | Channels（企微 / 飞书 bot、群机器人 Webhook） |
| 接入 | `/endpoints` | Endpoints |
| 设置 | `/models` | 模型 |
| 设置 | `/environments` | 环境 |
| 设置 | `/storage` | 状态存储 |

## 目录结构

```
src/
  api/            # 接口层：页面只依赖这里的函数签名，HTTP 实现集中在 controlplane/
  app/            # 应用外壳：路由、侧栏模型、命令面板、路由兜底
  components/     # 业务组件（TraceTree）
    ui/           # 通用展示组件（卡片、表头、筛选栏、徽标、KV 列表…）
  features/       # 有独立状态与适配逻辑的领域
    traces/       # 执行链路：事件适配、SSE 增量、契约测试；演示数据在 mockDataset.ts / mockEvents.ts
    conversation/ # 会话事件游标
  lib/            # 纯函数：格式化、查询键、命名空间作用域
  pages/          # 页面，与路由一一对应
  styles/         # tokens.css（设计令牌）→ element.css（组件覆盖）→ index.css（全局）
```

样式加载顺序在 `src/main.ts` 固定为 `element-plus/dist/index.css` → `tokens.css` → `element.css` → `index.css`。Element Plus 的 CSS 变量在 `element.css` 里被映射到令牌，改主题只改 `tokens.css`。

## 设计令牌

`src/styles/tokens.css` 是颜色 / 间距 / 圆角 / 层级的唯一来源，与 Ark 控制台实测值对齐：

- 主色 `#5252FF`（蓝紫调），外壳 `#F6F6FC` + 内容区纯白，分区靠底色差而非投影
- 层级只用 1px 描边，阴影仅给浮层（`--sh-pop` / `--sh-float`）
- 文字三级 `#0B0B0F` / `#3F3F51` / `#787891`
- 品牌区在外壳左上角（与顶栏同一行），侧栏与顶栏同色，内容区反白

## 数据来源

只有一个演示数据开关，在 `.env.*` 里：

```
VITE_TRACES_MOCK=false   # 默认连接真实后端；true 时执行链路使用内置演示数据
```

所有页面默认连接真实后端。只有执行链路保留一组测试/演示 fixture，避免原型数据继续扩散到控制面。

后端地址在 `vite.config.ts` 的 `server.proxy` 里改，默认 `http://localhost:9091`（一体化平台的 agent 服务端口）；单独跑 `md-agent-bootstrap` 时用 `VITE_DEV_BACKEND=http://localhost:9090` 覆盖。

### 接口前缀（部署形态）

一体化平台把一个后端服务挂在「与它同名的一级路径」下（agent 服务是 `/agent-platform`），网关原样转发、不做 StripPrefix —— 前缀是接口契约的一部分。所以除了本地独立跑，请求都要带上它：

```
VITE_API_BASE=/agent-platform  # 后端带平台前缀时（默认形态）每条请求都带这一段
VITE_API_BASE=                 # 只有把后端 SERVER_CONTEXT_PATH 设成空值跑时才留空
```

后端那一侧是 `bootstrap.yml` 里的 `spring.webflux.base-path: ${SERVER_CONTEXT_PATH:/agent-platform}`。注意它必须是 **`spring.webflux.base-path`**：本服务是 WebFlux，属性 `server.servlet.context-path` 是 Servlet 专用的，配在 WebFlux 服务上既不生效也不报错 —— 那种"改了没反应"最难查。WebFlux 的 base-path 由 Spring Boot 用 `ContextPathCompositeHandler` 实现（先剥前缀再派发），语义与 servlet context-path 等价。

前缀由 `src/lib/apiClient.ts` 的 `withApiBase` 在**唯一出口**（`apiResponse` 里的那次 fetch）统一补，调用方一律只写相对后端根的路径（`/api/...`）。新增接口不需要额外做什么 —— 包括直接消费 Response 的 SSE 订阅，它们也走同一个出口。

部署用 `.env.deploy`（`npm run build:deploy`），它除了接口前缀，还把页面段设成门户预留的 `/agent/`（`VITE_PUBLIC_PATH`，同时作用于静态资源引用与路由 base）。

### 登录票

网关（`GatewaySecurityConfig`）除白名单外都要求有效 Bearer 票，并按路径前缀校验 JWT 的 `platforms` claim 是否含 `agent`（`SUPER_ADMIN` 全平台放行）。票由统一门户登录时写进 localStorage，本平台只读 —— 两边同 origin，跳转时不用在 URL 上带票。

```
VITE_IAM_BASE=            # 留空 = 同源。只有前后端分开跑时才填（如 http://localhost:8080）
VITE_AUTH_DISABLED=false  # 生产必须 false；本地把后端门禁一起关掉时才设 true
```

实现都在 `src/lib/auth.ts`：票挂传输层的唯一出口（`src/lib/apiClient.ts` 的 `apiResponse`），401 时换一张新票重放**一次**。换票是单飞的 —— 一屏同时发几个查询时，每个 401 各换一次票会出事：刷新票一次一换，第 2 个开始拿的就是已作废的旧票，会命中 iam 的重放检测，把整条票链作废、把人踢下线。

存储键 `md.token` / `md.refresh` 与门户的 `src/lib/session.ts` 是**跨前端契约**，改一边必须改另一边。对不上的症状是「从门户跳进来满屏 401」，而本地（没有门户、门禁也关着）永远复现不了。

## 校验

`npm test` 覆盖的是协议与推导关系而非渲染快照：后端事件到视图模型的适配、SSE 事件的落库顺序与游标、以及与后端契约的字段对齐。改动 `features/traces` 或 mock 后先跑这一组。
