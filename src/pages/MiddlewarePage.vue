<script setup lang="ts">
/*
 * Middleware 页：只读目录 + 全局链 + 逐 agent 的挂载情况。
 *
 * 这一页「不能新建」是设计决定，不是没做完：
 * 中间件是 Spring 容器里的 MiddlewareBase bean，它的钩子逻辑必须写在代码里。
 * 平台能治理的只有「哪个 agent 挂哪几个 bean」，所以页面只做两件事 ——
 * 展示目录（有哪些可挂），以及展示每个 agent 实际挂了什么。
 *
 * 挂载信息是本地算的：agent 列表已经把每个 agent 的 middleware bean 名带回来了。
 */
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { getMiddlewareChain, listAgents, listMiddlewareCatalog } from '@/api/controlplane';
import type { AgentRow, MiddlewareMeta } from '@/api/controlplane/types';
import { queryKeys } from '@/lib/queryKeys';
import PaneCard from '@/components/ui/PaneCard.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';

const { data: catalog, isLoading } = useQuery({
  queryKey: queryKeys.middlewareCatalog,
  queryFn: listMiddlewareCatalog,
});
const { data: chain } = useQuery({ queryKey: queryKeys.middlewareChain, queryFn: getMiddlewareChain });
const { data: agents } = useQuery({ queryKey: queryKeys.agents, queryFn: listAgents });

/** 反向表：middleware bean 名 -> 挂了它的 agent 名。 */
const mountedBy = computed(() => {
  const map = new Map<string, string[]>();
  for (const row of agents.value ?? []) {
    for (const beanName of row.middleware ?? []) {
      const owners = map.get(beanName) ?? [];
      owners.push(row.agentName);
      map.set(beanName, owners);
    }
  }
  return map;
});

const mountedOf = (beanName: string) => mountedBy.value.get(beanName) ?? [];

/** 全局链是一条 bean 名清单（后端只挂了一个：调用链路观测）。 */
const globalChain = computed(() => chain.value?.global ?? []);

const mountedAgents = computed(() =>
  (agents.value ?? []).filter((row) => (row.middleware?.length ?? 0) > 0),
);

/** 绑定关系默认只显示数量；点数量或「查看」再打开明细，避免把多对多关系平铺成标签墙。 */
const detail = ref<{ title: string; caption: string; items: string[] } | null>(null);
const detailOpen = ref(false);

function openBean(row: MiddlewareMeta) {
  detail.value = {
    title: row.beanName,
    caption: '挂载这个中间件的 Agent',
    items: mountedOf(row.beanName),
  };
  detailOpen.value = true;
}

function openAgent(row: AgentRow) {
  detail.value = {
    title: row.displayName,
    caption: '这个 Agent 挂载的中间件',
    items: row.middleware ?? [],
  };
  detailOpen.value = true;
}
</script>

<template>
  <div class="split">
    <div class="stack">
      <TableCard :loading="isLoading">
        <EmptyState
          v-if="(catalog?.length ?? 0) === 0"
          title="没有扫到任何中间件 bean"
        />
        <el-table v-else :data="catalog">
          <el-table-column label="bean 名" min-width="190">
            <template #default="{ row }"><span class="mono strong">{{ row.beanName }}</span></template>
          </el-table-column>
          <el-table-column label="类名" min-width="300" show-overflow-tooltip>
            <template #default="{ row }"><span class="mono">{{ row.className }}</span></template>
          </el-table-column>
          <el-table-column label="挂载数" width="100" align="right">
            <template #default="{ row }">
              <el-button
                link
                type="primary"
                :disabled="mountedOf(row.beanName).length === 0"
                @click="openBean(row)"
              >
                {{ mountedOf(row.beanName).length }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </TableCard>

      <TableCard>
        <EmptyState
          v-if="mountedAgents.length === 0"
          title="还没有 agent 挂中间件"
        />
        <el-table v-else :data="mountedAgents">
          <el-table-column label="Agent" min-width="200">
            <template #default="{ row }"><span class="strong">{{ row.agentName }}</span></template>
          </el-table-column>
          <el-table-column label="数量" width="90" align="right">
            <template #default="{ row }"><span class="mono">{{ row.middleware?.length ?? 0 }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="90" align="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openAgent(row)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
      </TableCard>
    </div>

    <div class="stack">
      <PaneCard title="全局链">
        <div v-for="(name, index) in globalChain" :key="name" class="mw">
          <span class="ordnum">{{ index + 1 }}</span>
          <div class="mw-body"><b class="mono">{{ name }}</b></div>
        </div>
        <p v-if="globalChain.length === 0" class="hint">没有全局中间件。</p>
      </PaneCard>
    </div>
  </div>

  <el-drawer v-model="detailOpen" :with-header="false" size="460px" destroy-on-close>
    <div v-if="detail" class="mwd">
      <header class="mwd__hd">
        <div>
          <h2>{{ detail.title }}</h2>
          <p>{{ detail.caption }}</p>
        </div>
        <el-button @click="detailOpen = false">关闭</el-button>
      </header>
      <div v-if="detail.items.length > 0" class="mwd__list">
        <div v-for="(name, index) in detail.items" :key="name" class="mwd__it">
          <span class="ordnum">{{ index + 1 }}</span>
          <b class="mono">{{ name }}</b>
        </div>
      </div>
      <EmptyState v-else title="没有挂载项" />
    </div>
  </el-drawer>
</template>

<style scoped>
.mw {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: 9px 0;
  border-bottom: 1px solid var(--bd-soft);
}
.mw:last-of-type {
  border-bottom: none;
}
.mw-body {
  flex: 1;
  min-width: 0;
}
.mw-body b {
  font-size: 13.5px;
  font-weight: 600;
}
.mwd__hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s4);
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--bd-soft);
}
.mwd__hd h2 {
  margin: 0;
  font-size: 16px;
}
.mwd__hd p {
  margin: 4px 0 0;
  color: var(--t3);
  font-size: 12.5px;
}
.mwd__list {
  padding-top: var(--s2);
}
.mwd__it {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: 10px 0;
  border-bottom: 1px solid var(--bd-soft);
}
.mwd__it:last-child {
  border-bottom: none;
}
.mwd__it b {
  font-size: 13.5px;
  font-weight: 600;
}
</style>
