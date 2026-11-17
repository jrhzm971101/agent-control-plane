<script setup lang="ts">
/*
 * 网关页：把已注册的 HARNESS Agent 纳管起来，作为渠道消息的最终落点。
 *
 * <h2>一、网关到底是什么（页面上必须写清楚，否则这一页看起来像"多余的一层"）</h2>
 * 它是「消息进来之后、没有任何绑定与渠道兜底命中时，交给谁」的那一个决策项，
 * 同时也是官方 GatewayBootstrap 的装配输入：纳管哪些 HARNESS agent、谁是主 agent。
 * 所以这一页只有两个动作 —— 看装配状态、改主 agent。
 *
 * <h2>二、为什么这里没有"草稿 / 发布 / 回滚"</h2>
 * 网关没有"线上形态"这个概念：改了主 agent 就等于要重新装配，中间不存在"已保存但未生效"的态。
 * 给它套上发布流程会造出"网关 v3 已发布"这种没人能解释的东西。
 * 渠道就不同 —— 改错一个 botId 会直接断掉线上入口，所以渠道才有发布与回滚。
 *
 * <h2>三、为什么候选只有 HARNESS agent</h2>
 * 官方 Gateway#registerAgent 只接受 HarnessAgent：网关要管理会话、子 agent 与工作区，
 * 那是 HARNESS 的能力。REACT agent 走的是另一条链（由回复渲染器直接调 AgentManager.stream），
 * 不参与网关。所以候选列表直接取后端返回的 candidates（= 运行时已注册的 HARNESS agent），
 * 前端不再自己过滤一遍 —— 两处过滤迟早会不一致。
 *
 * <h2>四、保存即生效，没有"先保存后发布"</h2>
 * 保存会带上一次重新装配（后端 applyAll）。分成两步只会让页面与线上差一拍，
 * 而"我明明改了怎么还是老行为"正是最难排查的一类问题。
 */
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { getGateway, listAgents, reloadGateway, saveGateway } from '@/api/controlplane';
import { notifyFailure, notifySuccess } from '@/features/controlplane/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { harnessLink } from '@/lib/links';
import { formatDateTime, formatRelative } from '@/lib/format';
import { agentDisplayName } from '@/lib/agentDisplay';
import PageHeader from '@/components/ui/PageHeader.vue';
import PaneCard from '@/components/ui/PaneCard.vue';
import KVList from '@/components/ui/KVList.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import type { KVItem } from '@/components/ui/types';

const queryClient = useQueryClient();

const { data: gateway, isLoading } = useQuery({
  queryKey: queryKeys.gateway,
  queryFn: getGateway,
});

const runtime = computed(() => gateway.value?.runtime ?? null);

/**
 * agent 列表，只用来把「标识」翻译成「展示名」。
 *
 * <p>为什么在页面里 join 而不是改后端契约：网关接口回的名字清单（candidates / agentIds）
 * 就是运行时装配的真实输入，本来就不该带展示字段 —— 让网关响应同时承载"运行时注册表"
 * 与"控制面展示口径"两个数据源，以后任何一侧变化都会牵扯另一侧。
 * queryKeys.agents 与 Agents 页共用，所以这次查询通常直接命中缓存。
 */
const { data: agentRows } = useQuery({
  queryKey: queryKeys.agents,
  queryFn: listAgents,
});

/** 标识 → 展示名（回落规则见 lib/agentDisplay.ts）。 */
const displayNameOf = computed(() => agentDisplayName(agentRows.value));

/** 表单里的主 agent；与库里的值分开存，用户没点保存就还没生效。 */
const mainAgentId = ref<string | null>(null);
const description = ref('');

/*
 * 用 watch 同步"库里的值 → 表单"，而不是直接 v-model 到 gateway.data：
 * 直接绑会让"改了下拉但没保存、后来又重新装配"的场景把用户的未保存选择悄悄改掉，
 * 而页面上看不出发生过什么。
 */
watch(
  gateway,
  (view) => {
    if (!view) return;
    mainAgentId.value = view.mainAgentId;
    description.value = view.description ?? '';
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    gateway.value !== undefined &&
    (mainAgentId.value !== gateway.value.mainAgentId ||
      description.value !== (gateway.value.description ?? '')),
);

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: queryKeys.gateway });
  // 网关变了会重建路由表与通道，渠道列表上的运行状态也跟着变，一并失效
  void queryClient.invalidateQueries({ queryKey: queryKeys.channels });
}

const saveMutation = useMutation({
  mutationFn: () => saveGateway(mainAgentId.value, description.value),
  onSuccess: (view) => {
    if (view.runtime.built) notifySuccess('已保存并重新装配', `主 Agent：${view.runtime.mainAgentId}`);
    // 未装配不是"保存失败"：库里的值是对的，只是运行时还不满足条件（比如主 agent 还没启起来）。
    // 这种情况必须显式告警，否则用户会以为保存没生效。
    else notifyFailure(new Error(view.runtime.note ?? '网关未装配'), '已保存，但网关未装配');
    invalidate();
  },
  onError: (err) => notifyFailure(err, '保存失败'),
});

const reloadMutation = useMutation({
  mutationFn: reloadGateway,
  onSuccess: (view) => {
    if (view.runtime.built) notifySuccess('已重新装配', `纳管 ${view.runtime.agentIds.length} 个 HARNESS Agent`);
    else notifyFailure(new Error(view.runtime.note ?? '网关未装配'), '网关未装配');
    invalidate();
  },
  onError: (err) => notifyFailure(err, '重新装配失败'),
});

const statusItems = computed<KVItem[]>(() => {
  const current = runtime.value;
  if (!current) return [];
  return [
    {
      label: '装配状态',
      value: current.built ? '已装配' : '未装配',
      badge: { text: current.built ? '已装配' : '未装配', variant: current.built ? 'ok' : 'off' } as const,
    },
    // 主 Agent 回的是标识，这里翻成展示名；转换不了（查不到）时 displayNameOf 会退回标识，
    // 所以此时仍然是有信息的一行，只是它长得像机器名。
    {
      label: '主 Agent',
      value: current.mainAgentId ? displayNameOf.value(current.mainAgentId) : '（未设置）',
      // 点它去那个 harness 的编排页。候选全是 HARNESS（见文件头第 3 条），所以目的地固定。
      to: current.mainAgentId ? harnessLink(current.mainAgentId) : undefined,
    },
    { label: '路由兜底', value: current.routerDefault ?? '（无）', mono: true },
    { label: '纳管数量', value: `${current.agentIds.length} 个`, mono: true },
    {
      label: '上次装配',
      value: current.loadedAtMs ? formatDateTime(current.loadedAtMs) : '从未装配',
    },
  ];
});
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button :loading="reloadMutation.isPending.value" @click="reloadMutation.mutate()">
        重新装配
      </el-button>
      <el-button
        type="primary"
        :disabled="!dirty"
        :loading="saveMutation.isPending.value"
        @click="saveMutation.mutate()"
      >
        保存并生效
      </el-button>
    </template>
  </PageHeader>

  <div v-if="isLoading" class="loading">加载中…</div>

  <template v-else>
    <div class="stack">
      <PaneCard title="装配状态" :right="runtime?.loadedAtMs ? `装配于 ${formatRelative(runtime.loadedAtMs)}` : '从未装配'">
        <AppNote v-if="runtime && !runtime.built" tone="warn" class="mb">
          {{ runtime.note }}
        </AppNote>
        <KVList :items="statusItems" label-width="112px" />
      </PaneCard>

      <PaneCard title="主 Agent">
        <el-form label-position="top">
          <el-form-item label="主 Agent">
            <el-select
              v-model="mainAgentId"
              filterable
              clearable
              placeholder="未设置：不装配网关"
              style="width: 100%; max-width: 420px"
            >
              <el-option
                v-for="name in gateway?.candidates ?? []"
                :key="name"
                :label="displayNameOf(name)"
                :value="name"
              >
                <!-- 展示名靠左、标识靠右：用的是全局的 .row / .spacer，
                     不在这一页新造一套 option 样式（.opt 只存在于 ChatPage 的 scoped 样式里） -->
                <span class="row">
                  <span>{{ displayNameOf(name) }}</span>
                  <span class="spacer" />
                  <span class="hint mono">{{ name }}</span>
                </span>
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="description" placeholder="备注" style="max-width: 620px" />
          </el-form-item>
        </el-form>
      </PaneCard>

      <PaneCard title="纳管的 Agent">
        <EmptyState
          v-if="(runtime?.agentIds.length ?? 0) === 0"
          title="还没有可纳管的 HARNESS Agent"
        />
        <div v-else class="row wrap">
          <!--
            徽标显示展示名，:title 保留标识（悬停可见）—— 这一行回答的是
            "网关纳管了哪些 agent"，不是"它们的注册键是什么"。
            每个徽标同时是链接：看网关时最常问的下一句是"这个 agent 配的是什么"。
          -->
          <router-link
            v-for="name in runtime?.agentIds ?? []"
            :key="name"
            class="badge-lk"
            :to="harnessLink(name)"
          >
            <AppBadge variant="harness" :title="name">{{ displayNameOf(name) }}</AppBadge>
          </router-link>
        </div>
      </PaneCard>
    </div>
  </template>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}
/*
 * 徽标外面那层链接。
 *
 * 必须是 inline-flex：a 默认是 inline，包住一个带 padding 与 line-height 的徽标时，
 * 基线对齐会让徽标相对整行下沉一两像素（row wrap 的 gap 也会失效，因为它量的是 a 的盒子）。
 */
.badge-lk {
  display: inline-flex;
  color: inherit;
}
.badge-lk:hover {
  opacity: 0.85;
}
</style>
