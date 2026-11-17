import { computed, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import { createEnvGroup, deleteEnvGroup, saveEnvGroup } from '@/api/controlplane';
import type {
  EnvGroupKeyTemplate,
  EnvGroupSaveRequest,
  EnvGroupTemplate,
} from '@/api/controlplane/types';
import { notifyFailure, notifySuccess } from '@/features/controlplane/feedback';
import type { EnvironmentCatalog } from './useEnvironmentCatalog';

interface DraftKey {
  uid: number;
  keyCode: string;
  label: string;
  valueType: string;
  required: boolean;
  secret: boolean;
  placeholder: string;
  exampleValue: string;
  description: string;
  sortOrder: number;
  reserved: boolean;
}

interface GroupDraft {
  groupCode: string;
  displayName: string;
  icon: string;
  description: string;
  sortOrder: number;
  builtin: boolean;
  keys: DraftKey[];
}

let uidSeq = 0;
const nextUid = (): number => (uidSeq += 1);

function emptyKeyRow(): DraftKey {
  return {
    uid: nextUid(),
    keyCode: '',
    label: '',
    valueType: 'STRING',
    required: false,
    secret: false,
    placeholder: '',
    exampleValue: '',
    description: '',
    sortOrder: 0,
    reserved: false,
  };
}

function emptyGroupDraft(): GroupDraft {
  return {
    groupCode: '',
    displayName: '',
    icon: '',
    description: '',
    sortOrder: 0,
    builtin: false,
    keys: [emptyKeyRow()],
  };
}

function draftKey(key: EnvGroupKeyTemplate): DraftKey {
  return {
    uid: nextUid(),
    keyCode: key.keyCode,
    label: key.label,
    valueType: key.valueType || 'STRING',
    required: key.required,
    secret: key.secret,
    placeholder: key.placeholder ?? '',
    exampleValue: key.exampleValue ?? '',
    description: key.description ?? '',
    sortOrder: key.sortOrder,
    reserved: key.reserved,
  };
}

interface GroupManagerOptions {
  onGroupDeleted: (groupCode: string) => void;
}

/**
 * 变量分组模板与组内键定义。实例值不在这里维护，避免模板和实例数据混在一起。
 */
export function useGroupManager(
  catalog: EnvironmentCatalog,
  options: GroupManagerOptions,
) {
  const { groupByCode, refreshGroups } = catalog;

  const groupDialogOpen = ref(false);
  const editingGroupCode = ref<string | null>(null);
  const groupForm = ref<GroupDraft>(emptyGroupDraft());
  /** 打开编辑时的键名快照：保存前用它算出"这次会删掉哪些键"。 */
  const originalKeyCodes = ref<string[]>([]);

  function openCreateGroup(): void {
    editingGroupCode.value = null;
    originalKeyCodes.value = [];
    groupForm.value = emptyGroupDraft();
    groupDialogOpen.value = true;
  }

  function openEditGroup(group: EnvGroupTemplate): void {
    editingGroupCode.value = group.groupCode;
    originalKeyCodes.value = group.keys.map((key) => key.keyCode);
    groupForm.value = {
      groupCode: group.groupCode,
      displayName: group.displayName,
      icon: group.icon ?? '',
      description: group.description ?? '',
      sortOrder: group.sortOrder,
      builtin: group.builtin,
      keys: group.keys.map(draftKey),
    };
    groupDialogOpen.value = true;
  }

  function addGroupKey(): void {
    groupForm.value.keys.push(emptyKeyRow());
  }

  function removeGroupKey(uid: number): void {
    const key = groupForm.value.keys.find((item) => item.uid === uid);
    if (!key || key.reserved) return;
    groupForm.value.keys = groupForm.value.keys.filter((item) => item.uid !== uid);
  }

  const KEY_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

  const groupCodeIssue = computed(() => {
    if (editingGroupCode.value) return '';
    const code = groupForm.value.groupCode.trim();
    if (!code) return '分组标识不能为空';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      return '分组标识只能用字母、数字、下划线、连字符，1-64 位';
    }
    return '';
  });

  const groupKeyIssues = computed<Map<number, string>>(() => {
    const issues = new Map<number, string>();
    const seen = new Map<string, number>();
    groupForm.value.keys.forEach((key, index) => {
      const code = key.keyCode.trim();
      if (!code) {
        issues.set(index, '键名不能为空');
        return;
      }
      if (!KEY_CODE_PATTERN.test(code)) {
        issues.set(index, '键名必须是合法标识符：字母开头，只能含字母、数字、下划线');
        return;
      }
      if (seen.has(code)) {
        issues.set(index, `键名重复：前面已经有一个 ${code}`);
        return;
      }
      seen.set(code, index);
      if (!key.label.trim()) issues.set(index, '展示名不能为空');
    });
    return issues;
  });

  const groupProblems = computed(() => {
    const problems: string[] = [];
    if (groupCodeIssue.value) problems.push(groupCodeIssue.value);
    if (!groupForm.value.displayName.trim()) problems.push('分组展示名不能为空');
    for (const [index, issue] of groupKeyIssues.value) {
      problems.push(`第 ${index + 1} 个键：${issue}`);
    }
    return problems;
  });

  const canSaveGroup = computed(
    () => groupProblems.value.length === 0 && !saveGroupMutation.isPending.value,
  );

  const saveGroupMutation = useMutation({
    mutationFn: async (
      payload: { code: string | null; body: EnvGroupSaveRequest },
    ): Promise<{ groupCode: string; removedKeys?: string[] }> => {
      if (payload.code) {
        const result = await saveEnvGroup(payload.code, payload.body);
        return { groupCode: result.groupCode, removedKeys: result.removedKeys };
      }
      const result = await createEnvGroup(payload.body);
      return { groupCode: result.groupCode };
    },
    onSuccess: async (result, payload) => {
      await refreshGroups();
      groupDialogOpen.value = false;
      const removed = result.removedKeys ?? [];
      if (removed.length > 0) {
        notifySuccess(
          '分组已保存',
          `已移除 ${removed.join('、')}，这些键在所有环境下已配置的值也一并清空了。`,
        );
        return;
      }
      notifySuccess(payload.code ? '分组已保存' : '分组已创建');
    },
    onError: (failure) => notifyFailure(failure, '保存分组失败'),
  });

  const deleteGroupMutation = useMutation({
    mutationFn: (groupCode: string) => deleteEnvGroup(groupCode),
    onSuccess: async (_result, groupCode) => {
      await refreshGroups();
      groupDialogOpen.value = false;
      options.onGroupDeleted(groupCode);
      notifySuccess('分组已删除', groupCode);
    },
    onError: (failure) => notifyFailure(failure, '删除分组失败'),
  });

  function trimOrNull(value: string): string | null {
    return value.trim() === '' ? null : value.trim();
  }

  async function submitGroup(): Promise<void> {
    const form = groupForm.value;
    if (editingGroupCode.value) {
      const current = new Set(form.keys.map((key) => key.keyCode.trim()));
      const removed = originalKeyCodes.value.filter((keyCode) => !current.has(keyCode));
      if (removed.length > 0) {
        try {
          await ElMessageBox.confirm(
            `这次保存会移除 ${removed.join('、')}，所有环境下这些键已配置的值也会被清空，且不可恢复。`,
            '确认移除这些键',
            { type: 'warning', confirmButtonText: '继续保存', cancelButtonText: '取消' },
          );
        } catch {
          return;
        }
      }
    }
    const body: EnvGroupSaveRequest = {
      groupCode: (editingGroupCode.value ?? form.groupCode).trim(),
      displayName: form.displayName.trim(),
      icon: trimOrNull(form.icon),
      description: trimOrNull(form.description),
      sortOrder: form.sortOrder,
      /* 顺序以页面上的行序为准：显式给 10/20/30… 比让后端从 0 自增更不容易撞号。 */
      keys: form.keys.map((key, index) => ({
        keyCode: key.keyCode.trim(),
        label: key.label.trim(),
        valueType: key.valueType,
        required: key.required,
        secret: key.secret,
        placeholder: trimOrNull(key.placeholder),
        exampleValue: trimOrNull(key.exampleValue),
        description: trimOrNull(key.description),
        sortOrder: (index + 1) * 10,
        reserved: key.reserved,
      })),
    };
    saveGroupMutation.mutate({ code: editingGroupCode.value, body });
  }

  async function confirmDeleteGroup(group: EnvGroupTemplate): Promise<void> {
    try {
      await ElMessageBox.confirm(
        `删除分组「${group.displayName}」会连同它的 ${group.keys.length} 个键声明，`
          + '以及所有环境下这些键的值一起删除，且不可恢复。',
        '确认删除变量分组',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    deleteGroupMutation.mutate(group.groupCode);
  }

  async function confirmDeleteEditingGroup(): Promise<void> {
    const code = editingGroupCode.value;
    if (!code) return;
    const group = groupByCode.value.get(code);
    if (group) await confirmDeleteGroup(group);
  }

  return {
    groupDialogOpen,
    editingGroupCode,
    groupForm,
    groupCodeIssue,
    groupKeyIssues,
    groupProblems,
    canSaveGroup,
    saveGroupMutation,
    openCreateGroup,
    openEditGroup,
    addGroupKey,
    removeGroupKey,
    submitGroup,
    confirmDeleteEditingGroup,
  };
}

export type GroupManager = ReturnType<typeof useGroupManager>;
