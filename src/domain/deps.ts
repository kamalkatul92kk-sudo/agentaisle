import type { Clock, IdGen, LlmClient, MandateLedgerClient, PaymentsGateway, Store } from '../ports';

export interface AppConfig {
  publicBaseUrl: string;
  merchantName: string;
  /** Set true only when the PayPal mode is mock or sandbox; never for live. */
  allowDemoReset: boolean;
  /** Real-model guard rails: per-call timeout and a daily cap on attempted model calls (keeps Workers AI inside its free daily allocation). */
  ai?: { timeoutMs: number; dailyModelCalls: number; dailyNeurons?: number };
}

export interface Deps {
  store: Store;
  payments: PaymentsGateway;
  ledger: MandateLedgerClient;
  llm: LlmClient;
  clock: Clock;
  ids: IdGen;
  config: AppConfig;
}

export interface AgentCtx { agentId: string; platform: string; displayName: string }

export const systemClock: Clock = { now: () => new Date() };

function rand(n: number) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}
export const randomIds: IdGen = { id: (p) => `${p}_${rand(8)}`, secret: () => `mdt_${rand(24)}` };

export async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function emit(d: Deps, type: string, e: { sessionId?: string | null; agentId?: string | null; data?: Record<string, unknown> }) {
  await d.store.appendEvent({ ts: d.clock.now().toISOString(), sessionId: e.sessionId ?? null, agentId: e.agentId ?? null, type, data: e.data ?? {} });
}
