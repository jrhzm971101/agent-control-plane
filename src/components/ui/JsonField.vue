<script setup lang="ts">
/*
 * JSON 列编辑器（runtime 的 generate-options / permission 等五个结构化配置）。
 *
 * 为什么给这几列一个文本框而不是拆成一个个子字段：它们对应框架侧的配置对象，
 * 字段少、没有按子字段查询的需求，拆成子表只会把装配期变成多次 join 换不来任何查询能力
 * （后端也据此选了 JSON 列）。页面上跟着保持"原样编辑"就不会有一层自己的字段映射。
 *
 * 两个刻意的行为：
 * 1. 解析失败时不把值往外抛，而是就地报错并把 valid=false 交给父级。
 *    这样"正在输入"的半个 JSON 不会把父级的草稿写成 null（那等于清空配置）。
 * 2. 只接受对象，不接受数组或标量 —— 这几列在库里都是对象，接受别的形状
 *    只会在装配期炸，且错误信息离这里很远。
 */
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: Record<string, unknown> | null;
    rows?: number;
    placeholder?: string;
  }>(),
  { rows: 4, placeholder: '{}' },
);

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown> | null];
  'update:valid': [value: boolean];
}>();

const text = ref('');
const error = ref('');

type Parsed =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: string };

function parse(raw: string): Parsed {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value === null) return { ok: true, value: null };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: '必须是一个 JSON 对象，例如 {"temperature": 0.2}' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function format(value: Record<string, unknown> | null): string {
  return value === null || value === undefined ? '' : JSON.stringify(value, null, 2);
}

/*
 * 外部值变化时才重置文本。
 *
 * 判断依据是"文本解析出来的东西是否等于新值"，而不是"新值是否变了" ——
 * 后者会在用户打字打到一半时（父级因为别的原因重发了同一个值）把光标位置冲掉。
 */
watch(
  () => props.modelValue,
  (value) => {
    const current = parse(text.value);
    const same = current.ok && JSON.stringify(current.value) === JSON.stringify(value ?? null);
    if (!same) {
      text.value = format(value);
      error.value = '';
    }
  },
  { immediate: true },
);

function onInput(value: string) {
  text.value = value;
  const parsed = parse(value);
  if (parsed.ok) {
    error.value = '';
    emit('update:modelValue', parsed.value);
    emit('update:valid', true);
    return;
  }
  error.value = parsed.error;
  emit('update:valid', false);
}
</script>

<template>
  <div class="jf">
    <el-input
      :model-value="text"
      type="textarea"
      :rows="rows"
      resize="vertical"
      :placeholder="placeholder"
      class="jf__input"
      @update:model-value="onInput"
    />
    <p v-if="error" class="jf__err">{{ error }}</p>
  </div>
</template>

<style scoped>
.jf__input :deep(textarea) {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
}
.jf__err {
  margin: 5px 0 0;
  color: var(--red);
  font-size: 12.5px;
  line-height: 1.6;
}
</style>
