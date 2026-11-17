import { computed, ref, type Ref } from 'vue';
import type { EnvRow } from '@/api/controlplane/types';
import type { BadgeVariant } from '@/components/ui/types';

type Completeness = 'full' | 'partial' | 'empty';

const COMPLETENESS_VARIANT: Record<Completeness, BadgeVariant> = {
  full: 'ok',
  partial: 'wait',
  empty: 'off',
};

function completenessOf(row: EnvRow): Completeness {
  if (row.groups.length === 0 || row.groups.every((group) => group.status === 'EMPTY')) {
    return 'empty';
  }
  if (row.groups.some((group) => group.status === 'PARTIAL')) return 'partial';
  return 'full';
}

export function useEnvironmentFilters(envList: Ref<EnvRow[]>) {
  const keywordFilter = ref('');
  const completenessFilter = ref<'all' | Completeness>('all');

  const visible = computed(() => {
    const keyword = keywordFilter.value.trim().toLowerCase();
    return envList.value.filter((row) => {
      if (completenessFilter.value !== 'all' && completenessOf(row) !== completenessFilter.value) {
        return false;
      }
      if (keyword) {
        const haystack = `${row.displayName} ${row.envCode} ${row.description ?? ''}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  });

  const isFiltered = computed(
    () => keywordFilter.value.trim() !== '' || completenessFilter.value !== 'all',
  );

  function resetFilters(): void {
    keywordFilter.value = '';
    completenessFilter.value = 'all';
  }

  function completenessVariant(row: EnvRow): BadgeVariant {
    return COMPLETENESS_VARIANT[completenessOf(row)];
  }

  return {
    keywordFilter,
    completenessFilter,
    visible,
    isFiltered,
    resetFilters,
    completenessVariant,
  };
}
