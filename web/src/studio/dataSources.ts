// AG Studio data contract. Converts the Worker's DashboardSnapshot (+ event stream) into AgDataSourcesDefinition:
// one table per *Row contract, money in dollars (Studio aggregates numbers), and relationships so cross-filtering works
// (click an agent -> its sessions, events, revenue). Pure function: unit-testable and reusable on the Worker side.
import type { AgDataSourcesDefinition } from 'ag-studio';
import type { DashboardSnapshot, EventRow } from '../../../src/shared/contracts';

const d = (c: number | null | undefined) => (c == null ? null : c / 100);
const t = (s: string | null | undefined) => (s ? new Date(s) : null);

export function toStudioData(s: DashboardSnapshot, events: EventRow[]): AgDataSourcesDefinition {
  return {
    description: 'AgentAisle: AI shopping agents buying from Pecan Plume Coffee Co. (fictional Texas roaster) via MCP and PayPal.',
    sources: [
      { id: 'sessions', name: 'Agent checkout sessions', description: 'One row per agent checkout session',
        data: s.sessions.map((r) => ({ session_id: r.id, created_at: t(r.createdAt), agent_id: r.agentId, platform: r.platform, status: r.status, payment_mode: r.paymentMode ?? 'none', items: r.items, bags: r.bags, subtotal: d(r.subtotalCents), discount: d(r.discountCents), total: d(r.totalCents), negotiation_rounds: r.negotiationRounds, hold_reason: r.holdReason, reject_reason: r.rejectReason, completed: r.status === 'completed', paypal_order_id: r.paypalOrderId, capture_id: r.captureId, refunded: d(r.refundedCents) })),
        fields: [
          { id: 'created_at', format: 'dateTimeFormat' }, { id: 'subtotal', format: 'currencyFormat' }, { id: 'discount', format: 'currencyFormat' }, { id: 'total', format: 'currencyFormat' }, { id: 'refunded', format: 'currencyFormat' },
          { id: 'bags', format: 'integerFormat' }, { id: 'negotiation_rounds', format: 'integerFormat' }, { id: 'completed', format: 'booleanFormat' },
        ] },
      { id: 'agents', name: 'Buyer agents', data: s.agents.map((a) => ({ agent_id: a.id, platform: a.platform, display_name: a.displayName, trust: a.trust, sessions: a.sessions, orders: a.orders, revenue: d(a.revenueCents), last_seen: t(a.lastSeen) })),
        fields: [{ id: 'revenue', format: 'currencyFormat' }, { id: 'last_seen', format: 'dateTimeFormat' }] },
      { id: 'events', name: 'Event stream', data: events.map((e) => ({ event_id: e.id, ts: t(e.ts), type: e.type, session_id: e.sessionId, agent_id: e.agentId, summary: e.summary })), fields: [{ id: 'ts', format: 'dateTimeFormat' }] },
      { id: 'products', name: 'Catalog', data: s.products.map((p) => ({ sku: p.sku, name: p.name, category: p.category, roast: p.roast, price: d(p.priceCents), stock: p.stock, units_sold: p.unitsSold, revenue: d(p.revenueCents) })),
        fields: [{ id: 'price', format: 'currencyFormat' }, { id: 'revenue', format: 'currencyFormat' }, { id: 'stock', format: 'integerFormat' }, { id: 'units_sold', format: 'integerFormat' }] },
      { id: 'funnel', name: 'Agent funnel', data: s.funnel.map((f, i) => ({ stage: f.stage, step: i + 1, sessions: f.sessions })) },
      { id: 'demand_gaps', name: 'Demand gaps', data: s.demandGaps.map((g) => ({ query: g.query, searches: g.searches, agents: g.agents, last_seen: t(g.lastSeen) })) },
      { id: 'approvals', name: 'Approval queue', data: s.approvals.map((a) => ({ approval_id: a.id, created_at: t(a.createdAt), kind: a.kind, status: a.status, reason: a.reason, requested_by: a.requestedBy, session_id: a.sessionId, amount: d(a.amountCents), summary: a.summary })),
        fields: [{ id: 'amount', format: 'currencyFormat' }, { id: 'created_at', format: 'dateTimeFormat' }] },
      { id: 'mandates', name: 'Buyer mandates', data: s.mandates.map((m) => ({ mandate_id: m.id, buyer: m.buyerName, status: m.status, per_order_cap: d(m.perOrderCapCents), monthly_cap: d(m.monthlyCapCents), spent: d(m.spentThisMonthCents), reserved: d(m.reservedCents), remaining: d(m.remainingCents), expires_at: t(m.expiresAt) })),
        fields: ['per_order_cap', 'monthly_cap', 'spent', 'reserved', 'remaining'].map((id) => ({ id, format: 'currencyFormat' as const })) },
    ],
    relationships: [
      { id: 'sessions_agent', source: { tableId: 'sessions', fieldId: 'agent_id' }, target: { tableId: 'agents', fieldId: 'agent_id' }, type: 'many-to-one' },
      { id: 'events_session', source: { tableId: 'events', fieldId: 'session_id' }, target: { tableId: 'sessions', fieldId: 'session_id' }, type: 'many-to-one' },
      { id: 'approvals_session', source: { tableId: 'approvals', fieldId: 'session_id' }, target: { tableId: 'sessions', fieldId: 'session_id' }, type: 'many-to-one' },
    ],
  };
}
