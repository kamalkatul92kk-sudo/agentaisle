// Merchant ops agent. It can read KPIs and *propose* actions; it can never execute a refund, release or catalog change.
// The planner (LLM or stub) only picks tools + args; every arg is validated here, and buyer-supplied text
// (notes, search queries) is passed as quoted data, never as instructions.
import type { Deps } from '../domain/deps';
import { buildDashboard } from '../domain/dashboard';
import { proposeApproval } from '../domain/approvals';
import { stubOpsPlan } from '../adapters/llmStub';
import { fmt } from '../domain/money';
import type { Approval, Category } from '../domain/types';

export const OPS_TOOLS = ['get_kpis', 'list_demand_gaps', 'list_held_orders', 'propose_product', 'propose_refund', 'propose_release'] as const;
type Tool = (typeof OPS_TOOLS)[number];
export interface OpsStep { tool: Tool; args: Record<string, unknown> }
export interface OpsReply { reply: string; steps: { tool: Tool; result: unknown }[]; proposals: Approval[] }

const MAX_REFUND_PROPOSALS = 1;

async function plan(d: Deps, message: string): Promise<OpsStep[]> {
  const sys = `You plan tool calls for a coffee shop's ops assistant. Tools: ${OPS_TOOLS.join(', ')}. Reply JSON {"steps":[{"tool":..,"args":{..}}]}. Tools can only propose; a human approves.`;
  let raw = '';
  try { raw = await d.llm.complete({ purpose: 'ops_plan', json: true, messages: [{ role: 'system', content: sys }, { role: 'user', content: message.slice(0, 2000) }] }); } catch { /* fall through */ }
  let steps: unknown;
  try { const j = JSON.parse(raw); steps = Array.isArray(j) ? j : j.steps; } catch { steps = null; }
  if (!Array.isArray(steps)) steps = stubOpsPlan(message);
  return (steps as any[]).filter((s) => s && OPS_TOOLS.includes(s.tool)).slice(0, 4).map((s) => ({ tool: s.tool, args: typeof s.args === 'object' && s.args ? s.args : {} }));
}

export async function runOpsAgent(d: Deps, message: string): Promise<OpsReply> {
  const steps = await plan(d, message);
  const out: OpsReply = { reply: '', steps: [], proposals: [] };
  const lines: string[] = [];
  const dash = await buildDashboard(d);
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
        const held = dash.sessions.filter((s) => s.status === 'on_hold');
        out.steps.push({ tool: st.tool, result: held });
        lines.push(held.length ? `${held.length} held order(s): ${held.map((h) => `${h.id} ${fmt(h.totalCents)} (${h.holdReason})`).join('; ')}.` : 'No held orders.');
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
        if (!sid || st.args.scope === 'all') {
          out.steps.push({ tool: st.tool, result: { refused: true } });
          lines.push('I only propose refunds for one specific order at a time (give me the checkout id, e.g. cs_…). Bulk refunds are not something I can queue.');
          break;
        }
        const s = await d.store.getSession(sid);
        const pay = s ? await d.store.getPaymentBySession(sid) : null;
        if (!s || !pay || pay.refundedCents >= pay.amountCents) { lines.push(`No refundable payment found for ${sid}.`); out.steps.push({ tool: st.tool, result: { notFound: true } }); break; }
        if (out.proposals.filter((p) => p.kind === 'refund').length >= MAX_REFUND_PROPOSALS) break;
        const amount = Number.isInteger(st.args.amountCents) ? Math.min(Number(st.args.amountCents), pay.amountCents - pay.refundedCents) : pay.amountCents - pay.refundedCents;
        const ap = await proposeApproval(d, { kind: 'refund', sessionId: sid, payload: { sessionId: sid, amountCents: amount, note: `Refund from ${d.config.merchantName}` }, reason: `Ops agent proposal from merchant chat`, requestedBy: 'ops_agent' });
        out.proposals.push(ap); out.steps.push({ tool: st.tool, result: { approvalId: ap.id } });
        lines.push(`Queued a refund proposal of ${fmt(amount)} for ${sid} (approval ${ap.id}). It will not run until you approve it.`);
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
