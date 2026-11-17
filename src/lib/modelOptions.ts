/*
 * 模型下拉的候选构造 —— agent 的 model-ref 字段（主模型 / 兜底 / 压缩 / 记忆 / 子 agent）
 * 与模型页共用同一套口径。
 *
 * <h2>为什么必须有个统一入口</h2>
 * model-ref 是<b>引用字段</b>：它存的是 md_model.model_key。按本项目的约定，引用字段在页面上
 * 只能是下拉，不能是自由输入 —— 手输一个不存在的名字，失败会发生在"装配期"，
 * 离用户敲字的那个瞬间很远（同 types.ts 文件头第 4 条）。
 *
 * <h2>为什么下拉里会出现"清单外的值"</h2>
 * 两个来源，都不是错误数据：
 *   1. 存量数据里存的是 <b>Bean 名</b>（application.yml 里那个 openAIChatModel）——
 *      模型迁进库之前建的 agent 全是这个形状，而装配层至今仍然接受 Bean 名兜底；
 *   2. 模型被删掉了，而引用它的 agent 还没改。
 * 这两种都不能静默丢掉：丢掉的表现是"打开详情页、什么都没碰、点保存"就把这一列清空了，
 * 而用户以为自己只是看了一眼。所以清单外的当前值要补进候选里，并如实标注它不在清单里。
 */
import type { ModelRow } from '@/api/controlplane/types';

export interface ModelOption {
  /** 提交值：model_key（或存量的 Bean 名）。 */
  value: string;
  /** 展示名；默认模型带一个后缀，免得在两个名字很像的模型之间选错兜底。 */
  label: string;
  /** 停用的模型不可选（选了会在装配期报错），但清单里仍然看得见 —— 让人知道它存在。 */
  disabled: boolean;
  /** 次要说明：厂商侧模型名，选的时候唯一有区分度的东西。 */
  note?: string;
}

/** 库里的模型清单 → 下拉候选。按展示名排序：它是给人找的清单，不是"最近改过什么"。 */
export function modelSelectOptions(rows: ModelRow[] | null | undefined): ModelOption[] {
  return (rows ?? [])
    .map((row) => ({
      value: row.modelKey,
      label: row.isDefault ? `${row.displayName}（默认）` : row.displayName,
      disabled: !row.enabled,
      note: row.modelName ?? undefined,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * 把"当前这个值"补进候选（如果它不在清单里）。理由见文件头第二节。
 */
export function withCurrentModel(
  options: ModelOption[],
  current: string | null | undefined,
): ModelOption[] {
  const value = (current ?? '').trim();
  if (value === '' || options.some((option) => option.value === value)) {
    return options;
  }
  return [
    ...options,
    { value, label: `${value}（不在模型清单里）`, disabled: false, note: '存量值：Bean 名或已被删除的模型' },
  ];
}
