/*
 * 执行链路专用的演示数据。
 *
 * 只保留链路页真正消费的两块：run 清单与 Agent 类型。其它控制面演示数据已删除，
 * 避免 mock 数据继续扩散到真实页面。
 */
import type { RunSummary } from '@/api/types';

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const HARNESS_AGENTS = new Set(['workwx_batch_agent', 'deployment_agent', 'diagnosis_agent']);

export function mockAgentKind(agentId: string): 'react' | 'harness' {
  return HARNESS_AGENTS.has(agentId) ? 'harness' : 'react';
}

type TraceRunSeed = [
  string,
  string,
  string,
  RunSummary['status'],
  number,
  number | null,
  number | null,
];

const traceRunSeeds: TraceRunSeed[] = [
  ['r_8f3c21a9', 'workwx_batch_agent', 'single-wo7U1…-2026-09-20', 'running', 0.01, 12_400, 142_000],
  ['r_8f3c1f04', 'deployment_agent', 'ou_87a…0de7', 'success', 0.2, 48_200, 318_000],
  ['r_8f3c1a77', 'workwx_doc_agent', 'sub-81d3…a6e5', 'success', 0.5, 6_200, 31_000],
  ['r_8f3c0d31', 'diagnosis_agent', 'group_cmr-prod', 'failed', 1.1, 22_900, 96_000],
  ['r_8f3c0912', 'workwx_notify_agent', 'gw-f991…936', 'success', 1.4, 3_300, 8_000],
  ['r_8f3c0011', 'nacos_agent', 'admin-local', 'success', 2.0, 11_700, 74_000],
  ['r_8f3bfe77', 'workwx_batch_agent', 'single-wo7U1…-2026-09-20', 'success', 3.5, 21_400, 118_000],
  ['r_8f3bfd10', 'k8s_agent', 'admin-local', 'success', 4.2, 8_600, 26_000],
  ['r_8f3bfba3', 'workwx_doc_agent', 'sub-c3f0…9a12', 'success', 5.1, 7_100, 34_000],
  ['r_8f3bfa2e', 'workwx_notify_agent', 'gw-4c81…2ad9', 'success', 6.4, 3_900, 9_000],
  ['r_8f3bf8b9', 'diagnosis_agent', 'group_cmr-prod', 'failed', 8.0, 18_300, 71_000],
  ['r_8f3bf744', 'log_agent', 'admin-local', 'success', 9.6, 5_200, 19_000],
  ['r_8f3bf5cf', 'deployment_agent', 'ou_87a…0de7', 'success', 11.2, 39_800, 254_000],
  ['r_8f3bf45a', 'data_agent', 'admin-local', 'success', 13.8, 6_900, 23_000],
  ['r_8f3bf2e5', 'workwx_batch_agent', 'single-wo7U1…-2026-09-20', 'success', 16.5, 24_100, 132_000],
  ['r_8f3bf170', 'code_agent', 'admin-local', 'failed', 19.4, null, null],
  ['r_8f3bef9b', 'trading_anomaly_agent', 'group-risk-daily', 'success', 26.0, 14_600, 58_000],
  ['r_8f3bee26', 'rabbitmq_agent', 'admin-local', 'success', 29.5, 4_400, 12_000],
  ['r_8f3becb1', 'workwx_doc_agent', 'sub-9d27…4f88', 'success', 33.0, 8_900, 41_000],
  ['r_8f3beb3c', 'xxl_job_agent', 'job-daily-report', 'success', 38.0, 12_300, 47_000],
  ['r_8f3be9c7', 'rag_agent', 'kb-prod', 'success', 44.0, 5_800, 22_000],
  ['r_8f3be852', 'workwx_batch_agent', 'single-wo7U1…-2026-09-19', 'success', 51.0, 26_700, 149_000],
  ['r_8f3be6dd', 'nacos_agent', 'admin-local', 'success', 57.0, 10_100, 63_000],
  ['r_8f3be568', 'deployment_agent', 'group-release', 'failed', 63.0, 9_700, 38_000],
  ['r_8f3be3f3', 'k8s_agent', 'admin-local', 'success', 70.0, 7_800, 24_000],
  ['r_8f3be27e', 'diagnosis_agent', 'group_cmr-prod', 'success', 78.0, 20_600, 88_000],
  ['r_8f3be109', 'workwx_notify_agent', 'gw-77ab…0e31', 'success', 92.0, 3_100, 7_000],
  ['r_8f3bdf94', 'log_agent', 'admin-local', 'failed', 104.0, 4_900, 16_000],
  ['r_8f3bde1f', 'trading_anomaly_agent', 'group-risk-daily', 'success', 120.0, 15_800, 61_000],
  ['r_8f3bdcaa', 'workwx_batch_agent', 'single-wo7U1…-2026-09-17', 'success', 146.0, 23_200, 126_000],
  ['r_8f3bdb35', 'data_agent', 'admin-local', 'success', 168.0, 6_300, 21_000],
];

export const mockTraceRuns: RunSummary[] = traceRunSeeds.map(
  ([runId, agentId, sessionId, status, hoursAgo, durationMs, tokens]) => ({
    runId,
    agentId,
    sessionId,
    status,
    tone: status === 'success' ? 'ok' : status === 'failed' ? 'err' : status === 'running' ? 'run' : 'wait',
    durationMs,
    tokens,
    startedAt: ago(hoursAgo),
  }),
);
