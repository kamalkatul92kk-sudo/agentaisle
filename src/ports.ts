// Interfaces (ports) that keep the domain independent of Cloudflare, PayPal and any LLM vendor.
import type {
  Agent, Approval, CheckoutSession, DomainEvent, Mandate, Payment, Product,
} from './domain/types';

export interface Clock { now(): Date }
export interface IdGen { id(prefix: string): string; secret(): string }

export interface Store {
  listProducts(opts?: { includeInactive?: boolean }): Promise<Product[]>;
  getProduct(sku: string): Promise<Product | null>;
  upsertProduct(p: Product): Promise<void>;
  adjustStock(sku: string, delta: number): Promise<boolean>; // false if it would go negative

  upsertAgent(a: Agent): Promise<void>;
  getAgent(id: string): Promise<Agent | null>;
  listAgents(): Promise<Agent[]>;

  insertMandate(m: Mandate): Promise<void>;
  updateMandate(m: Mandate): Promise<void>;
  getMandate(id: string): Promise<Mandate | null>;
  getMandateByTokenHash(hash: string): Promise<Mandate | null>;
  getMandateBySetupToken(setupTokenId: string): Promise<Mandate | null>;
  listMandates(): Promise<Mandate[]>;

  insertSession(s: CheckoutSession): Promise<void>;
  updateSession(s: CheckoutSession): Promise<void>;
  /** Compare-and-set: writes `s` only if the stored row still has status `expected`. False = someone else moved it first. */
  updateSessionIfStatus(s: CheckoutSession, expected: CheckoutSession['status']): Promise<boolean>;
  getSession(id: string): Promise<CheckoutSession | null>;
  getSessionByOrderId(orderId: string): Promise<CheckoutSession | null>;
  getSessionByIdempotencyKey(key: string): Promise<CheckoutSession | null>;
  listSessions(opts?: { sinceIso?: string; limit?: number }): Promise<CheckoutSession[]>;
  /** Daily real-model budget (table ai_usage, not cleared by resetDemo). Reserve a call before making it; false = budget spent. */
  reserveModelCall(day: string, caps: { calls: number; neurons: number }): Promise<{ allowed: boolean } & ModelUsage>;
  recordModelUsage(day: string, u: { inputTokens: number; outputTokens: number; neurons: number }): Promise<void>;
  getModelUsage(day: string): Promise<ModelUsage>;
  countCompletedByAgentSince(agentId: string, sinceIso: string): Promise<number>;

  insertPayment(p: Payment): Promise<boolean>; // false if this session already has a payment row
  updatePayment(p: Payment): Promise<void>;
  getPaymentBySession(sessionId: string): Promise<Payment | null>;
  getPaymentByCapture(captureId: string): Promise<Payment | null>;
  listPayments(): Promise<Payment[]>;

  insertApproval(a: Approval): Promise<void>;
  updateApproval(a: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(opts?: { status?: Approval['status'] }): Promise<Approval[]>;

  appendEvent(e: DomainEvent): Promise<void>;
  listEvents(opts?: { sessionId?: string; afterId?: number; limit?: number }): Promise<DomainEvent[]>;
  /** Per-session count of verified PayPal webhooks (events typed webhook.*) and the latest one's type and time. */
  webhookStatsBySession(): Promise<{ sessionId: string; count: number; lastType: string; lastTs: string }[]>;

  recordSearch(s: { ts: string; agentId: string; query: string; normalized: string; resultCount: number }): Promise<void>;
  listSearches(opts?: { sinceIso?: string }): Promise<{ ts: string; agentId: string; query: string; normalized: string; resultCount: number }[]>;

  markWebhookSeen(id: string, type: string, ts: string, outcome: string): Promise<boolean>; // false if already seen
  resetDemo(): Promise<void>;
}

// --- Payments (PayPal) ---------------------------------------------------------
export interface Money { currency: 'USD'; cents: number }

export interface SetupTokenResult { setupTokenId: string; approveUrl: string; status: string; customerId: string | null }
export interface PaymentTokenResult { vaultId: string; customerId: string | null; payerEmail: string | null }
export interface OrderLine { name: string; sku: string; qty: number; unitCents: number }
export interface CreateOrderInput {
  requestId: string;            // idempotency (PayPal-Request-Id)
  referenceId: string;          // our checkout session id
  totalCents: number;
  itemTotalCents: number;
  discountCents: number;
  shippingCents: number;
  lines: OrderLine[];
  description: string;
}
export interface OrderResult {
  orderId: string;
  status: string;               // CREATED | PAYER_ACTION_REQUIRED | APPROVED | COMPLETED | ...
  approveUrl: string | null;
  captureId: string | null;
  captureStatus: string | null;
  /** Number of captures PayPal reports on the order (1 for a normal CAPTURE-intent order). Absent from older mocks. */
  captureCount?: number;
}
export interface RefundResult { refundId: string; status: string }

export interface PaymentsGateway {
  readonly mode: 'mock' | 'sandbox';
  createSetupToken(input: { requestId: string; returnUrl: string; cancelUrl: string; description: string; brandName: string }): Promise<SetupTokenResult>;
  getSetupToken(setupTokenId: string): Promise<{ status: string }>;
  createPaymentToken(input: { requestId: string; setupTokenId: string }): Promise<PaymentTokenResult>;
  /** Merchant-initiated charge of a vaulted PayPal wallet; buyer not present. */
  chargeVaulted(input: CreateOrderInput & { vaultId: string }): Promise<OrderResult>;
  /** Fallback: order the buyer must approve via a PayPal link. */
  createOrderForApproval(input: CreateOrderInput & { returnUrl: string; cancelUrl: string; brandName: string }): Promise<OrderResult>;
  captureOrder(orderId: string, requestId: string): Promise<OrderResult>;
  getOrder(orderId: string): Promise<OrderResult>;
  refundCapture(captureId: string, cents: number | null, requestId: string, note: string): Promise<RefundResult>;
  createCatalogProduct(input: { requestId: string; name: string; description: string; category: string }): Promise<{ id: string }>;
  verifyWebhook(headers: Headers, rawBody: string): Promise<boolean>;
}

// --- Spend ledger (Durable Object in production) ------------------------------
export interface ReserveResult { ok: boolean; reason?: 'per_order_cap' | 'monthly_cap' | 'duplicate'; spentThisMonthCents: number; reservedCents: number }
export interface LedgerSnapshot { month: string; spentCents: number; reservedCents: number; reservations: Record<string, number> }
export interface MandateLedgerClient {
  reserve(mandateId: string, input: { sessionId: string; cents: number; perOrderCapCents: number; monthlyCapCents: number; now: string }): Promise<ReserveResult>;
  commit(mandateId: string, sessionId: string, now: string): Promise<void>;
  release(mandateId: string, sessionId: string, now: string): Promise<void>;
  credit(mandateId: string, cents: number, now: string): Promise<void>; // refunds give headroom back
  snapshot(mandateId: string, now: string): Promise<LedgerSnapshot>;
}

export interface ModelUsage { calls: number; tokensIn: number; tokensOut: number; neurons: number }

// --- LLM ----------------------------------------------------------------------
export interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string }
/** Optional metadata a real client can return alongside the text (token usage for cost tracking). */
export interface LlmResult { text: string; usage?: { inputTokens: number; outputTokens: number } }
export interface LlmCompleteInput {
  purpose: string;
  messages: LlmMessage[];
  json?: boolean;
  /** JSON Schema for structured output (used by providers that support it, e.g. Workers AI JSON mode). */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}
export interface LlmClient {
  readonly name: string;
  complete(input: LlmCompleteInput): Promise<string | LlmResult>;
}
