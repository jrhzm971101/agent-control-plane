import { computed } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { listEnvGroups, listEnvInstances, listEnvironments } from '@/api/controlplane';
import type { EnvInstanceRow } from '@/api/controlplane/types';
import { queryKeys } from '@/lib/queryKeys';

/**
 * 环境页的共享取数与刷新入口。
 *
 * 编辑器、实例管理和分组管理都消费同一份目录，避免每块各自请求、
 * 保存后再互相猜什么时候该刷新。
 */
export function useEnvironmentCatalog() {
  const queryClient = useQueryClient();

  const { data: list, isLoading, error } = useQuery({
    queryKey: queryKeys.environments,
    queryFn: listEnvironments,
  });
  const { data: groups, isLoading: groupsLoading, error: groupsError } = useQuery({
    queryKey: queryKeys.envGroups,
    queryFn: listEnvGroups,
  });
  const { data: instanceData, isLoading: instancesLoading, error: instancesError } = useQuery({
    queryKey: queryKeys.envInstances,
    queryFn: listEnvInstances,
  });

  const envList = computed(() => list.value ?? []);
  const groupList = computed(() => groups.value ?? []);
  const instanceRows = computed(() => instanceData.value ?? []);
  const groupByCode = computed(
    () => new Map(groupList.value.map((group) => [group.groupCode, group])),
  );

  function savedInstancesOfGroup(groupCode: string): EnvInstanceRow[] {
    return instanceRows.value
      .filter((row) => row.groupCode === groupCode)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.instanceCode.localeCompare(b.instanceCode));
  }

  const instanceCountByGroup = computed(() => {
    const counts = new Map<string, number>();
    for (const row of instanceRows.value) {
      counts.set(row.groupCode, (counts.get(row.groupCode) ?? 0) + 1);
    }
    return counts;
  });

  function instanceCountOf(groupCode: string): number {
    return instanceCountByGroup.value.get(groupCode) ?? 0;
  }

  async function refreshEnvironments(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.environments });
  }

  async function refreshGroups(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.envGroups });
    await queryClient.invalidateQueries({ queryKey: queryKeys.envInstances });
    await refreshEnvironments();
  }

  async function refreshInstances(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.envInstances });
    await refreshEnvironments();
  }

  return {
    queryClient,
    isLoading,
    error,
    groupsLoading,
    groupsError,
    instancesLoading,
    instancesError,
    envList,
    groupList,
    instanceRows,
    groupByCode,
    savedInstancesOfGroup,
    instanceCountOf,
    refreshEnvironments,
    refreshGroups,
    refreshInstances,
  };
}

export type EnvironmentCatalog = ReturnType<typeof useEnvironmentCatalog>;
