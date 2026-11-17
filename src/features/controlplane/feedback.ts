/*
 * 控制面写操作的成败反馈。
 *
 * 三类失败必须分开呈现，否则用户拿到的都是同一句「请求失败」：
 *
 * - 400 校验未通过：后端的校验是「收集式」的，一次带回全部问题。逐条列出来，
 *   用户改一遍就能提交成功；只显示第一条会让人来回提交三四次。
 * - 409 引用保护：后端带回「谁在引用它」。列出来，用户才知道先去解绑谁 ——
 *   只说「删不掉」等于没说。
 * - 其他：只有一句 message，照原样显示。
 *
 * 用 ElNotification 而不是 ElMessage：校验一次可能十条，一行 toast 放不下，
 * 而且这两类失败都需要用户停下来处理，不该三秒后自己消失（duration: 0）。
 */
import { h } from 'vue';
import { ElNotification } from 'element-plus';
import { referencingAgentsOf, violationsOf } from '@/api/controlplane';

const LIST_STYLE = 'margin: 0; padding-left: 18px; line-height: 1.8;';

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function notifyFailure(error: unknown, title = '操作失败'): void {
  const violations = violationsOf(error);
  if (violations.length > 0) {
    ElNotification({
      title: `${title}：校验未通过（${violations.length} 条）`,
      type: 'warning',
      duration: 0,
      message: h(
        'ul',
        { style: LIST_STYLE },
        violations.map((item) => h('li', item)),
      ),
    });
    return;
  }

  const references = referencingAgentsOf(error);
  if (references.length > 0) {
    ElNotification({
      title: `${title}：仍有引用`,
      type: 'warning',
      duration: 0,
      message: h('div', { style: 'line-height: 1.8' }, [
        h('div', '先在这些 agent 上解绑，再回来删除：'),
        h('div', { style: 'font-family: var(--mono); font-size: 12.5px; margin-top: 4px' }, references.join('、')),
      ]),
    });
    return;
  }

  ElNotification({ title, type: 'error', message: messageOf(error) });
}

export function notifySuccess(title: string, message?: string): void {
  ElNotification({ title, type: 'success', message: message ?? '' });
}

/**
 * 发布结果里带的热装配告警。
 *
 * 发布本身成功（版本已写、快照已存），但某个引用它的 agent 重建失败时，
 * 后端把原因塞在 note 里而不是抛错 —— 因为"版本已发布"这件事不该被回滚。
 * 页面必须把 note 显出来，否则会出现"页面上发布成功了、线上还是旧行为"的哑谜。
 */
export function notifyPublish(result: { reloadedAgents: string[]; note: string | null }): void {
  if (result.note) {
    ElNotification({
      title: '已发布，但热装配有告警',
      type: 'warning',
      duration: 0,
      message: result.note,
    });
    return;
  }
  const agents = result.reloadedAgents ?? [];
  notifySuccess(
    '已发布',
    agents.length > 0 ? `已重建实例：${agents.join('、')}` : '本次没有需要重建的实例',
  );
}