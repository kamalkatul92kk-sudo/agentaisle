// Traffic simulator: spins up simulated buyer agents that shop over MCP against the real server.
import type { Deps } from '../domain/deps';
import { sha256 } from '../domain/deps';
import { importVaultedMandate, startMandate, finishMandate } from '../domain/mandates';
import { captureApprovedOrder } from '../domain/checkout';
import { MockPayPalGateway } from '../adapters/paypalMock';
import { AiPlanner, ScriptedPlanner, runBuyer, seededRng, type Planner, type RunResult } from '../agents/buyerAgent';
import { aiStructured, logAi } from '../ai/structured';
import { mcpToolCaller } from '../agents/toolCaller';
import { PERSONAS, SIM_MANDATES } from './personas';
import type { Category } from '../domain/types';

export const simToken = (key: string, secret: string) => `mdt_sim_${key}_${secret}`;

/** Make sure the simulated households have active mandates. Mock: full setup-token flow. Sandbox: needs SIM_VAULT_ID. */
export async function ensureSimMandates(d: Deps, secret: string, simVaultId?: string): Promise<Record<string, string>> {
  const tokens: Record<string, string> = {};
  for (const m of SIM_MANDATES) {
    const token = simToken(m.key, secret);
    tokens[m.key] = token;
    if (await d.store.getMandateByTokenHash(await sha256(token))) continue;
    const base = { buyerName: m.buyerName, perOrderCapCents: m.perOrderCapCents, monthlyCapCents: m.monthlyCapCents, allowedCategories: [...m.allowedCategories] as Category[], ttlDays: 30 };
    if (d.payments instanceof MockPayPalGateway) {
      const started = await startMandate(d, base);
      await d.payments.approveSetupToken(started.mandate.setupTokenId!); // simulated buyer clicks Agree on PayPal
      const active = await finishMandate(d, started.mandate.id);
      // swap the random token for the deterministic simulator token
      await d.store.updateMandate({ ...active, tokenHash: await sha256(token) });
    } else if (simVaultId) {
      await importVaultedMandate(d, { ...base, vaultId: simVaultId, token });
    } else {
      delete tokens[m.key];
    }
  }
  return tokens;
}

export interface SimOptions { sessions: number; seed?: number; secret: string; simVaultId?: string; autoApproveLinks?: number;
  /** Use the configured model for buyer decisions (default true when a real model is configured; stub always scripted). */
  useAi?: boolean }

export async function runSimulation(d: Deps, mcpHandler: (req: Request) => Promise<Response>, o: SimOptions) {
  const tokens = await ensureSimMandates(d, o.secret, o.simVaultId);
  const rng = seededRng(o.seed ?? Date.now());
  const useAi = (o.useAi ?? true) && d.llm.name !== 'stub';
  const scripted = new ScriptedPlanner();
  const results: RunResult[] = [];
  const runId = `sim${Math.floor(rng.next() * 1e9).toString(36)}`;
  for (let i = 0; i < o.sessions; i++) {
    const p = PERSONAS[Math.floor(rng.next() * PERSONAS.length)]!;
    if (p.paymentMode === 'mandate' && p.mandateKey && !tokens[p.mandateKey]) continue; // sandbox without SIM_VAULT_ID
    const agentNo = 1 + Math.floor(rng.next() * 3);
    const agentId = `sim-${p.key}-${agentNo}`;
    const call = mcpToolCaller(mcpHandler, `${d.config.publicBaseUrl}/mcp`, { 'x-agent-id': agentId, 'x-agent-platform': p.platform, 'x-agent-name': `${p.displayName} #${agentNo}` });
    const ai = useAi ? new AiPlanner((req) => aiStructured(d, req), () => d.clock.now(), scripted) : null;
    const planner: Planner = ai ?? scripted;
    const budgetCents = SIM_MANDATES.find((m) => m.key === p.mandateKey)?.perOrderCapCents;
    const r = await runBuyer(call, p, { planner, rng, mandateToken: p.mandateKey ? tokens[p.mandateKey] : undefined, runId: `${runId}-${i}`, budgetCents });
    for (const rec of ai?.log ?? []) await logAi(d, rec.outcome, { purpose: rec.purpose, sessionId: r.checkoutId, agentId, note: rec.note, ts: rec.ts });
    if (r.status === 'requires_buyer_action' && d.payments instanceof MockPayPalGateway && rng.next() < (o.autoApproveLinks ?? 0.7)) {
      const s = await d.store.getSession(r.checkoutId!);
      await d.payments.approveOrder(s!.paypalOrderId!);
      const done = await captureApprovedOrder(d, s!.paypalOrderId!);
      r.status = done.status; r.steps.push('buyer approved on PayPal (simulated) → captured');
    }
    results.push(r);
  }
  const by = (k: string) => results.filter((r) => r.status === k).length;
  return { runId, sessions: results.length, completed: by('completed'), held: by('on_hold'), rejected: by('rejected'), awaitingBuyer: by('requires_buyer_action'), abandoned: by('abandoned_no_results'), deniedMandate: results.filter((r) => r.status.startsWith('error:mandate')).length, errors: results.filter((r) => r.status.startsWith('error') && !r.status.startsWith('error:mandate')).length, results };
}
