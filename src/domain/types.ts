// Core domain types. All money is integer US cents.

export type Category = 'single_origin' | 'blend' | 'reserve' | 'gear';
export type Roast = 'light' | 'medium' | 'medium_dark' | 'dark';

export interface Product {
  sku: string;
  name: string;
  category: Category;
  roast: Roast | null;
  origin: string | null;
  process: string | null;
  tastingNotes: string | null;
  description: string;
  weightOz: number | null;
  priceCents: number;
  costCents: number;
  stock: number;
  negotiable: boolean;
  maxDiscountBps: number; // basis points of list price the merchant may concede
  paypalProductId: string | null;
  active: boolean;
  createdAt: string;
}

export interface LineItem {
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
  category: Category;
}

export interface NegotiationRound {
  round: number;
  offerCents: number;
  decision: 'accept' | 'counter' | 'reject';
  merchantPriceCents: number;
  message: string;
  at: string;
}

export interface NegotiationState {
  rounds: NegotiationRound[];
  agreedTotalBeforeShippingCents: number | null;
  locked: boolean;
}

export type SessionStatus =
  | 'open'
  | 'requires_buyer_action'
  | 'on_hold'
  | 'completed'
  | 'rejected'
  | 'canceled'
  | 'failed';

export interface CheckoutSession {
  id: string;
  agentId: string;
  mandateId: string | null;
  status: SessionStatus;
  items: LineItem[];
  subtotalCents: number;
  bundleDiscountCents: number;
  negotiatedDiscountCents: number;
  shippingCents: number;
  totalCents: number;
  negotiation: NegotiationState;
  paymentMode: 'mandate' | 'approval_link' | null;
  paypalOrderId: string | null;
  captureId: string | null;
  approveUrl: string | null;
  holdReason: string | null;
  rejectReason: string | null;
  idempotencyKey: string | null;
  buyerNote: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Mandate {
  id: string;
  buyerName: string;
  buyerEmail: string | null;
  tokenHash: string;
  status: 'pending' | 'active' | 'revoked';
  vaultId: string | null;
  paypalCustomerId: string | null;
  setupTokenId: string | null;
  approveUrl: string | null;
  perOrderCapCents: number;
  monthlyCapCents: number;
  allowedCategories: Category[];
  expiresAt: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  platform: string;
  displayName: string;
  trust: 'new' | 'known' | 'blocked';
  firstSeen: string;
  lastSeen: string;
}

export interface Payment {
  id: string;
  sessionId: string;
  paypalOrderId: string;
  captureId: string | null;
  amountCents: number;
  refundedCents: number;
  status: 'completed' | 'pending' | 'refunded' | 'partially_refunded' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export type ApprovalKind = 'order_release' | 'refund' | 'create_product' | 'restock';
export interface Approval {
  id: string;
  kind: ApprovalKind;
  status: 'pending' | 'executed' | 'rejected' | 'failed';
  sessionId: string | null;
  payload: Record<string, unknown>;
  reason: string;
  requestedBy: 'risk_policy' | 'ops_agent' | 'merchant';
  decidedBy: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface DomainEvent {
  id?: number;
  ts: string;
  sessionId: string | null;
  agentId: string | null;
  type: string;
  data: Record<string, unknown>;
}

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
