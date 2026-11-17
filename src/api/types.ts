/* 运行态与执行链路的少量共享类型；控制面领域模型在 api/controlplane/types.ts。 */

export type Tone = 'ok' | 'run' | 'err' | 'wait';

export interface RunSummary {
  runId: string;
  agentId: string;
  sessionId: string;
  status: 'running' | 'success' | 'failed' | 'pending';
  tone: Tone;
  durationMs: number | null;
  tokens: number | null;
  startedAt: string;
}
