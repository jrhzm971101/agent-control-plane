/*
 * ChatMarkdown 的存在意义就是「text 没变就不重新解析」。
 *
 * 这条测试把那个前提钉住：父组件因为其它状态重渲染时，历史消息的
 * renderMarkdown 不该再被调用 —— 它是流式期间最容易失控的一笔计算。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';

const renderMarkdown = vi.hoisted(() => vi.fn((text: string) => `<p>${text}</p>`));

vi.mock('@/features/chat/markdown', () => ({ renderMarkdown }));

import ChatMarkdown from './ChatMarkdown.vue';

describe('ChatMarkdown 的解析缓存', () => {
  beforeEach(() => {
    renderMarkdown.mockClear();
  });

  it('父组件重渲染但 text 未变时不重新解析 Markdown', async () => {
    const text = ref('第一段 **回答**');
    const noise = ref(0);
    const Host = defineComponent({
      components: { ChatMarkdown },
      setup: () => ({ text, noise }),
      template: '<div><span>{{ noise }}</span><ChatMarkdown :text="text" /></div>',
    });

    const wrapper = mount(Host);
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.bub__md').html()).toContain('第一段');

    // 模拟 ChatPage 收到一帧后重渲染：text 没动，解析次数不该增加
    noise.value += 1;
    await nextTick();
    expect(renderMarkdown).toHaveBeenCalledTimes(1);

    // text 真的变了才重新解析
    text.value = '第二段回答';
    await nextTick();
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.bub__md').html()).toContain('第二段回答');
  });
});
