<script setup lang="ts">
/*
 * 命令面板（⌘K / Ctrl+K）。
 *
 * 对齐官方 app/CommandPalette.tsx 的定位：只做「快速跳转」，
 * 不承担搜索业务数据的职责。数据源是导航项 + agent 列表 + 工具列表。
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { navGroups } from './nav';
import { listAgents, listToolCatalog } from '@/api/controlplane';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const router = useRouter();
const keyword = ref('');
const agents = ref<Array<{ id: string; displayName: string; description: string }>>([]);
const tools = ref<Array<{ name: string; label: string }>>([]);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      keyword.value = '';
      return;
    }
    if (agents.value.length > 0) return;
    /*
     * 数据源改成控制面接口而不是 mock：面板里的 agent 名必须与库里一致，
     * 否则点进去 404。后端不可用时不抛错，只是面板里少两组候选 ——
     * 为了一个「快速跳转」把整页的错误提示弹出来并不值得。
     */
    try {
      agents.value = (await listAgents()).map((row) => ({
        id: row.agentName,
        // 展示名兜底成 id：面板是"随手搜一下就跳过去"的入口，
        // 条目没有名字比条目名字是机器名更让人怀疑面板坏了。
        displayName: row.displayName || row.agentName,
        description: row.description ?? '',
      }));
    } catch {
      agents.value = [];
    }
    try {
      tools.value = (await listToolCatalog()).map((tool) => ({
        name: tool.name,
        label: tool.beanName,
      }));
    } catch {
      tools.value = [];
    }
  },
);

interface Command {
  label: string;
  group: string;
  hint: string;
  run: () => void;
}

const commands = computed<Command[]>(() => {
  const nav: Command[] = navGroups.flatMap((group) =>
    group.items.map((item) => ({
      label: item.label,
      group: '导航',
      hint: item.path,
      run: () => router.push(item.path),
    })),
  );
  const agentCommands: Command[] = agents.value.map((agent) => ({
    // label 是展示名（人读的），hint 是 id（跳转与引用时真正要用的那个）
    label: agent.displayName,
    group: 'Agent',
    hint: agent.id,
    run: () => router.push(`/agents/${agent.id}`),
  }));
  const toolCommands: Command[] = tools.value.map((tool) => ({
    label: tool.name,
    group: '工具',
    hint: tool.label,
    run: () => router.push('/tools'),
  }));
  return [...nav, ...agentCommands, ...toolCommands];
});

const results = computed(() => {
  const keywordLower = keyword.value.trim().toLowerCase();
  const list = commands.value;
  if (!keywordLower) return list.slice(0, 12);
  return list
    // hint 也进检索：agent-id、工具 bean 名、页面路径都只出现在 hint 里，
    // 不带上它们就等于"只能按展示名搜" —— 而人往往是从日志/配置里抄了一个机器名过来找。
    .filter((command) =>
      `${command.label} ${command.group} ${command.hint}`.toLowerCase().includes(keywordLower),
    )
    .slice(0, 20);
});

function close() {
  emit('update:modelValue', false);
}

function runCommand(command: Command) {
  command.run();
  close();
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="560px"
    top="12vh"
    :show-close="false"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <el-input
        v-model="keyword"
        placeholder="搜索 agent / 工具 / 页面…"
        size="large"
        autofocus
        clearable
      />
    </template>
    <div class="results">
      <button
        v-for="command in results"
        :key="`${command.group}:${command.label}`"
        class="item"
        type="button"
        @click="runCommand(command)"
      >
        <span class="grp">{{ command.group }}</span>
        <span class="lb">{{ command.label }}</span>
        <span class="ht">{{ command.hint }}</span>
      </button>
      <div v-if="results.length === 0" class="empty">没有匹配项</div>
    </div>
  </el-dialog>
</template>

<style scoped>
.results {
  max-height: 52vh;
  overflow-y: auto;
  margin: -8px 0;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: none;
  background: transparent;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  font-size: 14px;
}
.item:hover {
  background: var(--pri-bg);
}
.grp {
  flex: 0 0 56px;
  font-size: 12px;
  color: var(--t3);
}
.lb {
  font-weight: 550;
  color: var(--t1);
}
.ht {
  margin-left: auto;
  font-size: 12.5px;
  color: var(--t3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.empty {
  padding: 28px;
  text-align: center;
  color: var(--t3);
  font-size: 13.5px;
}
</style>
