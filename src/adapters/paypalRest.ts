// Real PayPal REST adapter (sandbox by default). Orders v2 + Vault v3 + Payments v2 + Catalog v1 + webhook verification.
import type { CreateOrderInput, OrderResult, PaymentsGateway, PaymentTokenResult, RefundResult, SetupTokenResult } from '../ports';
import { linkOf, purchaseUnit } from './paypalShared';
import { toValue } from '../domain/money';

export interface PayPalRestConfig { clientId: string; clientSecret: string; apiBase: string; webhookId?: string; fetch?: typeof fetch }

export class PayPalApiError extends Error {
  constructor(public status: number, public body: unknown, public debugId: string | null) { super(`PayPal API ${status}${debugId ? ` (debug_id ${debugId})` : ''}: ${JSON.stringify(body).slice(0, 400)}`); }
}

/** First `details[].issue` of a PayPal error body, e.g. ORDER_ALREADY_CAPTURED. */
export const issueOf = (body: unknown): string | null => ((body as any)?.details?.[0]?.issue as string | undefined) ?? null;

export class PayPalRestGateway implements PaymentsGateway {
  readonly mode = 'sandbox' as const;
  private token: { value: string; exp: number } | null = null;
  constructor(private cfg: PayPalRestConfig) {}
  // Never call the global fetch as a method (this.f(...)): workerd throws "Illegal invocation" when fetch's `this` is not
  // the global scope. Node tolerates it, so only the wrangler sandbox run caught this.
  private get f(): typeof fetch { const f = this.cfg.fetch; return f ? (i, init) => f(i, init) : (i, init) => fetch(i, init); }

  async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const basic = btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`);
    const res = await this.f(`${this.cfg.apiBase}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new PayPalApiError(res.status, body, res.headers.get('paypal-debug-id'));
    this.token = { value: body.access_token, exp: Date.now() + Number(body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  async call<T = any>(method: string, path: string, body?: unknown, requestId?: string, opts: { rawJson?: string } = {}): Promise<T> {
    const send = async () => {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json', prefer: 'return=representation' };
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      return this.f(`${this.cfg.apiBase}${path}`, { method, headers, body: opts.rawJson ?? (body === undefined ? undefined : JSON.stringify(body)) });
    };
    let res = await send();
    // A cached token can be revoked or expire early on PayPal's side: drop it and retry once.
    if (res.status === 401) { this.token = null; res = await send(); }
    const text = await res.text();
    let parsed: any = {};
    // PayPal edge/gateway errors (502/503, HTML maintenance pages) are not JSON: surface them as PayPalApiError, not SyntaxError.
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = { name: 'NON_JSON_RESPONSE', message: text.slice(0, 200) }; } }
    if (!res.ok) throw new PayPalApiError(res.status, parsed, res.headers.get('paypal-debug-id') ?? parsed.debug_id ?? null);
    if (text && parsed.name === 'NON_JSON_RESPONSE') throw new PayPalApiError(res.status, parsed, res.headers.get('paypal-debug-id'));
    return parsed as T;
  }

  async createSetupToken(i: { requestId: string; returnUrl: string; cancelUrl: string; description: string; brandName: string }): Promise<SetupTokenResult> {
    const r = await this.call('POST', '/v3/vault/setup-tokens', {
      payment_source: { paypal: { description: i.description, permit_multiple_payment_tokens: false, usage_pattern: 'IMMEDIATE', usage_type: 'MERCHANT', customer_type: 'CONSUMER',
        experience_context: { shipping_preference: 'NO_SHIPPING', brand_name: i.brandName, locale: 'en-US', return_url: i.returnUrl, cancel_url: i.cancelUrl } } },
    }, i.requestId);
    return { setupTokenId: r.id, status: r.status, approveUrl: linkOf(r.links, 'approve') ?? '', customerId: r.customer?.id ?? null };
  }
  async getSetupToken(id: string) { const r = await this.call('GET', `/v3/vault/setup-tokens/${encodeURIComponent(id)}`); return { status: r.status as string }; }
  async createPaymentToken(i: { requestId: string; setupTokenId: string }): Promise<PaymentTokenResult> {
    const r = await this.call('POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: i.setupTokenId, type: 'SETUP_TOKEN' } } }, i.requestId);
    return { vaultId: r.id, customerId: r.customer?.id ?? null, payerEmail: r.payment_source?.paypal?.email_address ?? null };
  }

  private toOrder(r: any): OrderResult {
    const caps: any[] = r.purchase_units?.flatMap((u: any) => u.payments?.captures ?? []) ?? [];
    const cap = caps[0];
    return { orderId: r.id, status: r.status, approveUrl: linkOf(r.links, 'payer-action', 'approve'), captureId: cap?.id ?? null, captureStatus: cap?.status ?? null, captureCount: caps.length };
  }
  async chargeVaulted(i: CreateOrderInput & { vaultId: string }) {
    return this.toOrder(await this.call('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [purchaseUnit(i)], payment_source: { paypal: { vault_id: i.vaultId } } }, i.requestId));
  }
  async createOrderForApproval(i: CreateOrderInput & { returnUrl: string; cancelUrl: string; brandName: string }) {
    return this.toOrder(await this.call('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE', purchase_units: [purchaseUnit(i)],
      payment_source: { paypal: { experience_context: { user_action: 'PAY_NOW', brand_name: i.brandName, locale: 'en-US', shipping_preference: 'GET_FROM_FILE', return_url: i.returnUrl, cancel_url: i.cancelUrl } } },
    }, i.requestId));
  }
  /**
   * Capture an approved order. Double-capture safe:
   * - the caller passes a stable PayPal-Request-Id per checkout, so a retried request replays PayPal's first response;
   * - if the order is already captured, PayPal either answers 201 with the existing COMPLETED order (observed in the sandbox,
   *   order 1YE03627T73257805) or 422 ORDER_ALREADY_CAPTURED. Both are folded into "return the existing capture".
   */
  async captureOrder(orderId: string, requestId: string) {
    try {
      return this.toOrder(await this.call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId));
    } catch (e) {
      if (e instanceof PayPalApiError && e.status === 422 && issueOf(e.body) === 'ORDER_ALREADY_CAPTURED') return this.getOrder(orderId);
      throw e;
    }
  }
  async getOrder(orderId: string) { return this.toOrder(await this.call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`)); }
  async refundCapture(captureId: string, cents: number | null, requestId: string, note: string): Promise<RefundResult> {
    const body: any = { note_to_payer: note.slice(0, 255) };
    if (cents != null) body.amount = { currency_code: 'USD', value: toValue(cents) };
    const r = await this.call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body, requestId);
    return { refundId: r.id, status: r.status };
  }
  async createCatalogProduct(i: { requestId: string; name: string; description: string; category: string }) {
    const r = await this.call('POST', '/v1/catalogs/products', { name: i.name.slice(0, 127), description: i.description.slice(0, 256), type: 'PHYSICAL', category: i.category }, i.requestId);
    return { id: r.id as string };
  }
  async verifyWebhook(headers: Headers, rawBody: string) {
    if (!this.cfg.webhookId) return false;
    const h = (k: string) => headers.get(k);
    const fields = { auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'), transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time') };
    // Unsigned or partially signed requests are simply not verified (401 upstream), not a PayPal 400 that bubbles up as a 500.
    if (Object.values(fields).some((v) => !v)) return false;
    try { JSON.parse(rawBody); } catch { return false; }
    // Splice the raw body in verbatim: re-serialising a parsed event can change it (number formatting, unicode escapes)
    // and make PayPal report FAILURE for a genuine webhook.
    const prefix = JSON.stringify({ ...fields, webhook_id: this.cfg.webhookId });
    const rawJson = `${prefix.slice(0, -1)},"webhook_event":${rawBody}}`;
    try {
      const r = await this.call('POST', '/v1/notifications/verify-webhook-signature', undefined, undefined, { rawJson });
      return r.verification_status === 'SUCCESS';
    } catch (e) {
      if (e instanceof PayPalApiError && e.status >= 400 && e.status < 500) return false;
      throw e;
    }
  }
}
