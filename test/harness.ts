import { readFileSync, readdirSync } from 'node:fs';
import { createSqlJsD1 } from '../src/adapters/sqljsD1';
import { SqlStore } from '../src/adapters/sqlStore';
import { MockPayPalGateway } from '../src/adapters/paypalMock';
import { InMemoryLedger } from '../src/domain/ledger';
import { StubLlm } from '../src/adapters/llmStub';
import { randomIds, type AgentCtx, type Deps } from '../src/domain/deps';
import { seedCatalogIfEmpty } from '../src/domain/catalogService';
import { startMandate, finishMandate } from '../src/domain/mandates';
import { createApp, type Runtime } from '../src/worker/app';
import type { LlmClient } from '../src/ports';

const MIG = new URL('../migrations/', import.meta.url);
export const schema = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, MIG), 'utf8')).join('\n');
export const BASE = 'http://test.local';
export const WEBHOOK_SECRET = 'test-webhook-secret';

export class TestClock { t: number; constructor(iso = '2026-11-05T15:00:00.000Z') { this.t = Date.parse(iso); } now() { return new Date(this.t); } advance(ms: number) { this.t += ms; } }

export async function harness(o: { llm?: LlmClient; demoMode?: boolean } = {}) {
  const db = await createSqlJsD1(schema);
  const clock = new TestClock();
  const payments = new MockPayPalGateway({ baseUrl: BASE, webhookSecret: WEBHOOK_SECRET });
  const llm = o.llm ?? new StubLlm();
  const d: Deps = { store: new SqlStore(db), payments, ledger: new InMemoryLedger(), llm, clock, ids: randomIds, config: { publicBaseUrl: BASE, merchantName: 'Pecan Plume Coffee Co.', allowDemoReset: true } };
  await seedCatalogIfEmpty(d);
  const rt: Runtime = { deps: d, merchantToken: 'merchant-test-token', demoMode: o.demoMode ?? false, simSecret: 'testsim', simSessionsPerTick: 3 };
  const app = createApp(() => rt);
  const fetch = async (req: Request) => app.fetch(req);
  return { d, db, clock, payments, llm, app, fetch, rt };
}
export type H = Awaited<ReturnType<typeof harness>>;

export const agent = (id = 'agent-alpha', platform = 'test-harness'): AgentCtx => ({ agentId: id, platform, displayName: id });

/** Full buyer-present mandate flow through the mock: start -> buyer approves on "PayPal" -> finish. */
export async function activeMandate(h: H, caps: { perOrder?: number; monthly?: number; categories?: any[]; ttlDays?: number } = {}) {
  const r = await startMandate(h.d, { buyerName: 'Test Buyer', perOrderCapCents: caps.perOrder ?? 10000, monthlyCapCents: caps.monthly ?? 30000, allowedCategories: caps.categories, ttlDays: caps.ttlDays ?? 30 });
  await h.payments.approveSetupToken(r.mandate.setupTokenId!);
  const m = await finishMandate(h.d, r.mandate.id);
  return { mandate: m, token: r.mandateToken };
}

export const merchantHeaders = { authorization: 'Bearer merchant-test-token', 'content-type': 'application/json' };
