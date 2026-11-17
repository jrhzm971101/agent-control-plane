<script setup lang="ts">
/*
 * 路由错误边界。
 *
 * 页面组件在渲染期抛异常时，Vue 会一路冒泡到应用根，结果是整个 router-view
 * 连同已经渲染好的子树一起塌掉。表现就是「点某个菜单白屏，之后点任何菜单都
 * 白屏，只能整页刷新」—— 因为此时组件树已经不完整，后续补丁会继续抛
 * parentNode of null，错误会从这一页传染到所有页。
 *
 * 这里在 router-view 外面兜一层：接住异常，把出错的那棵子树整个换掉（换掉的
 * 同时它也真的被卸载了，组件树回到干净状态），只把当前页面替换成一段可读的
 * 提示。侧栏和顶栏不属于这棵子树，所以还能正常点。
 */
import { onErrorCaptured, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

const failure = ref<{ error: Error; path: string } | null>(null);

onErrorCaptured((err) => {
  failure.value = {
    error: err instanceof Error ? err : new Error(String(err)),
    path: route.fullPath,
  };
  // 返回 false 阻止继续往上冒泡，否则 AppShell 本身也会被判为渲染失败。
  return false;
});

/*
 * 换路由就自动恢复。这里必须比对「出错时所在的路径」而不是无条件清空：
 * 渲染异常发生在路由已经切过去之后，同一次跳转里清空会被立刻重新置上，
 * 错误页要么闪一下就没、要么永远退不掉。
 */
watch(
  () => route.fullPath,
  (path) => {
    if (failure.value && failure.value.path !== path) failure.value = null;
  },
);

/*
 * 重试 = 清掉失败标记。出错时 slot 没有被渲染，子树的 vnode 已经被销毁，
 * 所以清空之后路由组件是真正重新挂载一次，而不是复用半坏的旧实例。
 */
function retry() {
  failure.value = null;
}
</script>

<template>
  <div v-if="failure" class="crash">
    <h2>这个页面渲染失败了</h2>
    <p class="crash__sub">
      出错位置 <b class="mono">{{ failure.path }}</b>
    </p>
    <pre class="crash__msg mono">{{ failure.error.message }}</pre>
    <div class="crash__acts">
      <el-button @click="retry">重试</el-button>
      <el-button type="primary" @click="router.push('/')">回到概览</el-button>
    </div>
  </div>
  <slot v-else />
</template>

<style scoped>
.crash {
  padding: 18px 20px;
  border: 1px solid var(--bd);
  border-left: 2px solid var(--red);
  border-radius: var(--r-md);
  background: var(--panel);
}
.crash h2 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--t1);
}
.crash__sub {
  margin: 0 0 12px;
  color: var(--t2);
  font-size: 13.5px;
  line-height: 1.7;
}
.crash__sub b {
  color: var(--t1);
  font-weight: 600;
}
.crash__msg {
  margin: 0 0 14px;
  padding: 10px 12px;
  max-height: 220px;
  overflow: auto;
  background: var(--panel-sunken);
  border: 1px solid var(--bd-soft);
  border-radius: var(--r-md);
  color: var(--red);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.crash__acts {
  display: flex;
  gap: var(--s2);
}
</style>
