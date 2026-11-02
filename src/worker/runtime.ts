import type { Deps } from '../domain/deps';
import { randomIds, systemClock } from '../domain/deps';
import { SqlStore, type D1Like } from '../adapters/sqlStore';
import { MockPayPalGateway, D1MockState } from '../adapters/paypalMock';
import { PayPalRestGateway } from '../adapters/paypalRest';
import { StubLlm } from '../adapters/llmStub';
import { OpenAiCompatLlm } from '../adapters/llmOpenAiCompat';
import { WorkersAiLlm, type WorkersAiBinding } from '../adapters/llmWorkersAi';
import { AI_DEFAULTS } from '../ai/structured';
import { MERCHANT } from '../domain/catalog';
import type { MandateLedgerClient, PaymentsGateway, LlmClient } from '../ports';
import type { Runtime } from './app';

export interface WorkerEnv {
  DB: D1Database;
  MANDATE_LEDGER: DurableObjectNamespace<any>;
  ASSETS?: Fetcher;
  PAYPAL_MODE?: string; PAYPAL_CLIENT_ID?: string; PAYPAL_CLIENT_SECRET?: string; PAYPAL_API_BASE?: string; PAYPAL_WEBHOOK_ID?: string;
  MOCK_WEBHOOK_SECRET?: string; MERCHANT_TOKEN?: string; DEMO_MODE?: string; PUBLIC_BASE_URL?: string;
  /** Workers AI binding (wrangler.jsonc "ai": {"binding": "AI"}). Optional: without it the app runs on the stub. */
  AI?: WorkersAiBinding;
  /** stub (default) | workers-ai | openai */
  LLM_MODE?: string; LLM_API_KEY?: string; LLM_BASE_URL?: string; LLM_MODEL?: string;
  /** Per-call model timeout (ms) and max attempted model calls per UTC day before everything falls back to rules. */
  LLM_TIMEOUT_MS?: string; LLM_DAILY_CALLS?: string; LLM_DAILY_NEURONS?: string;
  SIMULATOR_ENABLED?: string; SIMULATOR_SESSIONS_PER_TICK?: string; SIM_VAULT_ID?: string; SIM_SECRET?: string;
}

export function makePayments(env: WorkerEnv, baseUrl: string, db: D1Like): PaymentsGateway {
  if (env.PAYPAL_MODE === 'sandbox') {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_MODE=sandbox requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
    const apiBase = env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
    if (!apiBase.includes('sandbox')) throw new Error('Refusing non-sandbox PayPal API base in this build');
    return new PayPalRestGateway({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, apiBase, webhookId: env.PAYPAL_WEBHOOK_ID });
  }
  return new MockPayPalGateway({ baseUrl, webhookSecret: env.MOCK_WEBHOOK_SECRET, state: new D1MockState(db) });
}

/** Pick the model provider. Any missing piece (binding, key, model) means the deterministic stub: the app never fails for lack of a model. */
export function makeLlm(env: WorkerEnv): LlmClient {
  if (env.LLM_MODE === 'workers-ai' && env.AI) return new WorkersAiLlm({ ai: env.AI, model: env.LLM_MODEL || undefined });
  if (env.LLM_MODE === 'openai' && env.LLM_API_KEY && env.LLM_MODEL) return new OpenAiCompatLlm({ apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL ?? 'https://api.openai.com/v1', model: env.LLM_MODEL });
  return new StubLlm();
}

const num = (v: string | undefined, dflt: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt);
export const aiConfig = (env: WorkerEnv) => ({ timeoutMs: num(env.LLM_TIMEOUT_MS, AI_DEFAULTS.timeoutMs), dailyModelCalls: num(env.LLM_DAILY_CALLS, AI_DEFAULTS.dailyModelCalls), dailyNeurons: num(env.LLM_DAILY_NEURONS, AI_DEFAULTS.dailyNeurons) });

export function buildRuntime(env: WorkerEnv, requestUrl: string | null, ledger: MandateLedgerClient): Runtime {
  const baseUrl = env.PUBLIC_BASE_URL || (requestUrl ? new URL(requestUrl).origin : 'http://localhost:8787');
  const db = env.DB as unknown as D1Like;
  const deps: Deps = {
    store: new SqlStore(db), payments: makePayments(env, baseUrl, db), ledger, llm: makeLlm(env), clock: systemClock, ids: randomIds,
    config: { publicBaseUrl: baseUrl, merchantName: MERCHANT.name, allowDemoReset: true, ai: aiConfig(env) },
  };
  return { deps, merchantToken: env.MERCHANT_TOKEN, demoMode: env.DEMO_MODE === 'true', simSecret: env.SIM_SECRET || env.MERCHANT_TOKEN || 'local', simVaultId: env.SIM_VAULT_ID, simSessionsPerTick: Number(env.SIMULATOR_SESSIONS_PER_TICK ?? 3) };
}
