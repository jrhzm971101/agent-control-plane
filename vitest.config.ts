import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/*
 * 单测配置单独一份：vitest 自带一份 vite 依赖，
 * 和 app 的 vite 版本放同一个文件里会产生类型冲突。
 *
 * 为什么不直接把 app 配置整个复制过来：alias（`@` → src）之类的东西必须与 app 完全一致，
 * 抄一份迟早漂移 —— 那种漂移的表现是"单测里 import 解析不到，改成相对路径就过了"，
 * 属于越绕越远的修法。
 *
 * ⚠️ viteConfig 是**函数**（见 vite.config.ts 顶部：它要读 env 才能定 base 与代理），
 * 而 vitest 的 mergeConfig 只接受普通对象、不接受回调（直接传会报
 * "Cannot merge config in form of callback"）。所以这里自己先把函数求值成对象，
 * 再把 mode 交下去 —— 求值出来的 base / proxy 对单测没有影响，但少了这一步整个配置加载不起来。
 */
export default defineConfig((env) =>
  mergeConfig(
    viteConfig(env),
    defineConfig({
      /*
       * 测试环境把平台前缀钉死成空串。
       *
       * 契约测试（api/controlplane/contract.test.ts、pages/routes.smoke.test.ts）断言的是
       * 「相对后端根」的路径，比如 '/api/resources/prompts'。而平台前缀属于**部署形态**，
       * 一旦有人在 .env.local 里设了 VITE_API_BASE=/agent-platform，这些断言会集体变红 ——
       * 红的原因（前缀被拼进来了）和断言想表达的东西（路由写对了没）毫无关系，
       * 排查一次要花的时间却不少。钉死之后，测试结果与本地 .env.local 怎么写彻底解耦。
       *
       * 前缀拼接本身在 lib/apiClient.test.ts 里用**显式传参**覆盖，不依赖环境变量。
       */
      define: {
        'import.meta.env.VITE_API_BASE': JSON.stringify(''),
      },
      test: {
        environment: 'jsdom',
        include: ['src/**/*.test.ts'],
      },
    }),
  ),
);