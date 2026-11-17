/*
 * 「可编辑副本」的深拷贝。
 *
 * <h2>为什么不能直接 structuredClone</h2>
 * 结构化克隆算法遇到 Proxy 会直接抛 DataCloneError，Chrome/Node 的文案都是
 * `#<Object> could not be cloned.`。而 vue-query 把**每一次查询结果**都装进了
 * reactive()（见 @tanstack/vue-query 的 useBaseQuery.js：
 * `reactive(observer.getCurrentResult())`，再由 toRefs 暴露 data），
 * 所以从 `data` 里读出来的每个对象都是 Proxy —— 直接克隆必然炸。
 *
 * <h2>为什么 toRaw 就够了，不需要递归去代理</h2>
 * Vue 的深层代理是「读属性时才创建」的：reactive(jsonObj) 只会包住最外层，
 * 内部的 agent / ref / runtime 等子对象仍是 JSON.parse 出来时的原始对象，
 * 因此脱掉最外层那一层代理后，整棵树对结构化克隆就是干净的了。
 *
 * <h2>为什么必须先脱代理，而不是克隆完再处理</h2>
 * 草稿必须与 query cache **完全脱钩**。若把响应式对象直接交给表单，改表单就等于
 * 改缓存，别的页面读同一份缓存时会看到「还没保存的改动」，而 user 点了取消也回不去。
 *
 * <h2>为什么不用 JSON 往返</h2>
 * JSON.stringify 会吃掉值为 undefined 的属性、把 Date 变成字符串。本项目的三态
 * 开关靠「键存在但为 null」与「键缺失」都不足以区分语义，得靠 null / true / false
 * 三值精确表达，所以格式不能被动过。
 */
import { toRaw } from 'vue';

/**
 * 复制一份与响应式系统脱钩的普通对象，用于「编辑副本」。
 *
 * @param value 通常来自 vue-query 的 data（可能是 reactive 代理），也可以是普通对象
 */
export function editableCopy<T>(value: T): T {
  return structuredClone(toRaw(value));
}
