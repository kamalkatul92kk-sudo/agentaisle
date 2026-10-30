import type { Deps } from './deps';
import type { AgentRow, ApprovalRow, DashboardSnapshot, DemandGapRow, EventRow, FunnelRow, KpiSummary, MandateRow, ProductRow, SessionRow } from '../shared/contracts';
import type { DomainEvent } from './types';
import { mandateView } from './mandates';
import { fmt } from './money';

export function eventSummary(e: DomainEvent): string {
  const x = e.data as any;
  switch (e.type) {
    case 'agent.search': return `searched "${x.query}" → ${x.results} result(s)`;
    case 'checkout.created': return `cart ${(x.items ?? []).join(', ')} = ${fmt(x.totalCents ?? 0)}`;
    case 'checkout.updated': return `cart updated → ${fmt(x.totalCents ?? 0)}`;
    case 'negotiation.round': return `round ${x.round}: offered ${fmt(x.offerCents)} → ${x.decision} at ${fmt(x.merchantPriceCents)}`;
    case 'checkout.on_hold': return `held for review: ${x.reason}`;
    case 'checkout.rejected': return `rejected: ${x.reason}`;
    case 'checkout.mandate_denied': return `mandate denied: ${x.code}`;
    case 'checkout.requires_buyer_action': return `waiting for buyer to approve on PayPal (${fmt(x.totalCents)})`;
    case 'payment.captured': return `paid ${fmt(x.totalCents)} via ${x.mode === 'mandate' ? 'saved PayPal (buyer absent)' : 'PayPal approval'}`;
    case 'payment.refunded': return `refunded ${fmt(x.amountCents)}`;
    case 'payment.declined': return `payment declined`;
    case 'payment.failed': return `payment error`;
    case 'approval.proposed': return `${x.kind} proposed by ${x.requestedBy}`;
    case 'approval.executed': return `${x.kind} approved & executed`;
    case 'approval.rejected': return `${x.kind} rejected by merchant`;
    default: return e.type.startsWith('webhook.') ? `PayPal webhook ${e.type.slice(8)} (signature verified)${x.sessionStatus ? ` → ${x.sessionStatus}` : ''}${x.refundedCents ? ` → refunded ${fmt(x.refundedCents)}` : ''}` : e.type;
  }
}

export async function eventRows(d: Deps, opts: { afterId?: number; sessionId?: string; limit?: number }): Promise<EventRow[]> {
  return (await d.store.listEvents(opts)).map((e) => ({ id: e.id!, ts: e.ts, type: e.type, sessionId: e.sessionId, agentId: e.agentId, summary: eventSummary(e) }));
}

export async function buildDashboard(d: Deps, windowHours = 24 * 30): Promise<DashboardSnapshot> {
  const now = d.clock.now();
  const since = new Date(now.getTime() - windowHours * 3600_000).toISOString();
  const [sessions, agents, approvals, mandates, products, searches, payments, hooks] = await Promise.all([
    d.store.listSessions({ sinceIso: since, limit: 2000 }), d.store.listAgents(), d.store.listApprovals(), d.store.listMandates(),
    d.store.listProducts({ includeInactive: true }), d.store.listSearches({ sinceIso: since }), d.store.listPayments(), d.store.webhookStatsBySession(),
  ]);
  const paymentBySession = new Map(payments.map((p) => [p.sessionId, p]));
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const hooksBySession = new Map(hooks.map((h) => [h.sessionId, h]));
  const completed = sessions.filter((s) => s.status === 'completed');
  const revenue = completed.reduce((a, s) => a + s.totalCents, 0);
  const goods = completed.reduce((a, s) => a + s.subtotalCents - s.bundleDiscountCents, 0);
  const negotiated = completed.reduce((a, s) => a + s.negotiatedDiscountCents, 0);
  const pending = approvals.filter((a) => a.status === 'pending');

  const sessionRows: SessionRow[] = sessions.map((s) => ({
    id: s.id, createdAt: s.createdAt, agentId: s.agentId, platform: agentById.get(s.agentId)?.platform ?? 'unknown', status: s.status, paymentMode: s.paymentMode,
    items: s.items.map((i) => `${i.qty}× ${i.name}`).join(', '), bags: s.items.filter((i) => i.category !== 'gear').reduce((a, i) => a + i.qty, 0),
    subtotalCents: s.subtotalCents, discountCents: s.bundleDiscountCents + s.negotiatedDiscountCents, totalCents: s.totalCents,
    negotiationRounds: s.negotiation.rounds.length, holdReason: s.holdReason, rejectReason: s.rejectReason, completedAt: s.completedAt,
    paypalOrderId: s.paypalOrderId ?? paymentBySession.get(s.id)?.paypalOrderId ?? null, captureId: s.captureId ?? paymentBySession.get(s.id)?.captureId ?? null,
    refundedCents: paymentBySession.get(s.id)?.refundedCents ?? 0,
    persona: personaOf(s.agentId),
    webhooks: hooksBySession.get(s.id)?.count ?? 0, lastWebhook: hooksBySession.get(s.id)?.lastType ?? null, lastWebhookAt: hooksBySession.get(s.id)?.lastTs ?? null,
  }));

  const funnel: FunnelRow[] = [
    { stage: 'searched', sessions: searches.length },
    { stage: 'checkout_created', sessions: sessions.length },
    { stage: 'negotiated', sessions: sessions.filter((s) => s.negotiation.rounds.length > 0).length },
    { stage: 'completion_attempted', sessions: sessions.filter((s) => s.status !== 'open' && s.status !== 'canceled').length },
    { stage: 'completed', sessions: completed.length },
  ];

  const gaps = new Map<string, { searches: number; agents: Set<string>; lastSeen: string; query: string }>();
  for (const s of searches.filter((x) => x.resultCount === 0)) {
    const g = gaps.get(s.normalized) ?? { searches: 0, agents: new Set(), lastSeen: s.ts, query: s.query };
    g.searches++; g.agents.add(s.agentId); if (s.ts > g.lastSeen) g.lastSeen = s.ts;
    gaps.set(s.normalized, g);
  }
  const demandGaps: DemandGapRow[] = [...gaps.entries()].map(([k, g]) => ({ query: g.query || k, searches: g.searches, agents: g.agents.size, lastSeen: g.lastSeen })).sort((a, b) => b.searches - a.searches);

  const approvalRows: ApprovalRow[] = approvals.map((a) => ({
    id: a.id, createdAt: a.createdAt, kind: a.kind, status: a.status, reason: a.reason, requestedBy: a.requestedBy, sessionId: a.sessionId,
    amountCents: typeof a.payload.totalCents === 'number' ? a.payload.totalCents : typeof a.payload.amountCents === 'number' ? a.payload.amountCents : typeof a.payload.priceCents === 'number' ? a.payload.priceCents : null,
    summary: a.kind === 'create_product' ? `New product: ${String(a.payload.name)}` : a.kind === 'refund' ? `Refund ${a.sessionId}` : a.kind === 'restock' ? `Restock ${String(a.payload.sku)} +${String(a.payload.qty)}` : `Release held order ${a.sessionId}`,
  }));

  const mandateRows: MandateRow[] = [];
  for (const m of mandates) { const v = await mandateView(d, m); mandateRows.push({ id: v.id, buyerName: v.buyerName, status: v.status, perOrderCapCents: v.perOrderCapCents, monthlyCapCents: v.monthlyCapCents, spentThisMonthCents: v.spentThisMonthCents, reservedCents: v.reservedCents, remainingCents: v.remainingCents, expiresAt: v.expiresAt }); }

  const sold = new Map<string, { units: number; rev: number }>();
  for (const s of completed) for (const i of s.items) { const x = sold.get(i.sku) ?? { units: 0, rev: 0 }; x.units += i.qty; x.rev += i.lineTotalCents; sold.set(i.sku, x); }
  const productRows: ProductRow[] = products.map((p) => ({ sku: p.sku, name: p.name, category: p.category, roast: p.roast, priceCents: p.priceCents, stock: p.stock, unitsSold: sold.get(p.sku)?.units ?? 0, revenueCents: sold.get(p.sku)?.rev ?? 0 }));

  const agentRows: AgentRow[] = agents.map((a) => {
    const mine = sessions.filter((s) => s.agentId === a.id);
    const done = mine.filter((s) => s.status === 'completed');
    return { id: a.id, platform: a.platform, displayName: a.displayName, trust: a.trust, sessions: mine.length, orders: done.length, revenueCents: done.reduce((x, s) => x + s.totalCents, 0), lastSeen: a.lastSeen };
  });

  const kpis: KpiSummary = {
    window: `${windowHours}h`, agentSessions: sessions.length, uniqueAgents: new Set(sessions.map((s) => s.agentId)).size, completedOrders: completed.length,
    revenueCents: revenue, aovCents: completed.length ? Math.round(revenue / completed.length) : 0, conversionRate: sessions.length ? completed.length / sessions.length : 0,
    avgNegotiatedDiscountBps: goods + negotiated ? Math.round((negotiated / (goods + negotiated)) * 10000) : 0,
    heldOrders: sessions.filter((s) => s.status === 'on_hold').length, rejectedOrders: sessions.filter((s) => s.status === 'rejected').length,
    pendingApprovals: pending.length, zeroResultSearches: searches.filter((s) => s.resultCount === 0).length,
  };
  return { generatedAt: now.toISOString(), paypalMode: d.payments.mode, llm: d.llm.name, kpis, sessions: sessionRows, funnel, demandGaps, approvals: approvalRows, mandates: mandateRows, products: productRows, agents: agentRows };
}

/** Simulator agents are named sim-<persona>-<n>; anything else is an external agent. */
export const personaOf = (agentId: string) => /^sim-(.+)-\d+$/.exec(agentId)?.[1] ?? 'external';
