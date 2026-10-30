// Data contracts shared by the Worker (producer) and the merchant UI (AG Grid widgets now, AG Studio data sources later).
// Each *Row interface maps 1:1 to an AG Studio data source table (see web/src/studio/dataSources.ts).

export interface KpiSummary {
  window: string;
  agentSessions: number;
  uniqueAgents: number;
  completedOrders: number;
  revenueCents: number;
  aovCents: number;
  conversionRate: number;     // completed / sessions
  avgNegotiatedDiscountBps: number;
  heldOrders: number;
  rejectedOrders: number;
  pendingApprovals: number;
  zeroResultSearches: number;
}

export interface SessionRow {
  id: string; createdAt: string; agentId: string; platform: string; status: string; paymentMode: string | null;
  items: string; bags: number; subtotalCents: number; discountCents: number; totalCents: number;
  negotiationRounds: number; holdReason: string | null; rejectReason: string | null; completedAt: string | null;
  /** Real PayPal ids (sandbox or mock), so every grid row can be checked against PayPal. */
  paypalOrderId: string | null; captureId: string | null; refundedCents: number;
  /** Simulator persona key (from agent id sim-<persona>-<n>) or 'external' for real MCP agents. */
  persona: string;
  /** Signature-verified PayPal webhooks linked to this session, and the most recent one's event type. */
  webhooks: number; lastWebhook: string | null; lastWebhookAt: string | null;
}
export interface EventRow { id: number; ts: string; type: string; sessionId: string | null; agentId: string | null; summary: string }
export interface FunnelRow { stage: 'searched' | 'checkout_created' | 'negotiated' | 'completion_attempted' | 'completed'; sessions: number }
export interface DemandGapRow { query: string; searches: number; agents: number; lastSeen: string }
export interface ApprovalRow { id: string; createdAt: string; kind: string; status: string; reason: string; requestedBy: string; sessionId: string | null; amountCents: number | null; summary: string }
export interface MandateRow { id: string; buyerName: string; status: string; perOrderCapCents: number; monthlyCapCents: number; spentThisMonthCents: number; reservedCents: number; remainingCents: number; expiresAt: string }
export interface ProductRow { sku: string; name: string; category: string; roast: string | null; priceCents: number; stock: number; unitsSold: number; revenueCents: number }
export interface AgentRow { id: string; platform: string; displayName: string; trust: string; sessions: number; orders: number; revenueCents: number; lastSeen: string }

export interface DashboardSnapshot {
  generatedAt: string;
  paypalMode: 'mock' | 'sandbox';
  llm: string;
  kpis: KpiSummary;
  sessions: SessionRow[];
  funnel: FunnelRow[];
  demandGaps: DemandGapRow[];
  approvals: ApprovalRow[];
  mandates: MandateRow[];
  products: ProductRow[];
  agents: AgentRow[];
}
