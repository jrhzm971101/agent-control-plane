<script setup lang="ts">
/*
 * 工具目录页：只读的代码资产清点。
 *
 * <h2>为什么这一页是表格而不是卡片墙</h2>
 * 治理页（prompt / skill / mcp / agent）用卡片是因为它们的注意力单位是"一条内容的
 * 正文与它的引用关系"；而这一页要回答的是"我们到底有哪些工具、谁在用它"——
 * 53 个 bean 横向扫读，表格一屏能放 12 行，卡片墙只能放 3 张。详情放到点击后的抽屉里。
 *
 * <h2>为什么没有"新建工具"</h2>
 * 工具是代码里的 Spring bean（`@Tool` 注解的方法），逻辑必须写代码。平台能治理的
 * 只有"哪个 agent 挂哪几个 bean"，所以这里是只读目录，没有写入口。
 *
 * <h2>字段来自哪里</h2>
 * `name` 是模型看到的工具名，`beanName` 才是 agent 引用时要填的值 ——
 * 这两个不是一回事，混用会导致"配了但工具没生效"，所以表格把两者都列出来。
 * 「挂载的 Agent」是本地从 agent 列表的 tools 字段反算的，不额外请求。
 */
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { listAgents, listToolCatalog } from '@/api/controlplane';
import type { ToolMeta } from '@/api/controlplane/types';
import { queryKeys } from '@/lib/queryKeys';
import { agentDisplayName } from '@/lib/agentDisplay';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import FilterChips from '@/components/ui/FilterChips.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';

const { data: tools, isLoading, error } = useQuery({
  queryKey: queryKeys.toolCatalog,
  queryFn: listToolCatalog,
});
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

/** agent 标识 → 展示名；挂载方列表与筛选下拉都展示 agent，给人看的该是名字。 */
const displayNameOf = computed(() => agentDisplayName(agents.value));

const list = computed(() => tools.value ?? []);

/** 反向表：工具 bean 名 -> 挂了它的 agent 名。 */
const mountedBy = computed(() => {
  const map = new Map<string, string[]>();
  for (const row of agents.value ?? []) {
    for (const beanName of row.tools ?? []) {
      const owners = map.get(beanName) ?? [];
      owners.push(row.agentName);
      map.set(beanName, owners);
    }
  }
  return map;
});

const mountedOf = (beanName: string) => mountedBy.value.get(beanName) ?? [];

/** agent 下拉选项只列真的挂了工具的，避免给出十几个必然筛出空集的选项。 */
const agentOptions = computed(() =>
  [...new Set([...mountedBy.value.values()].flat())].sort((a, b) => a.localeCompare(b)),
);

// ==================== 筛选 ====================

const usageChip = ref('all');
const keyword = ref('');
const agentFilter = ref('');

const chips = computed(() => [
  { key: 'all', label: '全部', count: list.value.length },
  { key: 'used', label: '被引用', count: list.value.filter((t) => mountedOf(t.beanName).length > 0).length },
  { key: 'unused', label: '没人引用', count: list.value.filter((t) => mountedOf(t.beanName).length === 0).length },
]);

const visible = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  return list.value.filter((row) => {
    if (usageChip.value === 'used' && mountedOf(row.beanName).length === 0) return false;
    if (usageChip.value === 'unused' && mountedOf(row.beanName).length > 0) return false;
    if (agentFilter.value && !mountedOf(row.beanName).includes(agentFilter.value)) return false;
    if (!lower) return true;
    return `${row.name} ${row.beanName} ${row.description ?? ''}`.toLowerCase().includes(lower);
  });
});

const isFiltered = computed(
  () => Boolean(keyword.value || agentFilter.value) || usageChip.value !== 'all',
);

function reset() {
  usageChip.value = 'all';
  keyword.value = '';
  agentFilter.value = '';
}

// ==================== 详情抽屉 ====================

const drawerOpen = ref(false);
const selected = ref<ToolMeta | null>(null);

function openDetail(row: ToolMeta) {
  selected.value = row;
  drawerOpen.value = true;
}

/** 说明是给模型看的长文本（常带换行与列举），抽屉里原样展示，不做加工。 */
const selectedDescription = computed(() => selected.value?.description?.trim() || '（没有写说明）');
</script>

<template>
  <FilterBar :result="{ count: visible.length, total: list.length, noun: '个工具' }">
    <template #chips>
      <FilterChips v-model="usageChip" :items="chips" />
    </template>
    <FilterField label="关键字" width="280px">
      <el-input v-model="keyword" placeholder="工具名 / 说明" clearable />
    </FilterField>
    <FilterField label="挂载的 Agent" width="220px">
      <el-select v-model="agentFilter" placeholder="全部 Agent" clearable filterable>
        <!-- label 是展示名，value 仍是 agent-name（筛选比的是挂载清单里的标识） -->
        <el-option v-for="item in agentOptions" :key="item" :label="displayNameOf(item)" :value="item" />
      </el-select>
    </FilterField>
    <template #actions>
      <el-button :disabled="!isFiltered" @click="reset">重置</el-button>
    </template>
  </FilterBar>

  <TableCard :loading="isLoading">
    <EmptyState v-if="error" title="读不到工具目录" :hint="(error as Error).message" />
    <EmptyState
      v-else-if="visible.length === 0"
      :title="list.length === 0 ? '没有扫到任何工具 bean' : '没有符合条件的工具'"
    />
    <el-table v-else :data="visible" @row-click="openDetail">
      <el-table-column label="工具名" min-width="220">
        <template #default="{ row }">
          <span class="mono strong">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column label="bean 名" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="mono">{{ row.beanName }}</span>
        </template>
      </el-table-column>
      <el-table-column label="说明" min-width="300" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ muted: !row.description }">{{ row.description?.trim() || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="参数" min-width="80" align="right">
        <template #default="{ row }">
          <span class="mono">{{ row.parameters?.length ?? 0 }}</span>
        </template>
      </el-table-column>
      <el-table-column label="引用" min-width="80" align="right">
        <template #default="{ row }">
          <span class="mono">{{ mountedOf(row.beanName).length }}</span>
        </template>
      </el-table-column>
    </el-table>
  </TableCard>

  <el-drawer v-model="drawerOpen" size="680px" :with-header="false" destroy-on-close>
    <div v-if="selected">
      <header class="dw__hd">
        <span class="mono strong">{{ selected.name }}</span>
      </header>
      <div class="dw__bd">
        <el-form label-position="top">
          <el-form-item label="引用时要填的值（bean 名）">
            <el-input :model-value="selected.beanName" disabled class="mono" />
          </el-form-item>
        </el-form>

        <div class="sec">
          <div class="sec__hd"><h3>说明</h3></div>
          <pre class="doc">{{ selectedDescription }}</pre>
        </div>

        <div class="sec">
          <div class="sec__hd">
            <h3>参数</h3>
            <span class="hint">{{ selected.parameters?.length ?? 0 }} 个</span>
          </div>
          <p v-if="(selected.parameters?.length ?? 0) === 0" class="hint">没有参数。</p>
          <div v-for="param in selected.parameters ?? []" :key="param.name" class="param">
            <span class="mono strong">{{ param.name }}</span>
            <span class="param__ds">{{ param.description || '（没有写说明）' }}</span>
          </div>
        </div>

        <div class="sec">
          <div class="sec__hd"><h3>挂载的 Agent</h3></div>
          <p v-if="mountedOf(selected.beanName).length === 0">暂无引用</p>
          <div v-else class="row wrap">
            <span
              v-for="name in mountedOf(selected.beanName)"
              :key="name"
              class="tag-chip"
              :title="name"
            >{{ displayNameOf(name) }}</span>
          </div>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.dw__hd {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--bd);
}
.dw__bd {
  padding-top: var(--s4);
}
.sec {
  padding-top: var(--s4);
  margin-top: var(--s4);
  border-top: 1px solid var(--bd-soft);
}
.sec:first-child {
  padding-top: 0;
  margin-top: 0;
  border-top: none;
}
.sec__hd {
  display: flex;
  align-items: baseline;
  gap: var(--s3);
  margin-bottom: var(--s3);
}
.sec__hd h3 {
  margin: 0;
}
.doc {
  margin: 0;
  padding: 12px 14px;
  max-height: 340px;
  overflow: auto;
  background: var(--panel-sunken);
  border: 1px solid var(--bd-soft);
  border-radius: var(--r-md);
  color: var(--t1);
  font: 12.5px/1.7 var(--sans);
  white-space: pre-wrap;
}
.param {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: var(--s3);
  padding: 8px 0;
  border-bottom: 1px solid var(--bd-soft);
}
.param:last-child {
  border-bottom: none;
}
.param__ds {
  color: var(--t2);
  font-size: 13px;
  line-height: 1.6;
}
</style>
