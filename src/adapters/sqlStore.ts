// Store implementation over a minimal D1-compatible interface (Cloudflare D1 in the Worker, sql.js in tests).
import type { Store } from '../ports';
import type { Agent, Approval, CheckoutSession, DomainEvent, Mandate, Payment, Product } from '../domain/types';

export interface D1LikeStatement {
  bind(...values: unknown[]): D1LikeStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface D1Like { prepare(sql: string): D1LikeStatement; batch?(stmts: D1LikeStatement[]): Promise<unknown[]> }

type Row = Record<string, any>;
const j = (v: unknown) => JSON.stringify(v);
const b = (v: boolean) => (v ? 1 : 0);

const toProduct = (r: Row): Product => ({
  sku: r.sku, name: r.name, category: r.category, roast: r.roast ?? null, origin: r.origin ?? null, process: r.process ?? null,
  tastingNotes: r.tasting_notes ?? null, description: r.description, weightOz: r.weight_oz ?? null, priceCents: r.price_cents,
  costCents: r.cost_cents, stock: r.stock, negotiable: !!r.negotiable, maxDiscountBps: r.max_discount_bps,
  paypalProductId: r.paypal_product_id ?? null, active: !!r.active, createdAt: r.created_at,
});
const toAgent = (r: Row): Agent => ({ id: r.id, platform: r.platform, displayName: r.display_name, trust: r.trust, firstSeen: r.first_seen, lastSeen: r.last_seen });
const toMandate = (r: Row): Mandate => ({
  id: r.id, buyerName: r.buyer_name, buyerEmail: r.buyer_email ?? null, tokenHash: r.token_hash, status: r.status, vaultId: r.vault_id ?? null,
  paypalCustomerId: r.paypal_customer_id ?? null, setupTokenId: r.setup_token_id ?? null, approveUrl: r.approve_url ?? null,
  perOrderCapCents: r.per_order_cap_cents, monthlyCapCents: r.monthly_cap_cents, allowedCategories: JSON.parse(r.allowed_categories),
  expiresAt: r.expires_at, createdAt: r.created_at,
});
const toSession = (r: Row): CheckoutSession => ({
  id: r.id, agentId: r.agent_id, mandateId: r.mandate_id ?? null, status: r.status, items: JSON.parse(r.items),
  subtotalCents: r.subtotal_cents, bundleDiscountCents: r.bundle_discount_cents, negotiatedDiscountCents: r.negotiated_discount_cents,
  shippingCents: r.shipping_cents, totalCents: r.total_cents, negotiation: JSON.parse(r.negotiation), paymentMode: r.payment_mode ?? null,
  paypalOrderId: r.paypal_order_id ?? null, captureId: r.capture_id ?? null, approveUrl: r.approve_url ?? null, holdReason: r.hold_reason ?? null,
  rejectReason: r.reject_reason ?? null, idempotencyKey: r.idempotency_key ?? null, buyerNote: r.buyer_note ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at ?? null,
});
const toPayment = (r: Row): Payment => ({ id: r.id, sessionId: r.session_id, paypalOrderId: r.paypal_order_id, captureId: r.capture_id ?? null, amountCents: r.amount_cents, refundedCents: r.refunded_cents, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });
const toApproval = (r: Row): Approval => ({ id: r.id, kind: r.kind, status: r.status, sessionId: r.session_id ?? null, payload: JSON.parse(r.payload), reason: r.reason, requestedBy: r.requested_by, decidedBy: r.decided_by ?? null, result: r.result ? JSON.parse(r.result) : null, createdAt: r.created_at, decidedAt: r.decided_at ?? null });
const toEvent = (r: Row): DomainEvent => ({ id: r.id, ts: r.ts, sessionId: r.session_id ?? null, agentId: r.agent_id ?? null, type: r.type, data: JSON.parse(r.data) });

const SESSION_COLS = 'id,agent_id,mandate_id,status,items,subtotal_cents,bundle_discount_cents,negotiated_discount_cents,shipping_cents,total_cents,negotiation,payment_mode,paypal_order_id,capture_id,approve_url,hold_reason,reject_reason,idempotency_key,buyer_note,created_at,updated_at,completed_at';
const sessionVals = (s: CheckoutSession) => [s.id, s.agentId, s.mandateId, s.status, j(s.items), s.subtotalCents, s.bundleDiscountCents, s.negotiatedDiscountCents, s.shippingCents, s.totalCents, j(s.negotiation), s.paymentMode, s.paypalOrderId, s.captureId, s.approveUrl, s.holdReason, s.rejectReason, s.idempotencyKey, s.buyerNote, s.createdAt, s.updatedAt, s.completedAt];
const MANDATE_COLS = 'id,buyer_name,buyer_email,token_hash,status,vault_id,paypal_customer_id,setup_token_id,approve_url,per_order_cap_cents,monthly_cap_cents,allowed_categories,expires_at,created_at';
const mandateVals = (m: Mandate) => [m.id, m.buyerName, m.buyerEmail, m.tokenHash, m.status, m.vaultId, m.paypalCustomerId, m.setupTokenId, m.approveUrl, m.perOrderCapCents, m.monthlyCapCents, j(m.allowedCategories), m.expiresAt, m.createdAt];
const qs = (n: number) => Array(n).fill('?').join(',');

export class SqlStore implements Store {
  constructor(private db: D1Like) {}
  private async all(sql: string, ...v: unknown[]) { return (await this.db.prepare(sql).bind(...v).all<Row>()).results; }
  private async first(sql: string, ...v: unknown[]) { return this.db.prepare(sql).bind(...v).first<Row>(); }
  private async run(sql: string, ...v: unknown[]) { return this.db.prepare(sql).bind(...v).run(); }

  async listProducts(opts?: { includeInactive?: boolean }) {
    return (await this.all(`SELECT * FROM products ${opts?.includeInactive ? '' : 'WHERE active = 1'} ORDER BY category, sku`)).map(toProduct);
  }
  async getProduct(sku: string) { const r = await this.first('SELECT * FROM products WHERE sku = ?', sku); return r ? toProduct(r) : null; }
  async upsertProduct(p: Product) {
    await this.run(`INSERT INTO products (sku,name,category,roast,origin,process,tasting_notes,description,weight_oz,price_cents,cost_cents,stock,negotiable,max_discount_bps,paypal_product_id,active,created_at)
      VALUES (${qs(17)}) ON CONFLICT(sku) DO UPDATE SET name=excluded.name,category=excluded.category,roast=excluded.roast,origin=excluded.origin,process=excluded.process,
      tasting_notes=excluded.tasting_notes,description=excluded.description,weight_oz=excluded.weight_oz,price_cents=excluded.price_cents,cost_cents=excluded.cost_cents,
      stock=excluded.stock,negotiable=excluded.negotiable,max_discount_bps=excluded.max_discount_bps,paypal_product_id=excluded.paypal_product_id,active=excluded.active`,
      p.sku, p.name, p.category, p.roast, p.origin, p.process, p.tastingNotes, p.description, p.weightOz, p.priceCents, p.costCents, p.stock, b(p.negotiable), p.maxDiscountBps, p.paypalProductId, b(p.active), p.createdAt);
  }
  async adjustStock(sku: string, delta: number) {
    const r = await this.run('UPDATE products SET stock = stock + ? WHERE sku = ? AND stock + ? >= 0', delta, sku, delta);
    return (r.meta?.changes ?? 0) > 0;
  }

  async upsertAgent(a: Agent) {
    await this.run(`INSERT INTO agents (id,platform,display_name,trust,first_seen,last_seen) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,display_name=excluded.display_name,trust=excluded.trust,last_seen=excluded.last_seen`,
      a.id, a.platform, a.displayName, a.trust, a.firstSeen, a.lastSeen);
  }
  async getAgent(id: string) { const r = await this.first('SELECT * FROM agents WHERE id = ?', id); return r ? toAgent(r) : null; }
  async listAgents() { return (await this.all('SELECT * FROM agents ORDER BY last_seen DESC')).map(toAgent); }

  async insertMandate(m: Mandate) { await this.run(`INSERT INTO mandates (${MANDATE_COLS}) VALUES (${qs(14)})`, ...mandateVals(m)); }
  async updateMandate(m: Mandate) { await this.run(`REPLACE INTO mandates (${MANDATE_COLS}) VALUES (${qs(14)})`, ...mandateVals(m)); }
  async getMandate(id: string) { const r = await this.first('SELECT * FROM mandates WHERE id = ?', id); return r ? toMandate(r) : null; }
  async getMandateByTokenHash(h: string) { const r = await this.first('SELECT * FROM mandates WHERE token_hash = ?', h); return r ? toMandate(r) : null; }
  async getMandateBySetupToken(t: string) { const r = await this.first('SELECT * FROM mandates WHERE setup_token_id = ?', t); return r ? toMandate(r) : null; }
  async listMandates() { return (await this.all('SELECT * FROM mandates ORDER BY created_at DESC')).map(toMandate); }

  async insertSession(s: CheckoutSession) { await this.run(`INSERT INTO checkout_sessions (${SESSION_COLS}) VALUES (${qs(22)})`, ...sessionVals(s)); }
  async updateSession(s: CheckoutSession) { await this.run(`REPLACE INTO checkout_sessions (${SESSION_COLS}) VALUES (${qs(22)})`, ...sessionVals(s)); }
  async updateSessionIfStatus(s: CheckoutSession, expected: CheckoutSession['status']) {
    const cols = SESSION_COLS.split(',').slice(1);
    const r = await this.run(`UPDATE checkout_sessions SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id = ? AND status = ?`, ...sessionVals(s).slice(1), s.id, expected);
    return (r.meta?.changes ?? 0) > 0;
  }
  async getSession(id: string) { const r = await this.first('SELECT * FROM checkout_sessions WHERE id = ?', id); return r ? toSession(r) : null; }
  async getSessionByOrderId(o: string) { const r = await this.first('SELECT * FROM checkout_sessions WHERE paypal_order_id = ?', o); return r ? toSession(r) : null; }
  async getSessionByIdempotencyKey(k: string) { const r = await this.first('SELECT * FROM checkout_sessions WHERE idempotency_key = ?', k); return r ? toSession(r) : null; }
  async listSessions(opts?: { sinceIso?: string; limit?: number }) {
    return (await this.all('SELECT * FROM checkout_sessions WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?', opts?.sinceIso ?? '', opts?.limit ?? 1000)).map(toSession);
  }
  async countCompletedByAgentSince(agentId: string, since: string) {
    const r = await this.first("SELECT COUNT(*) AS n FROM checkout_sessions WHERE agent_id = ? AND status = 'completed' AND completed_at >= ?", agentId, since);
    return Number(r?.n ?? 0);
  }

  async insertPayment(p: Payment) {
    if (await this.first('SELECT id FROM payments WHERE session_id = ?', p.sessionId)) return false;
    const r = await this.run('INSERT OR IGNORE INTO payments (id,session_id,paypal_order_id,capture_id,amount_cents,refunded_cents,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', p.id, p.sessionId, p.paypalOrderId, p.captureId, p.amountCents, p.refundedCents, p.status, p.createdAt, p.updatedAt);
    return (r.meta?.changes ?? 0) > 0;
  }
  async updatePayment(p: Payment) { await this.run('UPDATE payments SET capture_id=?, refunded_cents=?, status=?, updated_at=? WHERE id=?', p.captureId, p.refundedCents, p.status, p.updatedAt, p.id); }
  async getPaymentBySession(id: string) { const r = await this.first('SELECT * FROM payments WHERE session_id = ?', id); return r ? toPayment(r) : null; }
  async getPaymentByCapture(id: string) { const r = await this.first('SELECT * FROM payments WHERE capture_id = ?', id); return r ? toPayment(r) : null; }
  async listPayments() { return (await this.all('SELECT * FROM payments ORDER BY created_at DESC')).map(toPayment); }

  async insertApproval(a: Approval) { await this.run('INSERT INTO approvals (id,kind,status,session_id,payload,reason,requested_by,decided_by,result,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', a.id, a.kind, a.status, a.sessionId, j(a.payload), a.reason, a.requestedBy, a.decidedBy, a.result ? j(a.result) : null, a.createdAt, a.decidedAt); }
  async updateApproval(a: Approval) { await this.run('UPDATE approvals SET status=?, decided_by=?, result=?, decided_at=? WHERE id=?', a.status, a.decidedBy, a.result ? j(a.result) : null, a.decidedAt, a.id); }
  async getApproval(id: string) { const r = await this.first('SELECT * FROM approvals WHERE id = ?', id); return r ? toApproval(r) : null; }
  async listApprovals(opts?: { status?: Approval['status'] }) {
    const rows = opts?.status ? await this.all('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC', opts.status) : await this.all('SELECT * FROM approvals ORDER BY created_at DESC');
    return rows.map(toApproval);
  }

  async appendEvent(e: DomainEvent) { await this.run('INSERT INTO events (ts,session_id,agent_id,type,data) VALUES (?,?,?,?,?)', e.ts, e.sessionId, e.agentId, e.type, j(e.data)); }
  async listEvents(opts?: { sessionId?: string; afterId?: number; limit?: number }) {
    const limit = opts?.limit ?? 200;
    const rows = opts?.sessionId
      ? await this.all('SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?', opts.sessionId, opts.afterId ?? 0, limit)
      : await this.all('SELECT * FROM (SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC', opts?.afterId ?? 0, limit);
    return rows.map(toEvent);
  }

  async webhookStatsBySession() {
    const rows = await this.all(`SELECT g.sid AS sid, g.n AS n, e.type AS last_type, e.ts AS last_ts
      FROM (SELECT session_id AS sid, COUNT(*) AS n, MAX(id) AS last_id FROM events WHERE type LIKE 'webhook.%' AND session_id IS NOT NULL GROUP BY session_id) g
      JOIN events e ON e.id = g.last_id`);
    return rows.map((r) => ({ sessionId: String(r.sid), count: Number(r.n), lastType: String(r.last_type).replace(/^webhook\./, ''), lastTs: String(r.last_ts) }));
  }

  async recordSearch(s: { ts: string; agentId: string; query: string; normalized: string; resultCount: number }) {
    await this.run('INSERT INTO searches (ts,agent_id,query,normalized,result_count) VALUES (?,?,?,?,?)', s.ts, s.agentId, s.query, s.normalized, s.resultCount);
  }
  async listSearches(opts?: { sinceIso?: string }) {
    return (await this.all('SELECT ts, agent_id, query, normalized, result_count FROM searches WHERE ts >= ? ORDER BY id DESC LIMIT 5000', opts?.sinceIso ?? ''))
      .map((r) => ({ ts: r.ts, agentId: r.agent_id, query: r.query, normalized: r.normalized, resultCount: r.result_count }));
  }

  async markWebhookSeen(id: string, type: string, ts: string, outcome: string) {
    const r = await this.run('INSERT OR IGNORE INTO webhook_events (id,type,received_at,outcome) VALUES (?,?,?,?)', id, type, ts, outcome);
    return (r.meta?.changes ?? 0) > 0;
  }

  async resetDemo() {
    for (const t of ['events', 'searches', 'approvals', 'payments', 'checkout_sessions', 'webhook_events', 'agents', 'mandates', 'products', 'mock_paypal_objects']) await this.run(`DELETE FROM ${t}`);
  }
}
