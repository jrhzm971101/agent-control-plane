import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

/*
 * Element Plus 的组件样式由 unplugin-vue-components 在编译期按需注入，
 * 而路由页面是懒加载的 —— Vite 启动时扫描不到这些 import，只有第一次打开
 * 对应菜单页才发现新依赖，于是重新预构建并广播 full reload：
 *
 *   [vite] new dependencies optimized: ... tooltip/style/css, alert/style/css ...
 *   [vite] optimized dependencies changed. reloading
 *
 * 浏览器整页刷新后，AppShell 里只存在于内存的标签栏自然就清空了 ——
 * 用户看到的现象是「点一个没进过的菜单，已打开页面全没了」。
 *
 * 这里从 node_modules 里现读所有组件的 style/css 提前列进预构建清单，
 * 而不是手抄一份当前用到的组件：以后页面新增组件时不需要再回来补，
 * 也就不会重新出现这个 reload。该配置只影响 dev 预构建，不改变生产产物。
 */
function elementPlusStyleDeps(): string[] {
  const componentsDir = fileURLToPath(
    new URL('./node_modules/element-plus/es/components', import.meta.url),
  );
  if (!existsSync(componentsDir)) return [];

  return readdirSync(componentsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(componentsDir, entry.name, 'style', 'css.mjs')),
    )
    .map((entry) => `element-plus/es/components/${entry.name}/style/css`);
}

/*
 * 对话页同样只在第一次打开时才加载 markdown-it 与 highlight.js 的语言包。
 * 一并写进预构建清单，避免「第一次进对话页」也触发一次整页刷新。
 */
const HIGHLIGHT_LANGUAGES = [
  'bash',
  'diff',
  'dockerfile',
  'ini',
  'java',
  'javascript',
  'json',
  'markdown',
  'plaintext',
  'properties',
  'python',
  'sql',
  'typescript',
  'xml',
  'yaml',
];

/*
 * 为什么是函数式配置：base 与代理都要读 .env.* 里的 VITE_* 才能定，
 * 而静态对象拿不到 mode / 环境变量。loadEnv 的第三个参数必须显式传 'VITE_' ——
 * 不传的话它只返回已存在的 process.env，.env 文件里写的值根本读不到
 * （表现为"配置明明改了却不生效"）。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const elementStyle = mode === 'test' ? false : 'css';

  /*
   * 本地后端地址。默认 9091 —— 一体化平台（md-admin-platform）里 agent 服务的端口
   * （它的 bootstrap.yml 里 server.port 不配时就是 9091），而且它带 /agent-platform
   * 前缀（spring.webflux.base-path），正好与下面那条 /agent-platform 代理拼得上。
   *
   * 这里曾经写死 9090，那是"单独跑 md-agent-bootstrap"年代的默认值。一体化平台起来之后
   * 它就不成立了：9090 上没有进程，每条接口都是 ECONNREFUSED，而报错只出现在 vite 的
   * 终端里，页面上只是一张加载失败的空卡片，很容易被误判成"后端没实现"。
   *
   * 单独跑 md-agent-bootstrap（端口 9090、接口根还是 /api）时，在 .env.local 里写
   * VITE_DEV_BACKEND=http://localhost:9090 覆盖即可。
   */
  const BACKEND = env.VITE_DEV_BACKEND || 'http://localhost:9091';

  return {
    /*
     * 页面挂载的子路径。默认 '/'，也就是"部署在域名根"或"本地 dev"——
     * 两种最常用的形态行为完全不变。
     *
     * 门户给智能体平台预留的页面段是 /agent/（见一体化平台的 platform.home_path），
     * 部署到那一段时用 .env.deploy 里的 VITE_PUBLIC_PATH=/agent/ 打开。
     * 这个值会同时改写 index.html 里 /favicon.svg 这类绝对引用与路由 base，
     * 所以页面里不要写死任何以 / 开头的资源路径。
     */
    base: env.VITE_PUBLIC_PATH || '/',

    plugins: [
      vue(),
      Components({
        resolvers: [ElementPlusResolver({ importStyle: elementStyle })],
        // 组件类型交给 Element Plus 自己的全局声明；生成 dts 会让表格插槽的
        // row 被收窄成 DefaultRow，反而与项目里按业务类型使用插槽的写法冲突。
        dts: false,
      }),
    ],

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    /*
     * dev 预构建清单。所有「只出现在懒加载页面里」的依赖都必须列在这里，
     * 否则它们会在第一次进入对应页面时才被发现，触发整页 reload（原因见文件上方）。
     * 测试模式不需要预构建，跳过以免无谓地读 node_modules。
     */
    ...(mode === 'test'
      ? {}
      : {
          optimizeDeps: {
            include: [
              'vue',
              'vue-router',
              '@tanstack/vue-query',
              '@element-plus/icons-vue',
              'element-plus',
              'element-plus/es',
              'element-plus/es/locale/lang/zh-cn',
              'markdown-it',
              'highlight.js/lib/core',
              ...HIGHLIGHT_LANGUAGES.map((name) => `highlight.js/lib/languages/${name}`),
              ...elementPlusStyleDeps(),
            ],
          },
        }),

    server: {
      port: 5273,
      proxy: {
        /*
         * 两条代理对应后端的两种形态，都用哪条取决于 .env.local 的 VITE_API_BASE：
         *
         *   形态一（一体化平台 / 部署）—— VITE_API_BASE=/agent-platform
         *     后端自己带 context-path（agent 服务是 /agent-platform），网关原样转发、
         *     不做 StripPrefix，所以前缀是接口契约的一部分，这里也必须原样转发。
         *
         *   形态二（本地独立跑后端）—— VITE_API_BASE 留空
         *     接口根就是 /api，走下面的代理。
         *
         * 两条都注册而不是按需生成：写死更直白，也不会因为某个环境少写一行
         * 变成"代理没命中"，而代理没命中的报错长得很像后端没实现（500 / 404）。
         */
        '/agent-platform': {
          target: BACKEND,
          changeOrigin: true,
        },
        '/api': {
          target: BACKEND,
          changeOrigin: true,
        },
      },
    },

    build: {
      /*
       * Element Plus 已按需引入，组件与样式只跟随实际使用的页面进入构建。
       * 保留 800KB 阈值用于识别真正失控的业务 chunk，而不是为组件库长期兜底。
       */
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          /*
           * 按「变更频率」拆：框架 → 数据层，业务代码单独一份。
           * Element Plus 不再手工并成一个大 chunk，交给按需引入后的 Rollup 自动切分。
           */
          manualChunks: {
            vue: ['vue', 'vue-router'],
            query: ['@tanstack/vue-query'],
          },
        },
      },
    },
  };
});
