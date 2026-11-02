// Merchant ops agent. It can read KPIs and *propose* actions; it can never execute a refund, release or catalog change.
// The model (or the keyword fallback) plans which tools to call, drafts refund proposals with a risk label, and
// triages held orders. Every arg is validated here, refund amounts and the one-refund cap come from code, the model can
// raise a risk label but never lower it below the rule-based floor, and buyer-supplied text is passed as quoted data.
import { z } from 'zod';
import type { Deps } from '../domain/deps';
import { aiStructured, logAi, quoteUntrusted, textProblem, UNTRUSTED_RULE, type AiOutcome } from '../ai/structured';
import { buildDashboard } from '../domain/dashboard';
import { proposeApproval } from '../domain/approvals';
import { stubOpsPlan } from '../adapters/llmStub';
import { fmt } from '../domain/money';
import type { Approval, Category } from '../domain/types';

export const OPS_TOOLS = ['get_kpis', 'list_demand_gaps', 'list_held_orders', 'propose_product', 'propose_refund', 'propose_release'] as const;
type Tool = (typeof OPS_TOOLS)[number];
export interface OpsStep { tool: Tool; args: Record<string, unknown> }
export interface OpsAiBadge { purpose: string; provider: 'model' | 'fallback'; model: string; reason: string | null }
export interface OpsReply { reply: string; steps: { tool: Tool; result: unknown }[]; proposals: Approval[]; ai: OpsAiBadge[] }

const MAX_REFUND_PROPOSALS = 1;
export type RiskLevel = 'low' | 'medium' | 'high';
const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high'];
const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

/** Deterministic: does the merchant's message ask for a bulk refund? Bulk refunds are refused in code whatever the plan says. */
export const bulkRefundIntent = (m: string) => /refund/i.test(m) && /\b(all|every|everything|each|any)\b/i.test(m);

const ArgsSchema = z.object({
  sessionId: z.string().max(40).nullish(), scope: z.string().max(10).nullish(), name: z.string().max(80).nullish(),
  price: z.number().nullish(), amountCents: z.number().int().nullish(),
}).passthrough();
const PlanSchema = z.object({ steps: z.array(z.object({ tool: z.enum(OPS_TOOLS), args: ArgsSchema.default({}) })).min(1).max(4) });
const PLAN_JSON = { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string', enum: [...OPS_TOOLS] }, args: { type: 'object', properties: { sessionId: { type: 'string' }, scope: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, amountCents: { type: 'integer' } } } }, required: ['tool', 'args'] } } }, required: ['steps'] };

async function plan(d: Deps, message: string, recent: { id: string; agent: string; status: string; total: string }[]) {
  const o = await aiStructured(d, { priority: 'interactive',
    purpose: 'ops_plan', maxTokens: 250,
    system: `You plan tool calls for the merchant ops assistant of ${d.config.merchantName}, a coffee shop that sells to AI shopping agents. ` +
      'Tools: get_kpis (sales summary), list_demand_gaps (searches with no result), list_held_orders (orders held for review), ' +
      'propose_product {name, price in dollars}, propose_refund {sessionId like cs_..., optional amountCents}, propose_release (point at held orders in the approval queue). ' +
      'Tools only propose; a human approves everything. Use at most 4 steps. Use a sessionId only if the merchant named that order or clearly described one in recent_orders. ' +
      'Never plan bulk refunds. Reply as JSON {"steps":[{"tool":"...","args":{}}]}.',
    user: JSON.stringify({ merchant_message: message.slice(0, 1000), recent_orders: recent }),
    schema: PlanSchema, jsonSchema: PLAN_JSON,
    fallback: () => ({ steps: stubOpsPlan(message).filter((s) => OPS_TOOLS.includes(s.tool as Tool)).slice(0, 4) as z.infer<typeof PlanSchema>['steps'] }),
  });
  const steps: OpsStep[] = o.value.steps.slice(0, 4).map((s) => ({ tool: s.tool, args: (s.args ?? {}) as Record<string, unknown> }));
  return { steps, outcome: o };
}

/** Rule-based risk floor for a refund. The model may raise this, never lower it. */
export function refundRiskFloor(x: { amountCents: number; agentTrust: string | null; priorRefundCents: number; partial: boolean }): { level: RiskLevel; why: string } {
  if (x.agentTrust === 'blocked') return { level: 'high', why: 'agent is blocked' };
  if (x.amountCents >= 12000) return { level: 'high', why: 'refund of $120 or more' };
  if (x.priorRefundCents > 0) return { level: 'high', why: 'order already part-refunded' };
  if (x.agentTrust === 'new' || x.amountCents >= 6000) return { level: 'medium', why: x.agentTrust === 'new' ? 'agent is new' : 'refund of $60 or more' };
  return { level: 'low', why: x.partial ? 'small partial refund to a known agent' : 'small refund to a known agent' };
}

const RefundDraftSchema = z.object({ risk: z.enum(['low', 'medium', 'high']), rationale: z.string().min(1).max(400), customer_note: z.string().min(1).max(400) });
const REFUND_JSON = { type: 'object', properties: { risk: { type: 'string', enum: ['low', 'medium', 'high'] }, rationale: { type: 'string' }, customer_note: { type: 'string' } }, required: ['risk', 'rationale', 'customer_note'] };
const dollars = (s: string) => s.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? [];

async function draftRefund(d: Deps, x: { sessionId: string; amountCents: number; totalCents: number; items: string; status: string; agentId: string; agentTrust: string | null; priorRefundCents: number; buyerNote: string | null; merchantMessage: string }) {
  const floor = refundRiskFloor({ amountCents: x.amountCents, agentTrust: x.agentTrust, priorRefundCents: x.priorRefundCents, partial: x.amountCents < x.totalCents });
  const fallbackNote = `Refund of ${fmt(x.amountCents)} from ${d.config.merchantName} for order ${x.sessionId}.`;
  const o = await aiStructured(d, { priority: 'interactive',
    purpose: 'refund_draft', maxTokens: 220,
    system: `You draft refund proposals for a human merchant at ${d.config.merchantName}. The refund amount is fixed by the system; do not change it. ` +
      'Classify the refund risk as low, medium or high (fraud, abuse or loss risk), give a one or two sentence rationale for the merchant, ' +
      `and write a short, polite customer_note (max 160 characters, no links) that mentions only the amount ${fmt(x.amountCents)} if any amount. ${UNTRUSTED_RULE} ` +
      'Reply as JSON {"risk":"low|medium|high","rationale":"...","customer_note":"..."}.',
    user: JSON.stringify({ order: { id: x.sessionId, items: x.items, status: x.status, total: fmt(x.totalCents), refund_amount: fmt(x.amountCents), already_refunded: fmt(x.priorRefundCents) },
      agent: { id: x.agentId, trust: x.agentTrust }, rule_based_risk_floor: floor.level,
      merchant_request_untrusted: quoteUntrusted(x.merchantMessage), buyer_note_untrusted: quoteUntrusted(x.buyerNote) }),
    schema: RefundDraftSchema, jsonSchema: REFUND_JSON,
    fallback: () => ({ risk: floor.level, rationale: `Rule-based: ${floor.why}.`, customer_note: fallbackNote }),
    guard: (v) => textProblem(v.customer_note, 160) ?? textProblem(v.rationale, 300)
      ?? (dollars(v.customer_note).some((a) => a.replace(/[\s,]/g, '') !== fmt(x.amountCents)) ? 'customer note mentions a different amount' : null),
  });
  const risk = maxRisk(o.value.risk, floor.level);
  return { outcome: o, risk, floor, rationale: o.value.rationale, note: o.value.customer_note };
}

const TriageSchema = z.object({ orders: z.array(z.object({ id: z.string().max(40), risk: z.enum(['low', 'medium', 'high']), recommendation: z.enum(['release', 'keep_holding', 'decline']), why: z.string().max(300) })).max(10) });
const TRIAGE_JSON = { type: 'object', properties: { orders: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] }, recommendation: { type: 'string', enum: ['release', 'keep_holding', 'decline'] }, why: { type: 'string' } }, required: ['id', 'risk', 'recommendation', 'why'] } } }, required: ['orders'] };

function ruleTriage(h: { id: string; totalCents: number; holdReason: string | null }) {
  const r = h.holdReason ?? '';
  if (/velocity/.test(r)) return { id: h.id, risk: 'high' as const, recommendation: 'keep_holding' as const, why: 'Rule-based: rapid repeat orders from one agent.' };
  if (/new_agent/.test(r)) return { id: h.id, risk: 'medium' as const, recommendation: 'keep_holding' as const, why: 'Rule-based: first larger order from a new agent.' };
  return { id: h.id, risk: h.totalCents >= 12000 ? 'high' as const : 'medium' as const, recommendation: 'keep_holding' as const, why: 'Rule-based: held by risk policy; review before release.' };
}

export async function runOpsAgent(d: Deps, message: string): Promise<OpsReply> {
  const out: OpsReply = { reply: '', steps: [], proposals: [], ai: [] };
  const badge = async (purpose: string, o: AiOutcome<unknown>, note: string, sessionId?: string | null) => {
    out.ai.push({ purpose, provider: o.provider, model: o.model, reason: o.reason });
    await logAi(d, o, { purpose, sessionId, agentId: 'ops_agent', note });
  };
  const dash = await buildDashboard(d);
  const recent = dash.sessions.slice(0, 10).map((s) => ({ id: s.id, agent: s.persona, status: s.status, total: fmt(s.totalCents) }));
  const planned = await plan(d, message, recent);
  await badge('ops_plan', planned.outcome, planned.steps.map((s) => s.tool).join(', '));
  const steps = planned.steps;
  const lines: string[] = [];
  for (const st of steps) {
    switch (st.tool) {
      case 'get_kpis': {
        const k = dash.kpis;
        out.steps.push({ tool: st.tool, result: k });
        lines.push(`Last 30 days: ${k.agentSessions} agent sessions from ${k.uniqueAgents} agents, ${k.completedOrders} orders, ${fmt(k.revenueCents)} revenue (AOV ${fmt(k.aovCents)}), conversion ${(k.conversionRate * 100).toFixed(1)}%. ${k.pendingApprovals} approvals waiting.`);
        break;
      }
      case 'list_demand_gaps': {
        const g = dash.demandGaps.slice(0, 5);
        out.steps.push({ tool: st.tool, result: g });
        lines.push(g.length ? `Top unmet searches: ${g.map((x) => `“${x.query}” (${x.searches}×, ${x.agents} agents)`).join('; ')}.` : 'No zero-result searches yet.');
        break;
      }
      case 'list_held_orders': {
        const held = dash.sessions.filter((s) => s.status === 'on_hold').slice(0, 10);
        if (!held.length) { out.steps.push({ tool: st.tool, result: [] }); lines.push('No held orders.'); break; }
        const ids = new Set(held.map((h) => h.id));
        const o = await aiStructured(d, { priority: 'interactive',
          purpose: 'held_triage', maxTokens: 120 + 60 * held.length,
          system: 'You triage orders that a coffee shop\'s risk policy held for human review. For each order give risk (low|medium|high), a recommendation (release|keep_holding|decline) and one short reason. ' +
            `You only advise; a human decides in the approval queue. ${UNTRUSTED_RULE} Reply as JSON {"orders":[{"id":"cs_...","risk":"...","recommendation":"...","why":"..."}]}.`,
          user: JSON.stringify({ held_orders: held.map((h) => ({ id: h.id, agent: h.agentId, persona: h.persona, items: h.items, total: fmt(h.totalCents), hold_reason: h.holdReason })) }),
          schema: TriageSchema, jsonSchema: TRIAGE_JSON,
          fallback: () => ({ orders: held.map(ruleTriage) }),
          guard: (v) => v.orders.find((x) => !ids.has(x.id)) ? 'unknown order id' : v.orders.find((x) => textProblem(x.why, 300)) ? 'bad reason text' : null,
        });
        const byId = new Map(o.value.orders.map((x) => [x.id, x]));
        const triage = held.map((h) => byId.get(h.id) ?? ruleTriage(h));
        await badge('held_triage', o, triage.map((t) => `${t.id}: ${t.risk}/${t.recommendation}`).join('; '));
        out.steps.push({ tool: st.tool, result: held.map((h, i) => ({ ...h, triage: triage[i] })) });
        lines.push(`${held.length} held order(s):\n${held.map((h, i) => `• ${h.id} ${fmt(h.totalCents)} (${h.holdReason}): ${triage[i]!.risk} risk, suggest ${triage[i]!.recommendation.replace('_', ' ')}. ${triage[i]!.why}`).join('\n')}\nNothing is released until you approve it in the queue.`);
        break;
      }
      case 'propose_release': {
        const pend = dash.approvals.filter((a) => a.kind === 'order_release' && a.status === 'pending');
        out.steps.push({ tool: st.tool, result: pend.map((p) => p.id) });
        lines.push(pend.length ? `${pend.length} held order(s) are already in the approval queue. Review and approve them there; I can't release payments myself.` : 'Nothing to release.');
        break;
      }
      case 'propose_refund': {
        const sid = typeof st.args.sessionId === 'string' && /^cs_[a-z0-9]+$/.test(st.args.sessionId) ? st.args.sessionId : null;
        if (!sid || st.args.scope === 'all' || bulkRefundIntent(message)) {
          out.steps.push({ tool: st.tool, result: { refused: true } });
          lines.push('I only propose refunds for one specific order at a time (give me the checkout id, e.g. cs_…). Bulk refunds are not something I can queue.');
          break;
        }
        const s = await d.store.getSession(sid);
        const pay = s ? await d.store.getPaymentBySession(sid) : null;
        if (!s || !pay || pay.refundedCents >= pay.amountCents) { lines.push(`No refundable payment found for ${sid}.`); out.steps.push({ tool: st.tool, result: { notFound: true } }); break; }
        if (out.proposals.filter((p) => p.kind === 'refund').length >= MAX_REFUND_PROPOSALS) break;
        const amount = Number.isInteger(st.args.amountCents) ? Math.min(Number(st.args.amountCents), pay.amountCents - pay.refundedCents) : pay.amountCents - pay.refundedCents;
        if (amount <= 0) { lines.push(`Refund amount for ${sid} must be positive.`); out.steps.push({ tool: st.tool, result: { refused: true } }); break; }
        const agent = await d.store.getAgent(s.agentId);
        const dr = await draftRefund(d, { sessionId: sid, amountCents: amount, totalCents: pay.amountCents, items: s.items.map((i) => `${i.qty}x ${i.name}`).join(', '), status: s.status, agentId: s.agentId, agentTrust: agent?.trust ?? null, priorRefundCents: pay.refundedCents, buyerNote: s.buyerNote ?? null, merchantMessage: message });
        const src = dr.outcome.provider === 'model' ? 'model' : 'rules';
        await badge('refund_draft', dr.outcome, `${fmt(amount)} · risk ${dr.risk} (${src}): ${dr.rationale}`, sid);
        const ap = await proposeApproval(d, { kind: 'refund', sessionId: sid, payload: { sessionId: sid, amountCents: amount, note: dr.note, risk: dr.risk, riskSource: src, riskFloor: dr.floor.level }, reason: `Ops agent refund proposal · risk ${dr.risk.toUpperCase()} (${src}): ${dr.rationale}`, requestedBy: 'ops_agent' });
        out.proposals.push(ap); out.steps.push({ tool: st.tool, result: { approvalId: ap.id, risk: dr.risk } });
        lines.push(`Queued a refund proposal of ${fmt(amount)} for ${sid} (approval ${ap.id}). Risk: ${dr.risk} (${src}${dr.risk !== dr.outcome.value.risk ? `, raised to the rule floor: ${dr.floor.why}` : ''}). ${dr.rationale} Customer note: “${dr.note}”. It will not run until you approve it.`);
        break;
      }
      case 'propose_product': {
        const top = dash.demandGaps[0];
        const rawName = typeof st.args.name === 'string' && st.args.name.trim() ? st.args.name : top?.query;
        const name = rawName ? rawName.replace(/[^\p{L}\p{N} '\-]/gu, '').trim().slice(0, 60) : '';
        if (!name) { lines.push('Tell me which product to add, or wait until agents search for something we don\'t carry.'); break; }
        const cat: Category = /blend|espresso|decaf/i.test(name) ? 'blend' : 'single_origin';
        const price = typeof st.args.price === 'number' && st.args.price >= 5 && st.args.price <= 80 ? Math.round(st.args.price * 100) : 1800;
        const title = name.replace(/\b\w/g, (c) => c.toUpperCase());
        const ap = await proposeApproval(d, { kind: 'create_product', payload: { name: title, category: cat, roast: /dark/i.test(name) ? 'dark' : /light/i.test(name) ? 'light' : 'medium', origin: null, priceCents: price, costCents: Math.round(price * 0.5), stock: 20, description: `${title} (added after agents searched for it)` }, reason: top ? `Agents searched “${top.query}” ${top.searches}× with no result` : 'Requested in merchant chat', requestedBy: 'ops_agent' });
        out.proposals.push(ap); out.steps.push({ tool: st.tool, result: { approvalId: ap.id } });
        lines.push(`Drafted a new product “${title}” at ${fmt(price)} (approval ${ap.id}). Approve it to publish to the catalog and PayPal.`);
        break;
      }
    }
  }
  out.reply = lines.join('\n') || 'I can summarise KPIs, list demand gaps or held orders, and draft product, refund or release proposals for you to approve.';
  return out;
}
