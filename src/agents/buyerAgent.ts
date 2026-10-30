// Simulated buyer agents. Decisions come from a Planner: ScriptedPlanner (deterministic, default) or LlmPlanner
// (uses the LlmClient port; falls back to scripted on any bad output). Agents only talk to the store via MCP tools.
import type { LlmClient } from '../ports';
import type { ToolCaller } from './toolCaller';

export interface Rng { next(): number }
export function seededRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return { next: () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; } };
}

export interface Persona {
  key: string;
  displayName: string;
  platform: string;
  queries: string[];              // tried in order until one returns results
  qty: [number, number];
  maxItems: number;
  negotiation: 'none' | 'polite' | 'hard';
  paymentMode: 'mandate' | 'approval_link';
  mandateKey?: string;
  note?: string;
  badMandateToken?: boolean;
}

export interface Planner {
  pick(results: any[], persona: Persona, rng: Rng): Promise<any[]>;
  offer(input: { goodsCents: number; lastCounterCents: number | null; round: number; persona: Persona }, rng: Rng): Promise<number | null>;
}

export class ScriptedPlanner implements Planner {
  async pick(results: any[], p: Persona, rng: Rng) {
    const n = Math.max(1, Math.min(p.maxItems, results.length, 1 + Math.floor(rng.next() * p.maxItems)));
    return results.slice(0, n);
  }
  async offer(i: { goodsCents: number; lastCounterCents: number | null; round: number; persona: Persona }, rng: Rng) {
    if (i.persona.negotiation === 'none') return null;
    const pct = i.persona.negotiation === 'hard' ? [0.7, 0.82, 0.9][i.round - 1] : [0.92, 0.95, 0.97][i.round - 1];
    if (pct == null) return null;
    if (i.lastCounterCents != null && rng.next() < (i.persona.negotiation === 'hard' ? 0.3 : 0.6)) return i.lastCounterCents; // take the counter
    return Math.round(i.goodsCents * pct);
  }
}

export class LlmPlanner implements Planner {
  constructor(private llm: LlmClient, private fallback = new ScriptedPlanner()) {}
  async pick(results: any[], p: Persona, rng: Rng) { return this.fallback.pick(results, p, rng); }
  async offer(i: { goodsCents: number; lastCounterCents: number | null; round: number; persona: Persona }, rng: Rng) {
    try {
      const raw = await this.llm.complete({ purpose: 'buyer_plan', json: true, maxTokens: 60, messages: [
        { role: 'system', content: 'You are a frugal shopping agent negotiating a coffee order. Reply JSON {"offer_cents": integer|null}. null means accept the list price.' },
        { role: 'user', content: JSON.stringify(i) },
      ] });
      const j = JSON.parse(raw);
      if (j.offer_cents === null) return null;
      if (Number.isInteger(j.offer_cents) && j.offer_cents > 0 && j.offer_cents <= i.goodsCents) return j.offer_cents;
    } catch { /* fall back */ }
    return this.fallback.offer(i, rng);
  }
}

export interface RunResult { persona: string; checkoutId: string | null; status: string; totalCents: number | null; steps: string[]; approveUrl: string | null }

export async function runBuyer(call: ToolCaller, p: Persona, opts: { planner: Planner; rng: Rng; mandateToken?: string; runId: string }): Promise<RunResult> {
  const steps: string[] = [];
  let results: any[] = [];
  for (const q of p.queries) {
    const r = await call('search_catalog', { query: q });
    steps.push(`search "${q}" → ${r.ok ? r.data.results.length : r.error}`);
    if (r.ok && r.data.results.length) { results = r.data.results; break; }
  }
  if (!results.length) return { persona: p.key, checkoutId: null, status: 'abandoned_no_results', totalCents: null, steps, approveUrl: null };
  const picks = await opts.planner.pick(results.filter((x) => x.in_stock), p, opts.rng);
  const items = picks.map((x) => ({ sku: x.sku, qty: p.qty[0] + Math.floor(opts.rng.next() * (p.qty[1] - p.qty[0] + 1)) }));
  const c = await call('create_checkout', { items, ...(p.note ? { buyer_note: p.note } : {}) });
  if (!c.ok) return { persona: p.key, checkoutId: null, status: `error:${c.error}`, totalCents: null, steps: [...steps, `create_checkout → ${c.error}`], approveUrl: null };
  const id = c.data.checkout_id as string;
  const goods = c.data.subtotal_cents - c.data.bundle_discount_cents;
  steps.push(`create_checkout ${items.map((i) => `${i.qty}x${i.sku}`).join(',')} → ${c.data.total_cents}`);
  let counter: number | null = null;
  for (let round = 1; round <= 3; round++) {
    const offer = await opts.planner.offer({ goodsCents: goods, lastCounterCents: counter, round, persona: p }, opts.rng);
    if (offer == null) break;
    const n = await call('negotiate', { checkout_id: id, offer_cents: offer });
    if (!n.ok) { steps.push(`negotiate → ${n.error}`); break; }
    steps.push(`negotiate ${offer} → ${n.data.decision} ${n.data.merchant_price_cents}`);
    if (n.data.final) break;
    counter = n.data.merchant_price_cents;
  }
  const token = p.badMandateToken ? 'mdt_forged_token_0000' : opts.mandateToken;
  const done = await call('complete_checkout', { checkout_id: id, payment_mode: p.paymentMode, ...(p.paymentMode === 'mandate' ? { mandate_token: token } : {}), idempotency_key: `${opts.runId}-${p.key}-${id}` });
  if (!done.ok) return { persona: p.key, checkoutId: id, status: `error:${done.error}`, totalCents: null, steps: [...steps, `complete → ${done.error}`], approveUrl: null };
  steps.push(`complete_checkout(${p.paymentMode}) → ${done.data.status}`);
  return { persona: p.key, checkoutId: id, status: done.data.status, totalCents: done.data.total_cents, steps, approveUrl: done.data.approve_url };
}
