import { computed, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { ElMessageBox } from 'element-plus';
import {
  createEnvironment,
  deleteEnvironment,
  environmentDetail,
  saveEnvironment,
} from '@/api/controlplane';
import type {
  EnvDetail,
  EnvInstanceRow,
  EnvRow,
  EnvSaveRequest,
} from '@/api/controlplane/types';
import { notifyFailure, notifySuccess } from '@/features/controlplane/feedback';
import { queryKeys } from '@/lib/queryKeys';
import type { EnvironmentCatalog } from './useEnvironmentCatalog';

interface DraftHead {
  envCode: string;
  displayName: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
}

interface DraftInstance {
  uid: number;
  groupCode: string;
  instanceCode: string;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
}

interface EntryGroup {
  groupCode: string;
  displayName: string;
  builtin: boolean;
  options: DraftInstance[];
  boundCodes: string[];
}

let uidSeq = 0;
const nextUid = (): number => (uidSeq += 1);

function emptyHead(): DraftHead {
  return {
    envCode: '',
    displayName: '',
    description: '',
    enabled: true,
    sortOrder: 0,
  };
}

/**
 * 环境编辑抽屉：只负责「环境主表 + 绑定哪些分组的哪些实例」。
 * 实例键值属于实例本身，不在这里编辑。
 */
export function useEnvironmentEditor(catalog: EnvironmentCatalog) {
  const {
    queryClient,
    groupList,
    groupByCode,
    savedInstancesOfGroup,
    refreshEnvironments,
    refreshGroups,
  } = catalog;

  const drawerOpen = ref(false);
  const creating = ref(false);
  const editingEnvCode = ref<string | null>(null);
  const detailLoading = ref(false);
  const head = ref<DraftHead>(emptyHead());
  const instanceDrafts = ref<DraftInstance[]>([]);
  /** 当前环境选中的分组；顺序即展示顺序，允许先选组再补实例。 */
  const draftGroupCodes = ref<string[]>([]);

  const addGroupDialogOpen = ref(false);
  const addGroupCode = ref('');
  const instancePickerOpen = ref(false);
  const instancePickerGroupCode = ref('');
  const instancePickerCodes = ref<string[]>([]);

  function instancesOfGroup(groupCode: string): DraftInstance[] {
    return instanceDrafts.value
      .filter((item) => item.groupCode === groupCode)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.instanceCode.localeCompare(b.instanceCode));
  }

  const draftGroupSet = computed(() => new Set(draftGroupCodes.value));

  const addableGroups = computed(() =>
    groupList.value.filter((group) => !draftGroupSet.value.has(group.groupCode)),
  );

  function selectableInstancesOfGroup(groupCode: string): DraftInstance[] {
    return savedInstancesOfGroup(groupCode).map((row) => ({
      uid: nextUid(),
      groupCode: row.groupCode,
      instanceCode: row.instanceCode,
      displayName: row.displayName || row.instanceCode,
      enabled: row.enabled,
      sortOrder: row.sortOrder,
    }));
  }

  const entryGroups = computed<EntryGroup[]>(() => {
    const result: EntryGroup[] = [];
    for (const groupCode of draftGroupCodes.value) {
      const group = groupByCode.value.get(groupCode);
      if (!group) continue;
      result.push({
        groupCode: group.groupCode,
        displayName: group.displayName,
        builtin: group.builtin,
        options: selectableInstancesOfGroup(group.groupCode),
        boundCodes: instancesOfGroup(group.groupCode).map((item) => item.instanceCode),
      });
    }
    return result;
  });

  function addGroupToDraft(groupCode: string): void {
    if (!groupCode || draftGroupSet.value.has(groupCode)) return;
    draftGroupCodes.value = [...draftGroupCodes.value, groupCode];
  }

  function openAddGroupDialog(): void {
    addGroupCode.value = '';
    addGroupDialogOpen.value = true;
  }

  function confirmAddGroup(): void {
    if (!addGroupCode.value) return;
    addGroupToDraft(addGroupCode.value);
    addGroupDialogOpen.value = false;
  }

  function removeGroupFromDraft(groupCode: string): void {
    draftGroupCodes.value = draftGroupCodes.value.filter((code) => code !== groupCode);
    instanceDrafts.value = instanceDrafts.value.filter((item) => item.groupCode !== groupCode);
  }

  function bindInstance(groupCode: string, instanceCode: string): void {
    if (!instanceCode) return;
    if (instancesOfGroup(groupCode).some((item) => item.instanceCode === instanceCode)) return;
    const row = savedInstancesOfGroup(groupCode).find(
      (item) => item.instanceCode === instanceCode,
    );
    if (!row) return;
    instanceDrafts.value = [...instanceDrafts.value, {
      uid: nextUid(),
      groupCode: row.groupCode,
      instanceCode: row.instanceCode,
      displayName: row.displayName || row.instanceCode,
      enabled: row.enabled,
      sortOrder: row.sortOrder,
    }];
  }

  function unbindInstance(groupCode: string, instanceCode: string): void {
    instanceDrafts.value = instanceDrafts.value.filter(
      (item) => !(item.groupCode === groupCode && item.instanceCode === instanceCode),
    );
  }

  /** 多选框变化 = 绑定新增项 + 解绑被取消项，全程只改草稿。 */
  function setGroupInstances(groupCode: string, codes: string[]): void {
    const next = new Set(codes);
    const removed = instancesOfGroup(groupCode)
      .map((item) => item.instanceCode)
      .filter((code) => !next.has(code));
    for (const code of removed) unbindInstance(groupCode, code);
    for (const code of codes) {
      if (instancesOfGroup(groupCode).some((item) => item.instanceCode === code)) continue;
      bindInstance(groupCode, code);
    }
  }

  const instancePickerGroup = computed(() =>
    entryGroups.value.find((group) => group.groupCode === instancePickerGroupCode.value),
  );

  function openInstancePicker(groupCode: string): void {
    instancePickerGroupCode.value = groupCode;
    instancePickerCodes.value = instancesOfGroup(groupCode).map((item) => item.instanceCode);
    instancePickerOpen.value = true;
  }

  function confirmInstancePicker(): void {
    if (!instancePickerGroupCode.value) return;
    setGroupInstances(instancePickerGroupCode.value, instancePickerCodes.value);
    instancePickerOpen.value = false;
  }

  const instanceIssue = computed(() => {
    const seen = new Set<string>();
    for (const instance of instanceDrafts.value) {
      const key = `${instance.groupCode}\u0000${instance.instanceCode}`;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(instance.instanceCode)) {
        return `实例标识不合法：${instance.instanceCode}`;
      }
      if (seen.has(key)) {
        return `分组 ${instance.groupCode} 下的实例 ${instance.instanceCode} 重复`;
      }
      if (instance.displayName.trim().length > 128) {
        return `实例 ${instance.instanceCode} 的展示名超过 128 个字符`;
      }
      seen.add(key);
    }
    return '';
  });

  const envCodeIssue = computed(() => {
    if (!creating.value) return '';
    const code = head.value.envCode.trim();
    if (!code) return '环境编码不能为空';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return '只能用字母、数字、下划线、连字符，1-64 位';
    return '';
  });

  const canSave = computed(
    () =>
      head.value.displayName.trim() !== ''
      && envCodeIssue.value === ''
      && instanceIssue.value === ''
      && !detailLoading.value
      && !saveEnvMutation.isPending.value,
  );

  function draftInstancesFromDetail(detail: EnvDetail): DraftInstance[] {
    return detail.groups.flatMap((group) =>
      group.instances.map((instance) => ({
        uid: nextUid(),
        groupCode: group.groupCode,
        instanceCode: instance.instanceCode,
        displayName: instance.displayName || instance.instanceCode,
        enabled: instance.enabled,
        sortOrder: instance.sortOrder,
      })),
    );
  }

  /** 分组的选择态由已绑定实例反推：没有绑定实例的分组不进环境抽屉。 */
  function draftGroupCodesFromDetail(detail: EnvDetail): string[] {
    return detail.groups
      .filter((group) => group.instances.length > 0)
      .map((group) => group.groupCode);
  }

  function applyHead(detail: EnvDetail): void {
    head.value = {
      envCode: detail.envCode,
      displayName: detail.displayName,
      description: detail.description ?? '',
      enabled: detail.enabled,
      sortOrder: detail.sortOrder,
    };
  }

  function loadDetail(envCode: string): Promise<EnvDetail> {
    return queryClient.fetchQuery({
      queryKey: queryKeys.environment(envCode),
      queryFn: () => environmentDetail(envCode),
      staleTime: 0,
    });
  }

  async function openEdit(row: EnvRow): Promise<void> {
    creating.value = false;
    editingEnvCode.value = row.envCode;
    drawerOpen.value = true;
    detailLoading.value = true;
    instanceDrafts.value = [];
    draftGroupCodes.value = [];
    try {
      const detail = await loadDetail(row.envCode);
      applyHead(detail);
      instanceDrafts.value = draftInstancesFromDetail(detail);
      draftGroupCodes.value = draftGroupCodesFromDetail(detail);
    } catch (failure) {
      notifyFailure(failure, '读取环境详情失败');
      drawerOpen.value = false;
    } finally {
      detailLoading.value = false;
    }
  }

  function openCreate(): void {
    creating.value = true;
    editingEnvCode.value = null;
    drawerOpen.value = true;
    detailLoading.value = false;
    head.value = emptyHead();
    instanceDrafts.value = [];
    draftGroupCodes.value = [];
  }

  async function openCopy(row: EnvRow): Promise<void> {
    creating.value = true;
    editingEnvCode.value = null;
    drawerOpen.value = true;
    detailLoading.value = true;
    instanceDrafts.value = [];
    draftGroupCodes.value = [];
    try {
      const detail = await loadDetail(row.envCode);
      applyHead({
        ...detail,
        envCode: `${detail.envCode}-copy`,
        displayName: `${detail.displayName} 副本`,
        enabled: true,
      });
      instanceDrafts.value = draftInstancesFromDetail(detail);
      draftGroupCodes.value = draftGroupCodesFromDetail(detail);
    } catch (failure) {
      notifyFailure(failure, '读取环境详情失败');
      drawerOpen.value = false;
    } finally {
      detailLoading.value = false;
    }
  }

  function buildBindings(): EnvSaveRequest['bindings'] {
    const result: EnvSaveRequest['bindings'] = {};
    for (const instance of instanceDrafts.value) {
      result[instance.groupCode] ??= [];
      result[instance.groupCode].push(instance.instanceCode);
    }
    return result;
  }

  function submit(): void {
    const body: EnvSaveRequest = {
      envCode: creating.value ? head.value.envCode.trim() : undefined,
      displayName: head.value.displayName.trim(),
      description: head.value.description.trim() || undefined,
      enabled: head.value.enabled,
      sortOrder: head.value.sortOrder || undefined,
      bindings: buildBindings(),
    };
    saveEnvMutation.mutate({
      envCode: creating.value ? null : editingEnvCode.value,
      body,
    });
  }

  async function confirmDelete(row: EnvRow): Promise<void> {
    try {
      await ElMessageBox.confirm(
        `删除环境「${row.displayName}」会连同它下面所有分组的值一起删除，且不可恢复。`,
        '确认删除环境',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    deleteEnvMutation.mutate(row.envCode);
  }

  const saveEnvMutation = useMutation({
    mutationFn: async (payload: { envCode: string | null; body: EnvSaveRequest }) => {
      if (payload.envCode) {
        await saveEnvironment(payload.envCode, payload.body);
      } else {
        await createEnvironment(payload.body);
      }
      return { envCode: payload.envCode ?? payload.body.envCode ?? '' };
    },
    onSuccess: async (_result, payload) => {
      await refreshEnvironments();
      if (payload.envCode) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.environment(payload.envCode) });
      }
      drawerOpen.value = false;
      notifySuccess(payload.envCode ? '环境已保存' : '环境已创建');
    },
    onError: (failure) => notifyFailure(failure, '保存环境失败'),
  });

  const deleteEnvMutation = useMutation({
    mutationFn: (envCode: string) => deleteEnvironment(envCode),
    onSuccess: async (_result, envCode) => {
      await refreshEnvironments();
      notifySuccess('环境已删除', envCode);
    },
    onError: (failure) => notifyFailure(failure, '删除环境失败'),
  });

  function removeDraftInstance(row: Pick<EnvInstanceRow, 'groupCode' | 'instanceCode'>): void {
    if (!drawerOpen.value) return;
    instanceDrafts.value = instanceDrafts.value.filter(
      (item) => !(item.groupCode === row.groupCode && item.instanceCode === row.instanceCode),
    );
  }

  return {
    drawerOpen,
    creating,
    editingEnvCode,
    detailLoading,
    head,
    draftGroupCodes,
    addGroupDialogOpen,
    addGroupCode,
    instancePickerOpen,
    instancePickerGroupCode,
    instancePickerCodes,
    addableGroups,
    entryGroups,
    instancePickerGroup,
    envCodeIssue,
    canSave,
    saveEnvMutation,
    openCreate,
    openEdit,
    openCopy,
    confirmDelete,
    openAddGroupDialog,
    confirmAddGroup,
    removeGroupFromDraft,
    openInstancePicker,
    confirmInstancePicker,
    submit,
    removeDraftInstance,
  };
}

export type EnvironmentEditor = ReturnType<typeof useEnvironmentEditor>;
