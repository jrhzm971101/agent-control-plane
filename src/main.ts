import { createApp } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';

// 顺序要求：设计令牌 → Element Plus 主题覆盖 → 全局样式。
// 组件样式由 unplugin-vue-components 按需注入，这里不再引入整包 CSS。
import 'element-plus/es/components/message-box/style/css';
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/notification/style/css';
import './styles/tokens.css';
import './styles/element.css';
import './styles/index.css';

import App from './App.vue';
import { router } from './app/router';

const app = createApp(App)
  .use(router)
  .use(VueQueryPlugin, {
    queryClientConfig: {
      defaultOptions: {
        queries: {
          // 控制面数据以「人能接受的滞后」为准，不做秒级轮询；
          // 需要实时的场景（执行链路）走 SSE，见 features/traces/useRunEvents.ts。
          staleTime: 15_000,
          refetchOnWindowFocus: false,
          retry: 1,
        },
      },
    },
  });

// 等首次路由解析完成再挂载，避免懒加载路由首帧出现「标题对但内容空」。
//
// 注意顺序：router.isReady() 必须在 app.use(router) 之后调用。
// 首次导航是由 router 安装到 app 时触发的，安装之前 isReady() 会一直悬空，
// 页面就永远是白屏且控制台没有任何报错。
router.isReady().then(() => app.mount('#app'));
