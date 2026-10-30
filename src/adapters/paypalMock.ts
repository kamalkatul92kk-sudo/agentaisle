// Mock PayPal gateway: models the sandbox state machine (setup token -> approval -> payment token; orders; captures;
// refunds) closely enough for tests and keyless local demos. Never moves money.
import type { CreateOrderInput, OrderResult, PaymentsGateway, PaymentTokenResult, RefundResult, SetupTokenResult } from '../ports';
import type { D1Like } from './sqlStore';

export interface MockStateStore { get(id: string): Promise<any | null>; put(id: string, kind: string, data: any): Promise<void> }
export class MemoryMockState implements MockStateStore {
  m = new Map<string, any>();
  async get(id: string) { const v = this.m.get(id); return v ? structuredClone(v) : null; }
  async put(id: string, _k: string, d: any) { this.m.set(id, structuredClone(d)); }
}
export class D1MockState implements MockStateStore {
  constructor(private db: D1Like) {}
  async get(id: string) { const r = await this.db.prepare('SELECT data FROM mock_paypal_objects WHERE id = ?').bind(id).first<{ data: string }>(); return r ? JSON.parse(r.data) : null; }
  async put(id: string, kind: string, d: any) { await this.db.prepare('REPLACE INTO mock_paypal_objects (id,kind,data) VALUES (?,?,?)').bind(id, kind, JSON.stringify(d)).run(); }
}

export interface MockOptions {
  baseUrl: string;                 // where /mock-paypal/* approve pages are served
  webhookSecret?: string;
  state?: MockStateStore;
  autoApproveSetup?: boolean;      // tests: setup tokens come back already APPROVED
}

let seq = 0;
const rid = (p: string) => `${p}${Date.now().toString(36).toUpperCase()}${(++seq).toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export class MockPayPalGateway implements PaymentsGateway {
  readonly mode = 'mock' as const;
  readonly state: MockStateStore;
  calls: { op: string; args: unknown }[] = [];
  /** Test hook: next vaulted charge is declined. */
  declineNextCharge = false;
  constructor(private opts: MockOptions) { this.state = opts.state ?? new MemoryMockState(); }

  private async idem<T>(requestId: string, op: string, fn: () => Promise<T>): Promise<T> {
    const key = `req:${op}:${requestId}`;
    const prior = await this.state.get(key);
    if (prior) return prior.result as T;
    const result = await fn();
    await this.state.put(key, 'request', { result });
    return result;
  }

  async createSetupToken(i: { requestId: string; returnUrl: string; cancelUrl: string; description: string; brandName: string }): Promise<SetupTokenResult> {
    this.calls.push({ op: 'createSetupToken', args: i });
    return this.idem(i.requestId, 'setup', async () => {
      const id = rid('MOCKSETUP');
      const customerId = rid('MOCKCUST');
      const status = this.opts.autoApproveSetup ? 'APPROVED' : 'PAYER_ACTION_REQUIRED';
      await this.state.put(id, 'setup_token', { id, status, customerId, returnUrl: i.returnUrl, cancelUrl: i.cancelUrl, used: false });
      return { setupTokenId: id, status, customerId, approveUrl: `${this.opts.baseUrl}/mock-paypal/approve-setup?approval_session_id=${id}` };
    });
  }
  /** Simulates the buyer clicking "Agree and Continue" on PayPal. Returns the merchant return URL. */
  async approveSetupToken(id: string, approve = true): Promise<string> {
    const t = await this.state.get(id);
    if (!t) throw new Error('unknown setup token');
    t.status = approve ? 'APPROVED' : 'CANCELLED';
    await this.state.put(id, 'setup_token', t);
    const u = new URL(approve ? t.returnUrl : t.cancelUrl);
    u.searchParams.set('approval_token_id', id);
    u.searchParams.set('approval_session_id', id);
    return u.toString();
  }
  async getSetupToken(id: string) { const t = await this.state.get(id); if (!t) throw new Error('RESOURCE_NOT_FOUND'); return { status: t.status as string }; }
  async createPaymentToken(i: { requestId: string; setupTokenId: string }): Promise<PaymentTokenResult> {
    this.calls.push({ op: 'createPaymentToken', args: i });
    return this.idem(i.requestId, 'ptoken', async () => {
      const t = await this.state.get(i.setupTokenId);
      if (!t) throw new Error('INVALID_RESOURCE_ID');
      if (t.status !== 'APPROVED') throw new Error('SETUP_TOKEN_NOT_APPROVED');
      if (t.used) throw new Error('SETUP_TOKEN_ALREADY_USED');
      t.used = true; await this.state.put(t.id, 'setup_token', t);
      const vaultId = rid('MOCKVAULT');
      await this.state.put(vaultId, 'payment_token', { id: vaultId, customerId: t.customerId, active: true });
      return { vaultId, customerId: t.customerId, payerEmail: 'sandbox-buyer@example.com' };
    });
  }

  async chargeVaulted(i: CreateOrderInput & { vaultId: string }): Promise<OrderResult> {
    this.calls.push({ op: 'chargeVaulted', args: i });
    return this.idem(i.requestId, 'charge', async () => {
      const v = await this.state.get(i.vaultId);
      if (!v || !v.active) throw new Error('INVALID_PAYMENT_TOKEN');
      const orderId = rid('MOCKORDER');
      if (this.declineNextCharge) {
        this.declineNextCharge = false;
        const captureId = rid('MOCKCAP');
        await this.state.put(orderId, 'order', { id: orderId, status: 'COMPLETED', totalCents: i.totalCents, captureId, captureStatus: 'DECLINED', refundedCents: 0, ref: i.referenceId });
        return { orderId, status: 'COMPLETED', approveUrl: null, captureId, captureStatus: 'DECLINED' };
      }
      const captureId = rid('MOCKCAP');
      await this.state.put(orderId, 'order', { id: orderId, status: 'COMPLETED', totalCents: i.totalCents, captureId, captureStatus: 'COMPLETED', refundedCents: 0, ref: i.referenceId });
      await this.state.put(captureId, 'capture', { orderId });
      return { orderId, status: 'COMPLETED', approveUrl: null, captureId, captureStatus: 'COMPLETED' };
    });
  }
  async createOrderForApproval(i: CreateOrderInput & { returnUrl: string; cancelUrl: string; brandName: string }): Promise<OrderResult> {
    this.calls.push({ op: 'createOrderForApproval', args: i });
    return this.idem(i.requestId, 'order', async () => {
      const orderId = rid('MOCKORDER');
      await this.state.put(orderId, 'order', { id: orderId, status: 'PAYER_ACTION_REQUIRED', totalCents: i.totalCents, returnUrl: i.returnUrl, cancelUrl: i.cancelUrl, refundedCents: 0, ref: i.referenceId });
      return { orderId, status: 'PAYER_ACTION_REQUIRED', approveUrl: `${this.opts.baseUrl}/mock-paypal/approve-order?token=${orderId}`, captureId: null, captureStatus: null };
    });
  }
  async approveOrder(orderId: string, approve = true): Promise<string> {
    const o = await this.state.get(orderId);
    if (!o) throw new Error('unknown order');
    if (approve) { o.status = 'APPROVED'; await this.state.put(orderId, 'order', o); }
    const u = new URL(approve ? o.returnUrl : o.cancelUrl);
    u.searchParams.set('token', orderId);
    return u.toString();
  }
  async captureOrder(orderId: string, requestId: string): Promise<OrderResult> {
    this.calls.push({ op: 'captureOrder', args: { orderId, requestId } });
    const o = await this.state.get(orderId);
    if (!o) throw new Error('RESOURCE_NOT_FOUND');
    if (o.status === 'COMPLETED') return { orderId, status: 'COMPLETED', approveUrl: null, captureId: o.captureId, captureStatus: o.captureStatus };
    if (o.status !== 'APPROVED') throw new Error('ORDER_NOT_APPROVED');
    o.status = 'COMPLETED'; o.captureId = rid('MOCKCAP'); o.captureStatus = 'COMPLETED';
    await this.state.put(orderId, 'order', o);
    await this.state.put(o.captureId, 'capture', { orderId });
    return { orderId, status: 'COMPLETED', approveUrl: null, captureId: o.captureId, captureStatus: 'COMPLETED' };
  }
  async getOrder(orderId: string): Promise<OrderResult> {
    const o = await this.state.get(orderId);
    if (!o) throw new Error('RESOURCE_NOT_FOUND');
    return { orderId, status: o.status, approveUrl: o.status === 'PAYER_ACTION_REQUIRED' ? `${this.opts.baseUrl}/mock-paypal/approve-order?token=${orderId}` : null, captureId: o.captureId ?? null, captureStatus: o.captureStatus ?? null };
  }
  async refundCapture(captureId: string, cents: number | null, requestId: string, note: string): Promise<RefundResult> {
    this.calls.push({ op: 'refundCapture', args: { captureId, cents, requestId, note } });
    return this.idem(requestId, 'refund', async () => {
      const c = await this.state.get(captureId);
      if (!c) throw new Error('INVALID_CAPTURE_ID');
      const o = await this.state.get(c.orderId);
      const amount = cents ?? o.totalCents - o.refundedCents;
      if (amount <= 0 || o.refundedCents + amount > o.totalCents) throw new Error('REFUND_AMOUNT_EXCEEDED');
      o.refundedCents += amount;
      await this.state.put(o.id, 'order', o);
      return { refundId: rid('MOCKREFUND'), status: 'COMPLETED' };
    });
  }
  async createCatalogProduct(i: { requestId: string; name: string; description: string; category: string }) {
    this.calls.push({ op: 'createCatalogProduct', args: i });
    return this.idem(i.requestId, 'product', async () => ({ id: rid('PROD-MOCK') }));
  }
  async verifyWebhook(headers: Headers, _raw: string) {
    return !!this.opts.webhookSecret && headers.get('x-mock-signature') === this.opts.webhookSecret;
  }
}
