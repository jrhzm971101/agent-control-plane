/*
 * 侧边导航的分组断言。
 *
 * 为什么要单独钉住：分组由 AppShell 拿 group.title 当 v-for 的 key 渲染，
 * 有两处出错它是<b>不会报</b>的：
 *
 *   1. 两组重名 —— Vue 只在控制台警告 duplicate key，页面看着完全正常；
 *   2. 条目漏掉或放错组 —— 页面照样渲染，只是那个入口悄悄挪了位置，没有任何测试会红。
 *
 * 所以这里断言的是「分组 → 成员」这张表本身，而不是"导航能渲染出来"。
 * 以后调整分组就要改这份断言 —— 那正是这种改动应该付出的代价。
 */
import { describe, expect, it } from 'vitest';

import { allNavItems, navGroups, titleForPath } from '@/app/nav';

describe('侧边导航分组', () => {
  /*
   * 分组的显示顺序 = 这份数组的顺序，所以整条都断言，不只是"有哪些组"。
   *
   * 顺序不是排版偏好：「运行状态」必须在最前、且组内第一条是「对话」——
   * 那是日常打开次数最多的入口，被挤到后面去的话每次都要先越过几个分组标题。
   * 顺便，整条一起断言也就顺带钉住了「标题唯一」（AppShell 拿 title 当 v-for 的 key，
   * 重名时 Vue 只在控制台警告，页面看着完全正常）。
   */
  it('分组顺序：运行状态排最前，标题不重复', () => {
    expect(navGroups.map((group) => group.title)).toEqual([
      '',
      '运行状态',
      '编排定义',
      '能力资源',
      '接入',
      '运行产物',
      '业务',
    ]);
    expect(navGroups[1].items[0].key).toBe('chat');
  });

  /*
   * 按「一次 agent 的生命周期位置」分的四组：先声明它是什么、它跑成什么样、
   * 它落下了什么、接入方自己提供的业务数据。
   * 其余三组（概览 / 能力资源 / 接入）是配套的定位组，不在本次断言的范围内。
   */
  it('按生命周期分组：编排定义 / 运行状态 / 运行产物 / 业务', () => {
    const itemsOf = (title: string) =>
      navGroups.find((group) => group.title === title)?.items.map((item) => item.key) ?? [];

    expect(itemsOf('编排定义')).toEqual(['models', 'agents', 'harness', 'workflows']);
    expect(itemsOf('运行状态')).toEqual(['chat', 'traces', 'sessions']);
    expect(itemsOf('运行产物')).toEqual(['workspace', 'storage']);
    expect(itemsOf('业务')).toEqual(['environments']);
  });

  /* key 唯一 + 没有空分组：漏掉一条的表现是"某个页面进不去"，界面上看不出来。 */
  it('条目 key 不重复，且没有空分组', () => {
    const keys = allNavItems.map((item) => item.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(navGroups.every((group) => group.items.length > 0)).toBe(true);
  });

  /* 顶栏标题取自这张表：路径与表里不一致的表现是顶栏显示"控制台"，而不是报错。 */
  it('每个导航条目的路径都能反查到自己的标题', () => {
    for (const item of allNavItems) {
      expect(titleForPath(item.path), item.path).toBe(item.label);
    }
  });
});