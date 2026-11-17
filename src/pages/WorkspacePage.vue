<script setup lang="ts">
/*
 * 工作区 · 列表页（/workspace）。
 *
 * 这一页只回答一个问题：有哪些 HARNESS agent 的工作区可以维护，各自的文件存在哪。
 * 里面有什么文件、内容长什么样，在 /workspace/:agentName。
 *
 * ===========================================================================
 * 一、这一页为什么必须存在（而不是让人去磁盘上改）
 *
 * agent 的工作区分两种后端（md_agent_workspace.fs_backend）：
 *   - LOCAL ：文件真的落在磁盘 workspace/harness/<agentName>/ 下；
 *   - REMOTE：文件存在 MySQL 的 KV 里，磁盘上什么都没有。
 * 直接去磁盘上改，对 REMOTE 的 agent 完全无效 —— 而且不会有任何报错，只会让人
 * 得出"改了没用"这个错误结论。所以维护入口只能有一个：后端 /api/workspace，
 * 它走框架的 AbstractFilesystem，由框架把两种后端分发掉。
 *
 * 于是这一页最重要的一列是「生效的文件系统」（filesystemType）：它回答的才是
 * "文件到底在哪"，而 fsBackend 只是配置里填的那个值 —— 两者不一致是完全正常的
 * （例如配 REMOTE 但框架装配出 CompositeFilesystem）。两列必须一起看，
 * 所以两列都留着，不合并成一句人话。
 *
 * ===========================================================================
 * 二、工作区根路径为什么要显示出来
 *
 * 它是「文件到底在哪」的唯一直接答案。REMOTE 下它只是一个逻辑根（磁盘上并没有这个目录），
 * 所以它单独出现时可能误导人 —— 这正是上一段那两列必须同时存在的原因。
 */
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { listWorkspaceAgents } from '@/api/controlplane';
import type { WorkspaceAgentRow } from '@/api/controlplane/types';
import { messageOf } from '@/features/controlplane/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { harnessLink } from '@/lib/links';
import type { BadgeVariant } from '@/components/ui/types';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';

const router = useRouter();

const { data: agents, isLoading, error } = useQuery({
  queryKey: queryKeys.workspaceAgents,
  queryFn: listWorkspaceAgents,
});

const agentRows = computed<WorkspaceAgentRow[]>(() => agents.value ?? []);

function backendBadge(row: WorkspaceAgentRow): { text: string; variant: BadgeVariant } {
  if (row.fsBackend === 'REMOTE') return { text: 'MySQL', variant: 'managed' };
  if (row.fsBackend === 'LOCAL') return { text: '本地磁盘', variant: 'react' };
  return { text: '未配置', variant: 'off' };
}

function openAgent(row: WorkspaceAgentRow): void {
  void router.push(`/workspace/${encodeURIComponent(row.agentName)}`);
}
</script>

<template>
  <TableCard :loading="isLoading">
    <EmptyState
      v-if="error"
      title="读不到工作区清单"
      :hint="messageOf(error)"
    />
    <EmptyState
      v-else-if="agentRows.length === 0"
      title="还没有 HARNESS agent"
    />
    <el-table v-else :data="agentRows">
      <el-table-column label="Agent" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          <!--
            这一页只列 HARNESS agent，所以目的地固定是编排域。
            旁边那列「查看文件」进的是工作区内部，这个链接进的是 agent 的编排配置 ——
            两个入口都指向"同一个 agent 的不同面"，不合并成一个是刻意的。
          -->
          <router-link class="strong lk" :to="harnessLink(row.agentName)">
            {{ row.agentName }}
          </router-link>
        </template>
      </el-table-column>
      <el-table-column label="文件后端" width="120">
        <template #default="{ row }">
          <AppBadge :variant="backendBadge(row).variant">{{ backendBadge(row).text }}</AppBadge>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openAgent(row)">查看文件</el-button>
        </template>
      </el-table-column>
    </el-table>

  </TableCard>
</template>
