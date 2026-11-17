/*
 * 平台目录的单测。
 *
 * <p>它守的不是"这段代码能不能跑"，而是一件**跨仓库的约定**：这份目录必须与
 * 统一门户（md-portal-homepage/src/lib/platforms.ts）里的那份逐条一致 ——
 * 同样的 code、同样的名字、同样的地址兜底。两边同时写死是可以接受的
 * （iam 还没有 GET /api/platforms），两边写的不一样不行：
 * 那会让"从门户点进 Agent 平台、再切到数据平台"这条路径出现两个地址，
 * 而地址不一致只会在切换的那一刻暴露。
 *
 * <p>所以这里有两条断言是刻意写死的字面值（code 与 name），
 * 门户那边一改，这里就该红。
 */
import { describe, expect, it } from 'vitest';
import { otherPlatforms, PLATFORMS, portalIsSelf, PORTAL_URL } from './platforms';

describe('子平台目录', () => {
  it('三个平台与门户逐条对齐：code / 名字 / 顺序', () => {
    expect(PLATFORMS.map((item) => item.code)).toEqual(['data', 'agent', 'admin']);
    expect(PLATFORMS.map((item) => item.name)).toEqual([
      '数据平台',
      'Agent 智能平台',
      '行政管理平台',
    ]);
  });

  it('当前平台只有一个，且就是本平台', () => {
    const current = PLATFORMS.filter((item) => item.current);
    expect(current.map((item) => item.code)).toEqual(['agent']);
  });

  it('切换列表里不含当前平台', () => {
    const others = otherPlatforms();
    expect(others.map((item) => item.code)).toEqual(['data', 'admin']);
    expect(others.every((item) => !item.current)).toBe(true);
  });

  it('地址是带尾斜杠的路径（相对路径才扛得住换域名）', () => {
    for (const item of PLATFORMS) {
      expect(item.path.startsWith('/'), `${item.code} 的地址不是相对路径：${item.path}`).toBe(true);
      expect(item.path.endsWith('/'), `${item.code} 的地址缺尾斜杠：${item.path}`).toBe(true);
    }
  });

  it('门户地址有兜底值，不会因为没配环境变量而变成空串', () => {
    /* 空串会变成"跳到当前页"，那是静默的假成功；'/' 才是门户的 home_path */
    expect(PORTAL_URL.length).toBeGreaterThan(0);
    expect(typeof portalIsSelf).toBe('boolean');
  });
});