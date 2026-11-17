import { computed, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import {
  createEnvInstance,
  deleteEnvInstance,
  getEnvInstance,
  saveEnvInstance,
} from '@/api/controlplane';
import type {
  EnvGroupTemplate,
  EnvInstanceRow,
  EnvInstanceSaveRequest,
} from '@/api/controlplane/types';
import { notifyFailure, notifySuccess } from '@/features/controlplane/feedback';
import type { EnvironmentCatalog } from './useEnvironmentCatalog';

interface InstanceForm {
  groupCode: string;
  instanceCode: string;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
}

function emptyInstanceForm(): InstanceForm {
  return {
    groupCode: '',
    instanceCode: '',
    displayName: '',
    enabled: true,
    sortOrder: 0,
  };
}

interface InstanceManagerOptions {
  removeDraftInstance: (row: Pick<EnvInstanceRow, 'groupCode' | 'instanceCode'>) => void;
  openGroupEditor: (group: EnvGroupTemplate) => void;
}

/**
 * 分组下的实例清单与实例编辑弹窗。
 *
 * 实例的键值属于实例自身，所有绑定它的环境共用；环境页只选择实例，不改值。
 */
export function useInstanceManager(
  catalog: EnvironmentCatalog,
  options: InstanceManagerOptions,
) {
  const {
    groupList,
    groupByCode,
    instanceRows,
    savedInstancesOfGroup,
    refreshInstances,
  } = catalog;

  const instanceManagerOpen = ref(false);
  const managerGroupCode = ref('');

  const managerGroup = computed(() => groupByCode.value.get(managerGroupCode.value) ?? null);
  const managerInstances = computed(() => savedInstancesOfGroup(managerGroupCode.value));

  function openInstanceManager(groupCode: string): void {
    managerGroupCode.value = groupCode;
    instanceManagerOpen.value = true;
  }

  const instanceDialogOpen = ref(false);
  const editingInstance = ref<EnvInstanceRow | null>(null);
  const instanceForm = ref<InstanceForm>(emptyInstanceForm());

  const instanceConfigValues = ref<Record<string, string>>({});
  const instanceConfigLoading = ref(false);
  const instanceConfigLoaded = ref(false);
  const instanceConfigError = ref('');

  const instanceConfigGroup = computed(() => groupByCode.value.get(instanceForm.value.groupCode));
  const instanceConfigKeys = computed(() => instanceConfigGroup.value?.keys ?? []);
  const instanceConfigIssues = computed(() => {
    const issues = new Map<string, string>();
    for (const key of instanceConfigKeys.value) {
      const value = (instanceConfigValues.value[key.keyCode] ?? '').trim();
      if (!value) continue;
      if (key.valueType === 'INT' && !/^[+-]?\d+$/.test(value)) {
        issues.set(key.keyCode, '这个键要求整数');
      } else if (key.valueType === 'BOOL' && !/^(true|false)$/i.test(value)) {
        issues.set(key.keyCode, '这个键要求 true / false');
      }
    }
    return issues;
  });

  const instanceFormIssue = computed(() => {
    const form = instanceForm.value;
    if (!form.groupCode) return '请选择分组';
    const code = form.instanceCode.trim();
    if (!code) return '实例编码不能为空';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      return '实例编码只能用字母、数字、下划线、连字符，1-64 位';
    }
    if (form.displayName.trim().length > 128) return '展示名最多 128 个字符';
    if (!editingInstance.value && instanceRows.value.some(
      (row) => row.groupCode === form.groupCode
        && row.instanceCode === code,
    )) {
      return `实例 ${code} 已存在`;
    }
    return '';
  });

  const canSaveInstance = computed(
    () => instanceFormIssue.value === ''
      && instanceConfigIssues.value.size === 0
      && instanceConfigLoaded.value
      && !instanceConfigLoading.value
      && !saveInstanceMutation.isPending.value,
  );

  const instanceGroupLocked = computed(
    () => !!editingInstance.value || (instanceManagerOpen.value && !!managerGroupCode.value),
  );

  let instanceConfigSeq = 0;

  function resetInstanceConfig(): void {
    instanceConfigSeq += 1;
    instanceConfigValues.value = {};
    instanceConfigLoading.value = false;
    instanceConfigLoaded.value = false;
    instanceConfigError.value = '';
  }

  async function loadInstanceConfig(): Promise<void> {
    const seq = ++instanceConfigSeq;
    const groupCode = instanceForm.value.groupCode;
    const instanceCode = instanceForm.value.instanceCode.trim();
    instanceConfigValues.value = {};
    instanceConfigLoaded.value = false;
    instanceConfigError.value = '';
    instanceConfigLoading.value = false;
    if (!groupCode) return;

    /* 新实例还没有落库，键模板已经在页面上，直接开放填写。 */
    if (!editingInstance.value || !instanceCode) {
      instanceConfigLoaded.value = true;
      return;
    }

    instanceConfigLoading.value = true;
    try {
      const detail = await getEnvInstance(groupCode, instanceCode);
      if (seq !== instanceConfigSeq) return;
      const values: Record<string, string> = {};
      for (const item of detail.values) {
        if (item.value !== null && item.value !== undefined) values[item.keyCode] = item.value;
      }
      instanceConfigValues.value = values;
      instanceConfigLoaded.value = true;
    } catch (failure) {
      if (seq !== instanceConfigSeq) return;
      instanceConfigError.value = failure instanceof Error ? failure.message : '读取实例配置失败';
    } finally {
      if (seq === instanceConfigSeq) instanceConfigLoading.value = false;
    }
  }

  function onInstanceGroupChange(): void {
    resetInstanceConfig();
    void loadInstanceConfig();
  }

  function collectInstanceConfigValues(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const key of instanceConfigKeys.value) {
      const value = (instanceConfigValues.value[key.keyCode] ?? '').trim();
      if (value) values[key.keyCode] = value;
    }
    return values;
  }

  function openCreateInstance(groupCode?: string): void {
    editingInstance.value = null;
    const preferred = groupCode ?? (instanceManagerOpen.value ? managerGroupCode.value : '');
    instanceForm.value = {
      ...emptyInstanceForm(),
      groupCode: preferred || groupList.value[0]?.groupCode || '',
    };
    resetInstanceConfig();
    instanceDialogOpen.value = true;
    void loadInstanceConfig();
  }

  function openEditInstance(row: EnvInstanceRow): void {
    editingInstance.value = row;
    instanceForm.value = {
      groupCode: row.groupCode,
      instanceCode: row.instanceCode,
      displayName: row.displayName,
      enabled: row.enabled,
      sortOrder: row.sortOrder,
    };
    resetInstanceConfig();
    instanceDialogOpen.value = true;
    void loadInstanceConfig();
  }

  const saveInstanceMutation = useMutation({
    mutationFn: async (payload: {
      editing: EnvInstanceRow | null;
      groupCode: string;
      instanceCode: string;
      body: EnvInstanceSaveRequest;
    }) => {
      if (payload.editing) {
        await saveEnvInstance(
          payload.editing.groupCode,
          payload.editing.instanceCode,
          payload.body,
        );
      } else {
        await createEnvInstance(
          payload.groupCode,
          payload.instanceCode,
          payload.body,
        );
      }
      return payload;
    },
    onSuccess: async (payload) => {
      await refreshInstances();
      instanceDialogOpen.value = false;
      notifySuccess(payload.editing ? '实例已保存' : '实例已创建', payload.instanceCode);
    },
    onError: (failure) => notifyFailure(failure, '保存实例失败'),
  });

  const deleteInstanceMutation = useMutation({
    mutationFn: (row: EnvInstanceRow) =>
      deleteEnvInstance(row.groupCode, row.instanceCode),
    onSuccess: async (_result, row) => {
      await refreshInstances();
      options.removeDraftInstance(row);
      notifySuccess('实例已删除', `${row.groupCode} / ${row.instanceCode}`);
    },
    onError: (failure) => notifyFailure(failure, '删除实例失败'),
  });

  function submitInstance(): void {
    const form = instanceForm.value;
    if (instanceFormIssue.value || !instanceConfigLoaded.value) return;
    saveInstanceMutation.mutate({
      editing: editingInstance.value,
      groupCode: form.groupCode,
      instanceCode: form.instanceCode.trim(),
      body: {
        displayName: form.displayName.trim() || form.instanceCode.trim(),
        enabled: form.enabled,
        sortOrder: form.sortOrder || undefined,
        values: collectInstanceConfigValues(),
      },
    });
  }

  async function confirmDeleteInstance(row: EnvInstanceRow): Promise<void> {
    try {
      await ElMessageBox.confirm(
        `删除实例「${row.displayName || row.instanceCode}」会连同它的配置值和所有环境绑定一起删除，且不可恢复。`,
        '确认删除实例',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    deleteInstanceMutation.mutate(row);
  }

  function openGroupEditor(): void {
    if (managerGroup.value) options.openGroupEditor(managerGroup.value);
  }

  return {
    instanceManagerOpen,
    managerGroupCode,
    managerGroup,
    managerInstances,
    instanceDialogOpen,
    editingInstance,
    instanceForm,
    instanceConfigValues,
    instanceConfigLoading,
    instanceConfigLoaded,
    instanceConfigError,
    instanceConfigGroup,
    instanceConfigKeys,
    instanceConfigIssues,
    instanceFormIssue,
    canSaveInstance,
    instanceGroupLocked,
    saveInstanceMutation,
    deleteInstanceMutation,
    openInstanceManager,
    openCreateInstance,
    openEditInstance,
    submitInstance,
    confirmDeleteInstance,
    onInstanceGroupChange,
    openGroupEditor,
  };
}

export type InstanceManager = ReturnType<typeof useInstanceManager>;
