<script setup lang="ts">
/*
 * 环境页按四个职责组织：
 *
 *   环境 → 变量分组 → 分组实例 → 实例自己的固定键值
 *
 * 页面壳只负责取数、筛选和组合各管理入口；环境编辑、实例管理、分组管理
 * 各自维护自己的草稿与写操作，避免所有状态和弹窗堆在同一个组件里。
 */
import PageHeader from '@/components/ui/PageHeader.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FilterField from '@/components/ui/FilterField.vue';
import TableCard from '@/components/ui/TableCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppBadge from '@/components/ui/AppBadge.vue';
import AppNote from '@/components/ui/AppNote.vue';
import type { EnvInstanceRow } from '@/api/controlplane/types';
import { useEnvironmentCatalog } from '@/features/environments/useEnvironmentCatalog';
import { useEnvironmentFilters } from '@/features/environments/useEnvironmentFilters';
import { useEnvironmentEditor } from '@/features/environments/useEnvironmentEditor';
import { useInstanceManager } from '@/features/environments/useInstanceManager';
import { useGroupManager } from '@/features/environments/useGroupManager';

const catalog = useEnvironmentCatalog();
const {
  isLoading,
  error,
  groupsLoading,
  groupsError,
  instancesLoading,
  instancesError,
  envList,
  groupList,
  instanceCountOf,
} = catalog;

const {
  keywordFilter,
  completenessFilter,
  visible,
  isFiltered,
  resetFilters,
  completenessVariant,
} = useEnvironmentFilters(envList);

const editor = useEnvironmentEditor(catalog);
const {
  drawerOpen,
  creating,
  editingEnvCode,
  detailLoading,
  head,
  addGroupDialogOpen,
  addGroupCode,
  instancePickerOpen,
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
} = editor;

let closeGroupInInstanceManager = (_groupCode: string): void => {};

const groupManager = useGroupManager(catalog, {
  onGroupDeleted: (groupCode) => closeGroupInInstanceManager(groupCode),
});
const {
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
} = groupManager;

const instanceManager = useInstanceManager(catalog, {
  removeDraftInstance: editor.removeDraftInstance,
  openGroupEditor: groupManager.openEditGroup,
});
const {
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
  openInstanceManager,
  openCreateInstance,
  openEditInstance,
  submitInstance,
  confirmDeleteInstance,
  onInstanceGroupChange,
} = instanceManager;

closeGroupInInstanceManager = (groupCode) => {
  if (managerGroupCode.value === groupCode) instanceManagerOpen.value = false;
};
</script>

<template>
  <PageHeader>
    <template #actions>
      <el-button type="primary" @click="openCreate">+ 新增环境</el-button>
    </template>
  </PageHeader>

  <FilterBar :result="{ count: visible.length, total: envList.length, noun: '个环境' }">
    <FilterField label="关键字" width="250px">
      <el-input v-model="keywordFilter" placeholder="环境名 / 编码 / 说明" clearable />
    </FilterField>
    <FilterField label="配置情况" width="180px">
      <el-select v-model="completenessFilter">
        <el-option label="全部" value="all" />
        <el-option label="必填项已配齐" value="full" />
        <el-option label="有空着的必填项" value="partial" />
        <el-option label="一个值都没有" value="empty" />
      </el-select>
    </FilterField>
    <template #actions>
      <el-button v-if="isFiltered" text @click="resetFilters">清空筛选</el-button>
    </template>
  </FilterBar>

  <TableCard :loading="isLoading">
    <EmptyState
      v-if="error"
      title="读不到环境清单"
      :hint="(error as Error).message"
    />
    <EmptyState
      v-else-if="visible.length === 0"
      :title="envList.length === 0 ? '还没有环境' : '没有匹配的环境'"
    />
    <el-table v-else :data="visible" row-key="envCode">
      <el-table-column label="环境" min-width="230">
        <template #default="{ row }">
          <div class="row wrap">
            <span class="strong">{{ row.displayName }}</span>
            <AppBadge v-if="!row.enabled" variant="off">已停用</AppBadge>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="配置概览" min-width="220">
        <template #default="{ row }">
          <div class="summary">
            <AppBadge
              :variant="completenessVariant(row)"
              title="已填必填项 / 当前环境已绑定实例的必填项总数"
            >
              {{ row.requiredKeys > 0 ? `${row.readyKeys} / ${row.requiredKeys}` : '无必填项' }}
            </AppBadge>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="primary" @click="openCopy(row)">复制</el-button>
          <el-button link type="danger" @click="confirmDelete(row)">删除</el-button>
        </template>
      </el-table-column>

      <template #empty>
        <EmptyState title="没有环境" />
      </template>
    </el-table>

  </TableCard>

  <TableCard
    id="env-groups"
    class="grp-card"
    title="分组管理"
    :count="groupList.length"
    :loading="groupsLoading || instancesLoading"
  >
    <template #actions>
      <el-button @click="openCreateGroup">+ 新增分组</el-button>
    </template>

    <AppNote v-if="groupsError" tone="warn" class="mb">
      分组读取失败：{{ (groupsError as Error).message }}。环境清单仍可查看，但无法新增或编辑变量。
    </AppNote>
    <EmptyState
      v-else-if="groupList.length === 0"
      title="还没有变量分组"
    >
      <template #action>
        <el-button type="primary" @click="openCreateGroup">+ 新增分组</el-button>
      </template>
    </EmptyState>
    <el-table v-else :data="groupList" row-key="groupCode">
      <el-table-column label="分组" min-width="240">
        <template #default="{ row }">
          <div class="row wrap">
            <span class="strong">{{ row.displayName }}</span>
            <AppBadge v-if="row.builtin" variant="ro">内置</AppBadge>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="分组编码" min-width="200">
        <template #default="{ row }"><span class="mono muted">{{ row.groupCode }}</span></template>
      </el-table-column>

      <el-table-column label="实例" width="150">
        <template #default="{ row }">
          <span>{{ instanceCountOf(row.groupCode) }} 个</span>
        </template>
      </el-table-column>

      <el-table-column label="组内键" width="110">
        <template #default="{ row }">{{ row.keys.length }} 个</template>
      </el-table-column>

      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openInstanceManager(row.groupCode)">管理</el-button>
        </template>
      </el-table-column>
    </el-table>
  </TableCard>

  <el-drawer
    v-model="instanceManagerOpen"
    size="720px"
    :with-header="false"
    :close-on-click-modal="false"
  >
    <div class="dw">
      <header class="dw__hd">
        <div class="dw__ttl">
          <h2>实例管理</h2>
          <code class="env-code">{{ managerGroupCode }}</code>
          <AppBadge v-if="managerGroup?.builtin" variant="ro">内置</AppBadge>
        </div>
        <div class="dw__act">
          <el-button v-if="managerGroup" @click="openEditGroup(managerGroup)">编辑分组</el-button>
          <el-button @click="instanceManagerOpen = false">关闭</el-button>
        </div>
      </header>

      <div class="dw__bd">
        <div class="im__hd">
          <div class="im__meta">
            <span class="im__name">{{ managerGroup?.displayName ?? managerGroupCode }}</span>
            <span class="muted">{{ managerInstances.length }} 个实例</span>
          </div>
          <el-button
            type="primary"
            plain
            :disabled="!managerGroup"
            @click="openCreateInstance(managerGroupCode)"
          >
            + 新增实例
          </el-button>
        </div>

        <AppNote v-if="instancesError" tone="warn" class="mt">
          实例读取失败：{{ (instancesError as Error).message }}
        </AppNote>
        <div v-else-if="instancesLoading" class="loading">加载中…</div>
        <EmptyState
          v-else-if="managerInstances.length === 0"
          title="还没有实例"
        >
          <template #action>
            <el-button type="primary" @click="openCreateInstance(managerGroupCode)">
              + 新增实例
            </el-button>
          </template>
        </EmptyState>
        <el-table
          v-else
          :data="managerInstances"
          :row-key="(row: EnvInstanceRow) => `${row.groupCode}/${row.instanceCode}`"
        >
          <el-table-column label="实例" min-width="240">
            <template #default="{ row }">
              <div class="im__instance">
                <span class="strong">{{ row.displayName || row.instanceCode }}</span>
                <code class="mono muted">{{ row.instanceCode }}</code>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <AppBadge :variant="row.enabled ? 'ok' : 'off'">
                {{ row.enabled ? '启用' : '停用' }}
              </AppBadge>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEditInstance(row)">编辑</el-button>
              <el-button link type="danger" @click="confirmDeleteInstance(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </el-drawer>

  <el-drawer
    v-model="drawerOpen"
    size="980px"
    :with-header="false"
    :close-on-click-modal="false"
  >
    <div class="dw">
      <header class="dw__hd">
        <div class="dw__ttl">
          <h2>{{ creating ? '新增环境' : '编辑环境' }}</h2>
          <code v-if="!creating" class="env-code">{{ editingEnvCode }}</code>
          <AppBadge v-if="creating" variant="react">新建</AppBadge>
          <AppBadge v-else-if="!head.enabled" variant="off">已停用</AppBadge>
        </div>
        <div class="dw__act">
          <el-button @click="drawerOpen = false">取消</el-button>
          <el-button
            type="primary"
            :loading="saveEnvMutation.isPending.value"
            :disabled="!canSave"
            @click="submit"
          >
            保存
          </el-button>
        </div>
      </header>

      <div v-if="detailLoading" class="loading">加载中…</div>
      <div v-else class="dw__bd">
        <el-form label-position="top" class="form-grid">
          <el-form-item label="环境编码">
            <el-input v-model="head.envCode" :disabled="!creating" placeholder="如 ghana-uat" />
            <div v-if="envCodeIssue" class="hint hint--bad">{{ envCodeIssue }}</div>
          </el-form-item>
          <el-form-item label="展示名">
            <el-input v-model="head.displayName" placeholder="如 加纳 UAT" />
          </el-form-item>
          <el-form-item label="说明" class="form-grid__wide">
            <el-input
              v-model="head.description"
              type="textarea"
              :rows="2"
              placeholder="请输入说明"
            />
          </el-form-item>
          <el-form-item label="启用" class="form-grid__wide">
            <div class="row wrap">
            <el-switch v-model="head.enabled" />
            </div>
          </el-form-item>
        </el-form>

        <section class="vars">
          <header class="vars__hd">
            <h3 class="vars__ttl">分组与实例</h3>
            <el-button
              class="vars__add-group"
              type="primary"
              plain
              size="small"
              :disabled="addableGroups.length === 0"
              :title="addableGroups.length === 0 ? '所有分组都已添加' : ''"
              @click="openAddGroupDialog"
            >
              + 添加分组
            </el-button>
          </header>

          <div v-if="entryGroups.length === 0" class="vars__empty">
            <span class="vars__empty-title">
              {{ groupList.length === 0 ? '还没有变量分组' : '还没有选择分组' }}
            </span>
            <span class="muted">
              {{ groupList.length === 0 ? '请先到分组管理中新增分组。' : '从右上角「添加分组」开始，环境只做绑定选择。' }}
            </span>
          </div>

          <section v-for="group in entryGroups" :key="group.groupCode" class="vg">
            <header class="vg__hd">
              <div class="vg__meta">
                <h4 class="vg__ttl">{{ group.displayName }}</h4>
                <code class="vg__code">{{ group.groupCode }}</code>
              </div>
              <div class="vg__actions">
                <span class="vg__count">{{ group.boundCodes.length }} 个实例</span>
                <el-button size="small" @click="openInstancePicker(group.groupCode)">
                  实例
                </el-button>
                <el-button link type="danger" @click="removeGroupFromDraft(group.groupCode)">
                  移除分组
                </el-button>
              </div>
            </header>
          </section>
        </section>
      </div>
    </div>
  </el-drawer>

  <el-dialog
    v-model="addGroupDialogOpen"
    title="添加分组"
    width="440px"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" class="add-form">
      <el-form-item label="变量分组">
        <el-select v-model="addGroupCode" filterable placeholder="请选择分组">
          <el-option
            v-for="group in addableGroups"
            :key="group.groupCode"
            :label="`${group.displayName}（${group.groupCode}）`"
            :value="group.groupCode"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="addGroupDialogOpen = false">取消</el-button>
      <el-button type="primary" :disabled="!addGroupCode" @click="confirmAddGroup">
        添加
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="instancePickerOpen"
    :title="`选择实例${instancePickerGroup ? ` · ${instancePickerGroup.displayName}` : ''}`"
    width="520px"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" class="add-form">
      <el-form-item label="实例">
        <el-select
          v-model="instancePickerCodes"
          multiple
          filterable
          :disabled="!instancePickerGroup || instancePickerGroup.options.length === 0"
          :placeholder="instancePickerGroup?.options.length === 0 ? '该分组暂无实例' : '请选择实例'"
        >
          <el-option
            v-for="item in instancePickerGroup?.options ?? []"
            :key="item.instanceCode"
            :label="`${item.displayName || item.instanceCode}（${item.instanceCode}）`"
            :value="item.instanceCode"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="instancePickerOpen = false">取消</el-button>
      <el-button type="primary" @click="confirmInstancePicker">确定</el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="instanceDialogOpen"
    :title="editingInstance ? '编辑实例' : '新增实例'"
    width="760px"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" class="add-form">
      <el-form-item label="分组">
        <el-select
          v-model="instanceForm.groupCode"
          filterable
          :disabled="instanceGroupLocked"
          @change="onInstanceGroupChange"
        >
          <el-option
            v-for="group in groupList"
            :key="group.groupCode"
            :label="`${group.displayName}（${group.groupCode}）`"
            :value="group.groupCode"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="实例编码（instanceCode）">
        <el-input
          v-model="instanceForm.instanceCode"
          :disabled="!!editingInstance"
          placeholder="如 report / backup"
        />
        <div class="hint">
          后端和工具按这个编码取值，创建后不可修改；实例配置由所有绑定它的环境共用。
        </div>
      </el-form-item>

      <el-form-item label="展示名">
        <el-input v-model="instanceForm.displayName" placeholder="如 报表库 NineData" />
      </el-form-item>

      <el-form-item label="启用">
        <el-switch v-model="instanceForm.enabled" />
      </el-form-item>

      <div v-if="instanceFormIssue" class="hint hint--bad">{{ instanceFormIssue }}</div>
    </el-form>

    <section class="ic">
      <header class="ic__hd">
        <h3 class="ic__ttl">配置值</h3>
        <span class="ic__note">实例固定配置，绑定该实例的环境共用</span>
      </header>

      <div v-if="instanceConfigLoading" class="ic__state">加载中…</div>
      <div v-else-if="instanceConfigError" class="hint hint--bad">{{ instanceConfigError }}</div>
      <div v-else-if="instanceConfigKeys.length === 0" class="ic__empty">
        该分组还没有定义组内键。
      </div>
      <div v-else class="ic__list">
        <div
          v-for="key in instanceConfigKeys"
          :key="key.keyCode"
          class="ic__row"
          :class="{ 'ic__row--bad': instanceConfigIssues.get(key.keyCode) }"
        >
          <div class="ic__meta">
            <span class="ic__label">{{ key.label }}</span>
            <code class="ic__code">{{ key.keyCode }}</code>
            <span v-if="key.required" class="tag tag--req">必填</span>
            <span v-if="key.secret" class="tag tag--sec">凭据</span>
            <span v-if="key.reserved" class="tag tag--lock" title="被工具代码引用">工具引用</span>
          </div>
          <div class="ic__input">
            <el-select
              v-if="key.valueType === 'BOOL'"
              v-model="instanceConfigValues[key.keyCode]"
              placeholder="选择 true / false"
            >
              <el-option label="true" value="true" />
              <el-option label="false" value="false" />
            </el-select>
            <el-input
              v-else
              v-model="instanceConfigValues[key.keyCode]"
              :type="key.secret ? 'password' : 'text'"
              :show-password="key.secret"
              :placeholder="key.placeholder ?? (key.secret ? '填写凭据' : '填写值')"
            />
            <div v-if="instanceConfigIssues.get(key.keyCode)" class="hint hint--bad">
              {{ instanceConfigIssues.get(key.keyCode) }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <template #footer>
      <el-button @click="instanceDialogOpen = false">取消</el-button>
      <el-button type="primary" :disabled="!canSaveInstance" @click="submitInstance">
        保存
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="groupDialogOpen"
    :title="editingGroupCode ? '编辑变量分组' : '新增变量分组'"
    width="980px"
    :close-on-click-modal="false"
  >
    <div class="gd">
      <el-form label-position="top">
        <div class="gd__grid">
          <el-form-item label="分组标识（groupCode）">
            <el-input
              v-model="groupForm.groupCode"
              :disabled="editingGroupCode !== null"
              placeholder="如 k8s / biz"
            />
            <div v-if="groupCodeIssue" class="hint hint--bad">{{ groupCodeIssue }}</div>
          </el-form-item>
          <el-form-item label="分组展示名">
            <el-input v-model="groupForm.displayName" placeholder="如 Kubernetes" />
          </el-form-item>
          <el-form-item label="图标（可选）">
            <el-input v-model="groupForm.icon" placeholder="图标名或 emoji" />
          </el-form-item>
        </div>
        <el-form-item label="说明">
          <el-input
            v-model="groupForm.description"
            type="textarea"
            :rows="2"
            placeholder="请输入说明"
          />
        </el-form-item>
      </el-form>

      <section class="keys">
        <header class="keys__hd">
          <h3 class="keys__ttl">组内键</h3>
          <AppBadge variant="react">{{ groupForm.keys.length }}</AppBadge>
          <el-button class="keys__add" @click="addGroupKey">+ 新增键</el-button>
        </header>

        <div class="kg">
          <div class="kg__hd">
            <span>键名（keyCode）</span>
            <span>展示名</span>
            <span>类型</span>
            <span>必填</span>
            <span>凭据</span>
            <span>操作</span>
          </div>
          <div
            v-for="(key, index) in groupForm.keys"
            :key="key.uid"
            class="kg__row"
          >
            <el-input
              v-model="key.keyCode"
              :disabled="key.reserved"
              placeholder="如 serverAddr"
            />
            <el-input v-model="key.label" placeholder="如 集群地址" />
            <el-select v-model="key.valueType">
              <el-option label="字符串" value="STRING" />
              <el-option label="整数" value="INT" />
              <el-option label="布尔" value="BOOL" />
            </el-select>
            <el-switch v-model="key.required" />
            <el-switch v-model="key.secret" />
            <el-button
              link
              type="danger"
              :disabled="key.reserved"
              :title="key.reserved ? '被工具代码引用，不能移除' : '移除这个键'"
              @click="removeGroupKey(key.uid)"
            >
              移除
            </el-button>
            <div v-if="groupKeyIssues.get(index)" class="kg__issue">
              {{ groupKeyIssues.get(index) }}
            </div>
            <div v-else-if="key.reserved" class="kg__issue kg__issue--lock">
              被工具代码引用：键名锁定，不能移除
            </div>
          </div>
          <div v-if="groupForm.keys.length === 0" class="kg__empty">
            <span>还没有键</span>
          </div>
        </div>

        <AppNote v-if="groupProblems.length > 0" tone="warn" class="mt">
          {{ groupProblems.slice(0, 3).join('；') }}{{ groupProblems.length > 3 ? ` 等 ${groupProblems.length} 项` : '' }}
        </AppNote>
      </section>
    </div>

    <template #footer>
      <el-button
        v-if="editingGroupCode"
        type="danger"
        plain
        class="gd__danger"
        :disabled="groupForm.builtin"
        :title="groupForm.builtin ? '内置分组被工具代码引用，不能删除' : '删除分组'"
        @click="confirmDeleteEditingGroup"
      >
        删除分组
      </el-button>
      <el-button @click="groupDialogOpen = false">取消</el-button>
      <el-button
        type="primary"
        :loading="saveGroupMutation.isPending.value"
        :disabled="!canSaveGroup"
        @click="submitGroup"
      >
        保存分组
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ---------- 环境清单 ---------- */

.env-code {
  display: inline-block;
  margin-top: 2px;
  color: var(--t3);
  font-family: var(--mono);
  font-size: 12px;
}

.summary {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
}
/* ---------- 变量分组 ---------- */

.grp-card {
  margin-top: var(--s6);
}

/* ---------- 分组实例管理 ---------- */

.im__hd {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--bd-soft);
}
.im__meta {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  min-width: 0;
  margin-right: auto;
}
.im__name {
  color: var(--t1);
  font-size: 15px;
  font-weight: 600;
}
.im__instance {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  min-width: 0;
}

/* ---------- 抽屉骨架 ---------- */

.dw {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.dw__hd {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex: 0 0 auto;
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--bd);
}
.dw__ttl {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
  margin-right: auto;
}
.dw__ttl h2 {
  margin: 0;
}
.dw__act {
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex: 0 0 auto;
}
.dw__bd {
  flex: 1;
  min-height: 0;
  padding-top: var(--s4);
  padding-bottom: var(--s6);
  overflow: auto;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--s4);
}
.form-grid__wide {
  grid-column: 1 / -1;
}
.form-grid :deep(.el-form-item) {
  margin-bottom: 14px;
}

/* ---------- 变量值 ---------- */

.vars {
  margin-top: var(--s2);
  padding-top: var(--s4);
  border-top: 1px solid var(--bd);
}
.vars__hd {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex-wrap: wrap;
}
.vars__ttl {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  color: var(--t1);
}
.vars__count {
  color: var(--t3);
  font-size: 12px;
}
.vars__add-group {
  margin-left: auto;
}

.vars__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: var(--s4);
  padding: var(--s6) var(--s4);
  border: 1px dashed var(--bd-strong);
  border-radius: var(--r-md);
}
.vars__empty-title {
  color: var(--t2);
  font-size: 13.5px;
  font-weight: 550;
}

.add-form :deep(.el-select) {
  width: 100%;
}
.add-form :deep(.el-form-item) {
  margin-bottom: 16px;
}
.add-form .hint {
  margin-top: 6px;
}

.vg {
  margin-top: var(--s4);
  padding: var(--s3) var(--s4);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  background: var(--panel);
}
.vg__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s4);
  padding-bottom: var(--s2);
  border-bottom: 1px solid var(--bd-soft);
}
.vg__meta {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  min-width: 0;
}
.vg__ttl {
  margin: 0;
  color: var(--t1);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
}
.vg__code {
  color: var(--t3);
  font-family: var(--mono);
  font-size: 11.5px;
}
.vg__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--s2);
  margin-left: auto;
}
.vg__count {
  color: var(--t3);
  font-size: 12px;
  white-space: nowrap;
}

/* ---------- 实例弹窗里的配置值 ---------- */

.ic {
  margin-top: var(--s2);
  padding-top: var(--s4);
  border-top: 1px solid var(--bd);
}
.ic__hd {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.ic__ttl {
  margin: 0;
  color: var(--t1);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
}
.ic__note {
  margin-left: auto;
  color: var(--t3);
  font-size: 12.5px;
}
.ic__empty,
.ic__state {
  padding: var(--s4) 0 var(--s2);
  color: var(--t3);
  font-size: 12.5px;
  text-align: center;
}
.ic__list {
  max-height: 42vh;
  margin-top: var(--s3);
  overflow: auto;
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
}
.ic__row {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.4fr);
  gap: var(--s3);
  align-items: start;
  padding: var(--s3) var(--s4);
  border-bottom: 1px solid var(--bd-soft);
}
.ic__row:last-child {
  border-bottom: none;
}
.ic__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-top: 6px;
}
.ic__label {
  color: var(--t1);
  font-size: 13px;
  font-weight: 550;
}
.ic__code {
  color: var(--t3);
  font-family: var(--mono);
  font-size: 11.5px;
}
.ic__input {
  min-width: 0;
}
.ic__input :deep(.el-select) {
  width: 100%;
}
.ic__row--bad :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--red-line) inset;
}

.tag {
  padding: 0 5px;
  border-radius: var(--r-xs);
  font-size: 10.5px;
  line-height: 16px;
}
.tag--req {
  background: var(--amb-bg);
  color: var(--amb);
}
.tag--sec {
  background: var(--red-bg);
  color: var(--red);
}
.tag--lock {
  background: var(--panel-tint);
  color: var(--t3);
}

.hint--bad {
  color: var(--red);
}

/* ---------- 分组编辑对话框 ---------- */

.gd__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 var(--s4);
}
.gd__grid :deep(.el-form-item) {
  margin-bottom: 14px;
}
.gd__danger {
  margin-right: auto;
}
.keys {
  margin-top: var(--s2);
  padding-top: var(--s4);
  border-top: 1px solid var(--bd);
}
.keys__hd {
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.keys__ttl {
  margin: 0;
  color: var(--t1);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
}
.keys__add {
  margin-left: auto;
}

.kg {
  margin-top: var(--s3);
  border: 1px solid var(--bd);
  border-radius: var(--r-md);
  overflow: hidden;
}
.kg__hd,
.kg__row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.1fr) 104px 58px 58px 56px;
  gap: var(--s2);
  align-items: center;
  padding: 8px var(--s3);
}
.kg__hd {
  border-bottom: 1px solid var(--bd);
  background: var(--panel-soft);
  color: var(--t3);
  font-size: 12px;
}
.kg__row {
  border-bottom: 1px solid var(--bd-soft);
}
.kg__row :deep(.el-select) {
  width: 100%;
}
.kg__row:last-child {
  border-bottom: none;
}
.kg__issue {
  grid-column: 1 / -1;
  color: var(--red);
  font-size: 12px;
  line-height: 1.5;
  padding-bottom: 2px;
}
.kg__issue--lock {
  color: var(--t3);
}
.kg__empty {
  padding: var(--s4);
  text-align: center;
}
</style>
