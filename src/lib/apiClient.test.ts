/*
 * 传输层前缀拼接的逻辑测试。
 *
 * <p>为什么不跟契约测试放一起：那两份（api/controlplane/contract.test.ts、
 * pages/routes.smoke.test.ts）断言的是「相对后端根」的路径，它们跑在
 * vitest.config.ts 钉死的空前缀下 —— 那是对的，前缀属于部署形态，不是接口契约。
 * 前缀拼接本身的有效性就换到这里验：全部用**显式传 base** 的方式，
 * 不依赖环境变量，也就不会被 .env.local 怎么写影响。
 */
import { describe, expect, it } from 'vitest';
import { API_BASE, buildUrl, withApiBase } from './apiClient';

describe('withApiBase', () => {
  it('前缀为空时原样返回（本地独立跑后端的形态）', () => {
    expect(withApiBase('/api/agents')).toBe('/api/agents');
    expect(withApiBase('/api/agents', '')).toBe('/api/agents');
  });

  it('前缀非空时补在最前面（一体化平台形态）', () => {
    expect(withApiBase('/api/agents', '/agent-platform')).toBe('/agent-platform/api/agents');
    expect(withApiBase('/api/traces/abc/events/stream', '/agent-platform')).toBe(
      '/agent-platform/api/traces/abc/events/stream',
    );
  });

  it('已经带前缀的路径不再重复拼', () => {
    // 幂等这一条是防"以后有人在上层又包了一层前缀"：
    // 真拼两次的话会变成 /agent-platform/agent-platform/api/...，只在部署环境 404。
    expect(withApiBase('/agent-platform/api/agents', '/agent-platform')).toBe(
      '/agent-platform/api/agents',
    );
  });

  it('路径没写前导斜杠时补一个，而不是直接粘上去', () => {
    // 粘上去会得到 /agent-platformapi/agents —— 少一个斜杠，路由必然匹配不上，
    // 而且在浏览器地址栏里不特意看根本发现不了。
    expect(withApiBase('api/agents', '/agent-platform')).toBe('/agent-platform/api/agents');
  });

  it('前缀与前缀同名的路径段不会被误判成"已带前缀"', () => {
    // '/agent-platformX/...' 不是 '/agent-platform/' 开头，必须照样补前缀。
    expect(withApiBase('/agent-platformX/api', '/agent-platform')).toBe(
      '/agent-platform/agent-platformX/api',
    );
  });
});

describe('buildUrl', () => {
  it('只拼查询串，不拼前缀（前缀统一由 apiResponse 补）', () => {
    // 这条断言是"职责单一"的护栏：前缀如果在这里也拼一次，配合 apiResponse 里的拼接
    // 就会变成双前缀。两处都拼的错误只在设了 VITE_API_BASE 的环境才显形。
    expect(buildUrl('/api/state/sessions', { table: 'new_agent' })).toBe(
      '/api/state/sessions?table=new_agent',
    );
  });

  it('丢掉 undefined / null / 空串，false 照常保留', () => {
    // 空串必须丢：后端把「userId=」当成"明确给了空值"去做非空校验，
    // 和"没给这个参数"是两种语义（api/controlplane/index.ts 的注释里记过这个坑）。
    expect(buildUrl('/api/x', { a: undefined, b: null, c: '', d: false, e: 0 })).toBe(
      '/api/x?d=false&e=0',
    );
  });

  it('没有任何有效参数时不留下光秃秃的问号', () => {
    expect(buildUrl('/api/x', { a: undefined })).toBe('/api/x');
    expect(buildUrl('/api/x')).toBe('/api/x');
  });
});

describe('API_BASE', () => {
  it('测试环境下是空串（vitest.config.ts 钉死的）', () => {
    // 这条守住"契约测试与 .env.local 解耦"这件事：如果哪天护栏被删掉，
    // 而本机 .env.local 恰好设了前缀，这条会先红，而不是让几十条路径断言一起红。
    expect(API_BASE).toBe('');
  });
});