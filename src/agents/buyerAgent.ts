// Simulated buyer agents. Decisions come from a Planner: ScriptedPlanner (deterministic) or AiPlanner
// (a real model via the AI helper; falls back to scripted on any bad, slow or missing output). Agents only talk to the store via MCP tools.
import { z } from 'zod';
import type { ToolCaller } from './toolCaller';
import { textProblem, type AiOutcome, type AiRequest } from '../ai/structured';

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
  /** What the person behind the agent wants, in plain words. The AI planner shops toward this goal. */
  goal?: string;
}

export interface Pick { sku: string; qty: number }
export interface OfferInput { goodsCents: number; lastCounterCents: number | null; round: number; persona: Persona; lastOfferCents?: number | null }

export interface Planner {
  pick(results: any[], persona: Persona, rng: Rng, ctx?: { budgetCents?: number }): Promise<Pick[]>;
  offer(input: OfferInput, rng: Rng): Promise<number | null>;
}

export class ScriptedPlanner implements Planner {
  async pick(results: any[], p: Persona, rng: Rng) {
    const n = Math.max(1, Math.min(p.maxItems, results.length, 1 + Math.floor(rng.next() * p.maxItems)));
    return results.slice(0, n).map((x) => ({ sku: x.sku as string, qty: p.qty[0] + Math.floor(rng.next() * (p.qty[1] - p.qty[0] + 1)) }));
  }
  async offer(i: OfferInput, rng: Rng) {
    if (i.persona.negotiation === 'none') return null;
    const pct = i.persona.negotiation === 'hard' ? [0.7, 0.82, 0.9][i.round - 1] : [0.92, 0.95, 0.97][i.round - 1];
    if (pct == null) return null;
    if (i.lastCounterCents != null && rng.next() < (i.persona.negotiation === 'hard' ? 0.3 : 0.6)) return i.lastCounterCents; // take the counter
    return Math.round(i.goodsCents * pct);
  }
}

/** One AI decision made by a buyer agent, kept so the simulator can log it against the checkout once it exists. */
export interface BuyerAiRecord { outcome: AiOutcome<unknown>; purpose: string; note: string; ts: string }
export type AiCall = <T>(req: AiRequest<T>) => Promise<AiOutcome<T>>;

const PickSchema = z.object({ items: z.array(z.object({ sku: z.string().min(1).max(40), qty: z.number().int() })).min(1).max(5), why: z.string().max(400).default('') });
const PICK_JSON = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } }, required: ['sku', 'qty'] } }, why: { type: 'string' } }, required: ['items', 'why'] };
const OfferSchema = z.object({ offer_cents: z.number().int().nullable(), message: z.string().max(400).default('') });
const OFFER_JSON = { type: 'object', properties: { offer_cents: { type: ['integer', 'null'] }, message: { type: 'string' } }, required: ['offer_cents', 'message'] };
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * Model-driven buyer agent: picks products from real search results to meet the persona's goal, and decides and
 * phrases each haggling offer. Everything it proposes is checked here (SKU must be in the results, qty in range,
 * offer a positive integer no higher than the price), and the merchant server enforces floor price, caps and approvals
 * on its own regardless of what any agent sends. Any bad, slow or missing model answer falls back to ScriptedPlanner.
 */
export class AiPlanner implements Planner {
  readonly log: BuyerAiRecord[] = [];
  constructor(private ai: AiCall, private now: () => Date = () => new Date(), private fallback: Planner = new ScriptedPlanner()) {}

  async pick(results: any[], p: Persona, rng: Rng, ctx: { budgetCents?: number } = {}): Promise<Pick[]> {
    const catalog = results.slice(0, 8).map((x) => ({ sku: x.sku, name: x.name, roast: x.roast, origin: x.origin, tasting_notes: x.tasting_notes, weight_oz: x.weight_oz, price_cents: x.price_cents }));
    const skus = new Set(catalog.map((x) => x.sku));
    const o = await this.ai({
      purpose: 'buyer_pick', maxTokens: 200,
      system: `You are "${p.displayName}", an AI shopping agent buying coffee for a person. Their goal: ${p.goal ?? 'buy good coffee at a fair price'}. ` +
        `Choose from the search results only. Rules: at most ${p.maxItems} different products, each qty between ${p.qty[0]} and ${p.qty[1]}` +
        `${ctx.budgetCents ? `, and try to keep the list-price total under ${usd(ctx.budgetCents)} (your buyer's per-order limit)` : ''}. ` +
        'Reply as JSON {"items":[{"sku":"...","qty":1}],"why":"one short sentence"}.',
      user: JSON.stringify({ search_results: catalog }),
      schema: PickSchema, jsonSchema: PICK_JSON,
      fallback: async () => ({ items: await this.fallback.pick(results, p, rng), why: 'scripted pick' }),
      guard: (v) => {
        if (v.items.length > p.maxItems) return `picked ${v.items.length} products (max ${p.maxItems})`;
        if (new Set(v.items.map((i) => i.sku)).size !== v.items.length) return 'duplicate SKU';
        const bad = v.items.find((i) => !skus.has(i.sku));
        if (bad) return `SKU not in search results: ${bad.sku.slice(0, 40)}`;
        const q = v.items.find((i) => i.qty < p.qty[0] || i.qty > p.qty[1]);
        return q ? `qty ${q.qty} outside ${p.qty[0]}-${p.qty[1]}` : null;
      },
    });
    this.log.push({ outcome: o, purpose: 'buyer_pick', note: `${o.value.items.map((i) => `${i.qty}x ${i.sku}`).join(', ')}${o.value.why ? `: ${o.value.why}` : ''}`, ts: this.now().toISOString() });
    return o.value.items;
  }

  async offer(i: OfferInput, rng: Rng): Promise<number | null> {
    if (i.persona.negotiation === 'none') return null; // persona never haggles: no model call needed
    const p = i.persona;
    const o = await this.ai({
      purpose: 'buyer_offer', maxTokens: 120,
      system: `You are "${p.displayName}", an AI shopping agent haggling with a coffee shop's checkout. Your buyer's goal: ${p.goal ?? 'a fair price'}. ` +
        `Haggling style: ${p.negotiation === 'hard' ? 'push hard for a discount' : 'polite, small discount is fine'}. There are at most 3 rounds. ` +
        'Decide your next offer for the goods in integer cents, or null to stop haggling and pay the current price. ' +
        'Rules: never offer less than your own previous offer; never offer more than the merchant\'s last counter (offer exactly the counter to accept it). ' +
        'Also write the one-line message you would say to the shop, with any amount written in dollars like $25.00. ' +
        'Reply as JSON {"offer_cents": 1234 or null, "message": "..."}.',
      user: JSON.stringify({ round: i.round, list_price_cents: i.goodsCents, merchant_last_counter_cents: i.lastCounterCents, your_previous_offer_cents: i.lastOfferCents ?? null }),
      schema: OfferSchema, jsonSchema: OFFER_JSON,
      fallback: async () => ({ offer_cents: await this.fallback.offer(i, rng), message: '' }),
      guard: (v) => {
        if (v.offer_cents != null && (v.offer_cents <= 0 || v.offer_cents > i.goodsCents)) return `offer ${v.offer_cents} outside 1..${i.goodsCents}`;
        if (v.offer_cents != null && i.lastOfferCents != null && v.offer_cents < i.lastOfferCents) return `offer ${v.offer_cents} below own previous offer ${i.lastOfferCents}`;
        if (v.offer_cents != null && i.lastCounterCents != null && v.offer_cents > i.lastCounterCents) return `offer ${v.offer_cents} above the merchant counter ${i.lastCounterCents}`;
        return textProblem(v.message ?? '', 240);
      },
    });
    const said = o.value.message ? ` "${o.value.message}"` : '';
    this.log.push({ outcome: o, purpose: 'buyer_offer', note: `round ${i.round}: ${o.value.offer_cents == null ? 'stop haggling' : `offer ${usd(o.value.offer_cents)}`}${said}`, ts: this.now().toISOString() });
    return o.value.offer_cents;
  }
}

export interface RunResult { persona: string; checkoutId: string | null; status: string; totalCents: number | null; steps: string[]; approveUrl: string | null }

export async function runBuyer(call: ToolCaller, p: Persona, opts: { planner: Planner; rng: Rng; mandateToken?: string; runId: string; budgetCents?: number }): Promise<RunResult> {
  const steps: string[] = [];
  let results: any[] = [];
  for (const q of p.queries) {
    const r = await call('search_catalog', { query: q });
    steps.push(`search "${q}" → ${r.ok ? r.data.results.length : r.error}`);
    if (r.ok && r.data.results.length) { results = r.data.results; break; }
  }
  if (!results.length) return { persona: p.key, checkoutId: null, status: 'abandoned_no_results', totalCents: null, steps, approveUrl: null };
  const items = await opts.planner.pick(results.filter((x) => x.in_stock), p, opts.rng, { budgetCents: opts.budgetCents });
  const c = await call('create_checkout', { items, ...(p.note ? { buyer_note: p.note } : {}) });
  if (!c.ok) return { persona: p.key, checkoutId: null, status: `error:${c.error}`, totalCents: null, steps: [...steps, `create_checkout → ${c.error}`], approveUrl: null };
  const id = c.data.checkout_id as string;
  const goods = c.data.subtotal_cents - c.data.bundle_discount_cents;
  steps.push(`create_checkout ${items.map((i) => `${i.qty}x${i.sku}`).join(',')} → ${c.data.total_cents}`);
  let counter: number | null = null;
  let lastOffer: number | null = null;
  for (let round = 1; round <= 3; round++) {
    const offer = await opts.planner.offer({ goodsCents: goods, lastCounterCents: counter, round, persona: p, lastOfferCents: lastOffer }, opts.rng);
    if (offer == null) break;
    lastOffer = offer;
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
