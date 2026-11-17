import { onScopeDispose, ref, watch, type Ref } from 'vue';

/**
 * 跟随源 ref 的防抖副本。
 *
 * 只服务于本项目的搜索输入：初值立即生效，后续变更在 delay 内合并，
 * 组件卸载时清掉定时器，避免测试或路由切换后仍有回调改写状态。
 */
export function useDebounce<T>(source: Ref<T>, delay = 200): Ref<T> {
  const debounced = ref(source.value) as Ref<T>;
  let timer: ReturnType<typeof setTimeout> | undefined;

  watch(
    source,
    (value) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        debounced.value = value;
      }, delay);
    },
    { flush: 'post' },
  );

  onScopeDispose(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  return debounced;
}
