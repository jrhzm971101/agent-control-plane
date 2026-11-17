/*
 * 控制面接口契约测试：把「前端发什么请求」钉在测试里。
 *
 * 为什么需要它（和 features/traces/backendContract.test.ts 是同一类动机）：
 * 联调时满屏 404 最难分辨的是"后端没实现"还是"前端路径写错了"——
 * 两者在页面上长得一样（一个错误卡片）。路径与方法是这个项目里最容易写错、
 * 又最没有类型保护的部分：TypeScript 只认函数签名，认不出 '/api/resources/prompts'
 * 写成了 '/api/resource/prompts'。
 *
 * 所以这里 stub 掉 fetch，逐个调用并断言 method + path + 关键载荷字段。
 * 期望值来自后端的 controller 注解（ResourceController / AgentController），
 * 后端改路由时这个测试先红，而不是等页面报 404 才发现。
 *
 * 它不校验响应体的形状 —— 那需要真后端（fixture 方式，见 backendContract.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/apiClient';
import {
  agentVersions,
  channelVersions,
  createAgent,
  createChannel,
  createMcpServer,
  createPrompt,
  createSkill,
  deleteAgent,
  deleteChannel,
  deleteMcpServer,
  deletePrompt,
  deleteSkill,
  getAgent,
  getChannel,
  getGateway,
  getMiddlewareChain,
  getPrompt,
  getSkill,
  listAgents,
  listChannels,
  listChannelTypes,
  listMiddlewareCatalog,
  listPrompts,
  listSkills,
  listToolCatalog,
  mcpServerVersions,
  promptVersions,
  publishAgent,
  publishChannel,
  publishMcpServer,
  publishPrompt,
  publishSkill,
  referencingAgentsOf,
  reloadAgent,
  reloadAllAgents,
  reloadAllChannels,
  reloadChannel,
  reloadGateway,
  rollbackAgent,
  rollbackChannel,
  rollbackPrompt,
  rollbackSkill,
  saveAgent,
  saveChannel,
  saveGateway,
  saveMcpServer,
  savePrompt,
  saveSkill,
  skillVersions,
  violationsOf,
} from './index';
import type {
  AgentDefinitionBundle,
  ChannelUpsert,
  McpServerEntity,
  PromptEntity,
  SkillMetaEntity,
} from './types';

interface Call {
  method: string;
  url: string;
  body: unknown;
  operator: string | null;
}

const calls: Call[] = [];

function stubFetch(respond: (call: Call) => unknown = () => ({})) {
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      operator: headers.get('X-Operator'),
    };
    calls.push(call);
    return Promise.resolve(
      new Response(JSON.stringify(respond(call) ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

function lastCall(): Call {
  return calls[calls.length - 1];
}

beforeEach(() => {
  calls.length = 0;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 最小可用的载荷：只够让函数跑完（这些测试关心的是 URL 而不是内容）
const prompt = { promptKey: 'p1', body: 'x' } as PromptEntity;
const skill = { meta: { skillName: 's1' } as SkillMetaEntity, body: 'x', resources: {} };
const mcp = { serverName: 'm1', url: 'https://x' } as McpServerEntity;
const bundle = { agent: { agentName: 'a1', agentType: 'REACT' } } as AgentDefinitionBundle;

describe('Prompt 路由', () => {
  it('列表 / 详情', async () => {
    await listPrompts();
    expect(lastCall().method).toBe('GET');
    expect(lastCall().url).toBe('/api/resources/prompts');

    await getPrompt('workwx_doc_agent');
    expect(lastCall().url).toBe('/api/resources/prompts/workwx_doc_agent');
  });

  it('新建 / 保存 / 删除', async () => {
    await createPrompt(prompt);
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe('/api/resources/prompts');
    expect(lastCall().body).toEqual(prompt);

    await savePrompt('p1', prompt);
    expect(lastCall().method).toBe('PUT');
    expect(lastCall().url).toBe('/api/resources/prompts/p1');

    await deletePrompt('p1');
    expect(lastCall().method).toBe('DELETE');
    expect(lastCall().url).toBe('/api/resources/prompts/p1');
  });

  it('发布 / 回滚 / 版本', async () => {
    await publishPrompt('p1', '改了口径');
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe('/api/resources/prompts/p1/publish');
    // 后端 publish 的 body 是可选对象，changeNote 是它唯一的字段
    expect(lastCall().body).toEqual({ changeNote: '改了口径' });

    await rollbackPrompt('p1', 3);
    expect(lastCall().url).toBe('/api/resources/prompts/p1/rollback');
    expect(lastCall().body).toEqual({ version: 3 });

    await promptVersions('p1');
    expect(lastCall().method).toBe('GET');
    expect(lastCall().url).toBe('/api/resources/prompts/p1/versions');
  });
});

describe('Skill 路由', () => {
  it('列表只取 meta，详情才取正文', async () => {
    await listSkills();
    expect(lastCall().url).toBe('/api/resources/skills');

    await getSkill('batch-audit-and-notify');
    expect(lastCall().url).toBe('/api/resources/skills/batch-audit-and-notify');
  });

  it('写入载荷是「meta + body + resources」的整体', async () => {
    await createSkill(skill);
    expect(lastCall().method).toBe('POST');
    expect(lastCall().body).toEqual(skill);

    await saveSkill('s1', skill);
    expect(lastCall().method).toBe('PUT');
    expect(lastCall().url).toBe('/api/resources/skills/s1');

    await deleteSkill('s1');
    expect(lastCall().method).toBe('DELETE');
  });

  it('发布 / 回滚 / 版本', async () => {
    await publishSkill('s1');
    expect(lastCall().url).toBe('/api/resources/skills/s1/publish');

    await rollbackSkill('s1', 4);
    expect(lastCall().url).toBe('/api/resources/skills/s1/rollback');
    expect(lastCall().body).toEqual({ version: 4 });

    await skillVersions('s1');
    expect(lastCall().url).toBe('/api/resources/skills/s1/versions');
  });
});

describe('MCP 路由', () => {
  it('新建 / 保存 / 删除 / 发布 / 版本', async () => {
    await createMcpServer(mcp);
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe('/api/resources/mcp');

    await saveMcpServer('m1', mcp);
    expect(lastCall().method).toBe('PUT');
    expect(lastCall().url).toBe('/api/resources/mcp/m1');

    await deleteMcpServer('m1');
    expect(lastCall().method).toBe('DELETE');
    expect(lastCall().url).toBe('/api/resources/mcp/m1');

    await publishMcpServer('m1');
    expect(lastCall().url).toBe('/api/resources/mcp/m1/publish');

    await mcpServerVersions('m1');
    expect(lastCall().url).toBe('/api/resources/mcp/m1/versions');
  });
});

describe('Agent 路由', () => {
  it('列表 / 详情 / 新建 / 保存 / 删除', async () => {
    await listAgents();
    expect(lastCall().url).toBe('/api/agents');

    await getAgent('workwx_batch_agent');
    expect(lastCall().url).toBe('/api/agents/workwx_batch_agent');

    await createAgent(bundle);
    expect(lastCall().method).toBe('POST');
    // 详情接口收发的就是整束行，中间不经过 AgentDefinition
    expect(lastCall().body).toEqual(bundle);

    await saveAgent('a1', bundle);
    expect(lastCall().method).toBe('PUT');
    expect(lastCall().url).toBe('/api/agents/a1');

    await deleteAgent('a1');
    expect(lastCall().method).toBe('DELETE');
    expect(lastCall().url).toBe('/api/agents/a1');
  });

  it('发布 / 回滚 / 重载 / 全量重载 / 版本', async () => {
    await publishAgent('a1');
    expect(lastCall().url).toBe('/api/agents/a1/publish');

    await rollbackAgent('a1', 2);
    expect(lastCall().url).toBe('/api/agents/a1/rollback');
    expect(lastCall().body).toEqual({ version: 2 });

    await reloadAgent('a1');
    expect(lastCall().url).toBe('/api/agents/a1/reload');

    await reloadAllAgents();
    expect(lastCall().url).toBe('/api/agents/reload-all');

    await agentVersions('a1');
    expect(lastCall().url).toBe('/api/agents/a1/versions');
  });
});

describe('渠道与网关路由', () => {
  const channelPayload = { channel: { channelId: 'c1' }, bindings: [] } as unknown as ChannelUpsert;

  it('列表 / 类型清单 / 详情', async () => {
    await listChannels();
    expect(lastCall().method).toBe('GET');
    expect(lastCall().url).toBe('/api/channels');

    await listChannelTypes();
    expect(lastCall().url).toBe('/api/channels/types');

    await getChannel('deployment_agent-bot');
    expect(lastCall().url).toBe('/api/channels/deployment_agent-bot');
  });

  it('新建 / 保存 / 删除 / 重载', async () => {
    await createChannel(channelPayload);
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe('/api/channels');
    expect(lastCall().body).toEqual(channelPayload);

    await saveChannel('c1', channelPayload);
    expect(lastCall().method).toBe('PUT');
    expect(lastCall().url).toBe('/api/channels/c1');

    await reloadChannel('c1');
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe('/api/channels/c1/reload');

    await deleteChannel('c1');
    expect(lastCall().method).toBe('DELETE');
    expect(lastCall().url).toBe('/api/channels/c1');
  });

  it('发布 / 回滚 / 版本：发布是 POST 且带 changeNote', async () => {
    await publishChannel('c1', '加了群绑定');
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe('/api/channels/c1/publish');
    expect(lastCall().body).toEqual({ changeNote: '加了群绑定' });

    await rollbackChannel('c1', 2);
    expect(lastCall().url).toBe('/api/channels/c1/rollback');
    expect(lastCall().body).toEqual({ version: 2 });

    await channelVersions('c1');
    expect(lastCall().url).toBe('/api/channels/c1/versions');
  });

  it('全量重载在渠道路径下，且不是"每个渠道一次"', async () => {
    await reloadAllChannels();
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe('/api/channels/reload-all');
  });

  it('网关：读 / 保存 / 重新装配', async () => {
    await getGateway();
    expect(lastCall().method).toBe('GET');
    expect(lastCall().url).toBe('/api/gateway');

    await saveGateway('smoke_harness', '备注');
    expect(lastCall().method).toBe('PUT');
    expect(lastCall().url).toBe('/api/gateway');
    expect(lastCall().body).toEqual({ mainAgentId: 'smoke_harness', description: '备注' });

    await reloadGateway();
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe('/api/gateway/reload');
  });

  it('渠道名做 URL 编码（名字里可能有斜杠）', async () => {
    await getChannel('a/b');
    expect(lastCall().url).toBe('/api/channels/a%2Fb');
  });
});
describe('只读目录', () => {
  it('工具目录在 agent 路径下，中间件目录在 resources 路径下', async () => {
    await listToolCatalog();
    expect(lastCall().url).toBe('/api/agents/tools/available');

    await listMiddlewareCatalog();
    expect(lastCall().url).toBe('/api/resources/middleware/catalog');

    await getMiddlewareChain();
    expect(lastCall().url).toBe('/api/resources/middleware');
  });
});

describe('写请求的公共约定', () => {
  it('每个写请求都带 X-Operator（审计列不能为空）', async () => {
    await savePrompt('p1', prompt);
    expect(lastCall().operator).toBe('console');

    await deleteAgent('a1');
    expect(lastCall().operator).toBe('console');
  });

  it('资源名做 URL 编码：名字是人工输入的，不能赌它不含斜杠或空格', async () => {
    await getPrompt('a/b c');
    expect(lastCall().url).toBe('/api/resources/prompts/a%2Fb%20c');
  });
});

describe('错误体的解析', () => {
  it('409 的引用清单能被取出来（页面据此列出引用方）', async () => {
    // 覆盖掉默认的 200 桩，让这一次请求回 409
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: '被 2 个 agent 引用，不能删除', referencingAgents: ['x', 'y'] }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const error = await deletePrompt('p1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe('被 2 个 agent 引用，不能删除');
    expect(referencingAgentsOf(error)).toEqual(['x', 'y']);
  });

  it('400 的逐条校验问题能被取出来（收集式校验，一次报全）', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: '校验未通过（2 条）', violations: ['prompt-key 不存在: p9', 'MCP 已停用: m1'] }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const error = await saveAgent('a1', bundle).catch((e: unknown) => e);
    expect(violationsOf(error)).toEqual(['prompt-key 不存在: p9', 'MCP 已停用: m1']);
    // 有 violations 时不该把引用清单也算进来（两条路径互斥）
    expect(referencingAgentsOf(error)).toEqual([]);
  });

  it('结构不符时回空数组，页面不必每处判状态码', () => {
    expect(referencingAgentsOf(new Error('boom'))).toEqual([]);
    expect(violationsOf(new ApiError('boom', 500, { other: 1 }))).toEqual([]);
    expect(violationsOf(new ApiError('boom', 400, { violations: [1, 2] }))).toEqual(['1', '2']);
  });
});
