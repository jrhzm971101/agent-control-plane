/*
 * 工作流的「线上是不是这一版」口径。
 *
 * 后端的 status 只区分 DRAFT / PUBLISHED，而用户真正关心的是第三件事：
 * publishedVersion 为 null 说明<b>从来没发布过</b>，这与「改过还没发」是两回事 ——
 * 后者能直接运行（线上有版本），前者点了「运行」会被后端回 409。把这两者合并成
 * 一个「草稿」标签，用户就会对着一个永远跑不起来的工作流找原因。
 *
 * 放在 features 下而不是各页面各写一份：清单页（WorkflowsPage）与设计器页
 * （WorkflowDesignerPage）都要给同一个工作流上同一枚徽标，两份映射必然漂移 ——
 * 而漂移的表现是「列表说已发布、详情说待发布」，用户没法判断该信谁。
 *
 * 本文件装的是同一个口径的<b>两个结论</b>：徽标怎么显示（workflowStageOf），
 * 以及能不能运行、不能时给什么理由（workflowRunBlockedReason）。
 * 后者其实是前者的推论，放一起才不会出现"徽标说没发布过、按钮却亮着"。
 */
import type { WorkflowRow } from '@/api/controlplane/types';
import type { BadgeVariant } from '@/components/ui/types';

export type WorkflowStage = 'PUBLISHED' | 'CHANGED' | 'NEVER';

/**
 * 只取两个字段而不是整个 WorkflowRow：设计器页拿到的是详情实体（WorkflowEntity），
 * 清单页拿到的是列表行，两者只有字段名相同。参数收窄成结构类型之后，两张表的行
 * 都能直接喂进来，不需要在调用处先拼一个 WorkflowRow。
 */
export function workflowStageOf(
  row: Pick<WorkflowRow, 'status' | 'publishedVersion'>,
): WorkflowStage {
  if (row.status === 'PUBLISHED') return 'PUBLISHED';
  return row.publishedVersion === null ? 'NEVER' : 'CHANGED';
}

export const WORKFLOW_STAGE_TEXT: Record<WorkflowStage, string> = {
  PUBLISHED: '已发布',
  CHANGED: '有改动待发布',
  NEVER: '未发布过',
};

export const WORKFLOW_STAGE_TONE: Record<WorkflowStage, BadgeVariant> = {
  PUBLISHED: 'ok',
  CHANGED: 'rw',
  NEVER: 'off',
};

/**
 * 不能运行的原因；空串 = 可以运行。
 *
 * <p>两个条件都要在按钮上拦住，而不是点下去等后端回错：
 * <ul>
 *   <li><b>还没发布过</b> —— 运行的是已发布版本的冻结快照，后端直接回 409
 *       （WorkflowController 的 run 前置检查）。给一句原因，比"点了才知道"清楚；</li>
 *   <li><b>有未保存的改动</b> —— 只有设计器会传这一项（清单页没有本地草稿）。
 *       这时跑的还是线上旧内容，用户会以为"我明明改了却没生效"。</li>
 * </ul>
 *
 * <p>参数与 workflowStageOf 同样是结构类型：清单页喂列表行的 publishedVersion，
 * 设计器喂详情的 + dirty。两处共用一份文案，就不会出现
 * "清单页说能跑、点进设计器说不能"这种没法解释的不一致。
 */
export function workflowRunBlockedReason(row: {
  publishedVersion?: number | null;
  /** 本地草稿有没有改过；清单页不传（那里看的就是库里那份）。 */
  dirty?: boolean;
}): string {
  if (row.publishedVersion === null || row.publishedVersion === undefined) {
    return '还没有发布过：运行的是线上那一版，先点一次「发布」';
  }
  if (row.dirty) {
    return '有未保存的改动：先「保存草稿 → 发布」，运行的是线上那一版';
  }
  return '';
}