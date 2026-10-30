// The real REST adapter, exercised end-to-end against the offline fake PayPal (same flows the sandbox will see).
import { describe, it, expect } from 'vitest';
import { PayPalRestGateway, PayPalApiError } from '../src/adapters/paypalRest';
// @ts-expect-error plain JS module
import { createFakePayPal } from '../scripts/fake-paypal.mjs';
import { harness, agent } from './harness';
import { createCheckout, completeCheckout, captureApprovedOrder, negotiate } from '../src/domain/checkout';
import { startMandate, finishMandate } from '../src/domain/mandates';

const BASE = 'http://fake-paypal.local';
function gw() {
  const fake = createFakePayPal({ base: BASE });
  const g = new PayPalRestGateway({ clientId: 'fake-client', clientSecret: 'fake-secret', apiBase: BASE, webhookId: 'WH-FAKE', fetch: ((u: any, i: any) => fake.handle(new Request(u, i))) as typeof fetch });
  return { fake, g };
}

describe('PayPalRestGateway vs fake PayPal', () => {
  it('bad credentials surface a PayPalApiError', async () => {
    const fake = createFakePayPal({ base: BASE });
    const g = new PayPalRestGateway({ clientId: 'x', clientSecret: 'y', apiBase: BASE, fetch: ((u: any, i: any) => fake.handle(new Request(u, i))) as typeof fetch });
    await expect(g.accessToken()).rejects.toBeInstanceOf(PayPalApiError);
  });

  it('vault: setup token -> buyer approves -> payment token -> buyer-absent charge -> refund', async () => {
    const { fake, g } = gw();
    const st = await g.createSetupToken({ requestId: 'r1', returnUrl: 'http://shop/return', cancelUrl: 'http://shop/cancel', description: 'd', brandName: 'b' });
    expect(st.status).toBe('PAYER_ACTION_REQUIRED');
    await expect(g.createPaymentToken({ requestId: 'r2', setupTokenId: st.setupTokenId })).rejects.toThrow(/not approved/i);
    await fake.approve(st.approveUrl);
    expect((await g.getSetupToken(st.setupTokenId)).status).toBe('APPROVED');
    const pt = await g.createPaymentToken({ requestId: 'r3', setupTokenId: st.setupTokenId });
    const order = { requestId: 'r4', referenceId: 'cs_1', totalCents: 3699, itemTotalCents: 3900, discountCents: 900, shippingCents: 699, description: 'x', lines: [{ name: 'Ethiopia', sku: 'PP-SO-ETH-12', qty: 2, unitCents: 1950 }] };
    const ch = await g.chargeVaulted({ ...order, vaultId: pt.vaultId });
    expect(ch.captureStatus).toBe('COMPLETED');
    const again = await g.chargeVaulted({ ...order, vaultId: pt.vaultId }); // same PayPal-Request-Id => same order
    expect(again.orderId).toBe(ch.orderId);
    const rf = await g.refundCapture(ch.captureId!, 1000, 'r5', 'sorry');
    expect(rf.status).toBe('COMPLETED');
  });

  it('domain checkout totals always produce a breakdown PayPal accepts', async () => {
    const h = await harness();
    const { fake, g } = gw();
    h.d.payments = g; // swap the mock for the REST adapter
    const A = agent('agent-rest');
    for (const items of [[{ sku: 'PP-SO-ETH-12', qty: 3 }], [{ sku: 'PP-BL-HC-12', qty: 5 }, { sku: 'PP-GR-FILT-100', qty: 1 }], [{ sku: 'PP-RS-PAN-8', qty: 1 }]]) {
      const s = await createCheckout(h.d, A, { items });
      const n = await negotiate(h.d, A, s.id, 100);
      if (!n.final) await negotiate(h.d, A, s.id, n.merchant_price_cents);
      const r = await completeCheckout(h.d, A, s.id, { payment_mode: 'approval_link', idempotency_key: `rest-${s.id}` });
      expect(r.status).toBe('requires_buyer_action');
      await fake.approve(r.approveUrl!);
      expect((await captureApprovedOrder(h.d, r.paypalOrderId!)).status).toBe('completed');
    }
    // and the vault flow through the domain layer
    const m = await startMandate(h.d, { buyerName: 'B', perOrderCapCents: 10000, monthlyCapCents: 20000 });
    await fake.approve(m.approveUrl);
    await finishMandate(h.d, m.mandate.id);
    const s = await createCheckout(h.d, agent('agent-rest-2'), { items: [{ sku: 'PP-SO-COL-12', qty: 1 }] });
    expect((await completeCheckout(h.d, agent('agent-rest-2'), s.id, { payment_mode: 'mandate', mandate_token: m.mandateToken, idempotency_key: 'rest-vault-1' })).status).toBe('completed');
  });
});

describe('PayPalRestGateway transport + webhook verification hardening', () => {
  const tokenRes = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
  function stub(handler: (url: string, init: any) => Response) {
    const calls: { url: string; init: any }[] = [];
    const f = (async (u: any, i: any) => { calls.push({ url: String(u), init: i }); return String(u).endsWith('/v1/oauth2/token') ? tokenRes() : handler(String(u), i); }) as typeof fetch;
    return { calls, g: new PayPalRestGateway({ clientId: 'c', clientSecret: 's', apiBase: 'http://pp', webhookId: 'WH-1', fetch: f }) };
  }
  const sigHeaders = () => new Headers({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-10-28T00:00:00Z' });

  it('a non-JSON gateway error becomes a PayPalApiError (not a SyntaxError)', async () => {
    const { g } = stub(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const e = await g.getOrder('X').catch((x) => x);
    expect(e).toBeInstanceOf(PayPalApiError);
    expect(e.status).toBe(502);
  });

  it('a 401 on a cached token refreshes the token and retries once', async () => {
    let n = 0;
    const { calls, g } = stub(() => (++n === 1 ? new Response('{"error":"invalid_token"}', { status: 401 }) : new Response(JSON.stringify({ id: 'O1', status: 'CREATED' }), { status: 200 })));
    expect((await g.getOrder('O1')).orderId).toBe('O1');
    expect(calls.filter((c) => c.url.endsWith('/v1/oauth2/token')).length).toBe(2);
  });

  it('webhook without PayPal signature headers is rejected without calling PayPal', async () => {
    const { calls, g } = stub(() => new Response('{}', { status: 200 }));
    expect(await g.verifyWebhook(new Headers(), '{"id":"WH-EVT"}')).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('webhook event is forwarded to PayPal byte-for-byte, and a PayPal 400 means "not verified"', async () => {
    const raw = '{"id":"WH-EVT","resource":{"amount":{"value":"10.00"},"n":1.50,"note":"caf\\u00e9"}}';
    const { calls, g } = stub((_u, i) => { expect(String(i.body).endsWith(`"webhook_event":${raw}}`)).toBe(true); return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 }); });
    expect(await g.verifyWebhook(sigHeaders(), raw)).toBe(true);
    expect(JSON.parse(calls[1]!.init.body).webhook_id).toBe('WH-1');
    const bad = stub(() => new Response(JSON.stringify({ name: 'VALIDATION_ERROR' }), { status: 400 }));
    expect(await bad.g.verifyWebhook(sigHeaders(), raw)).toBe(false);
  });
});

describe('PayPalRestGateway runtime binding', () => {
  it('calls the global fetch unbound (workerd throws Illegal invocation otherwise)', async () => {
    const fake = createFakePayPal({ base: 'http://fake-paypal.local' });
    const real = globalThis.fetch;
    globalThis.fetch = function (this: unknown, i: any, init?: any) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      return fake.handle(new Request(i, init));
    } as typeof fetch;
    try {
      const g = new PayPalRestGateway({ clientId: 'fake-client', clientSecret: 'fake-secret', apiBase: 'http://fake-paypal.local' });
      await expect(g.getOrder('NOPE')).rejects.not.toThrow(/Illegal invocation/);
    } finally { globalThis.fetch = real; }
  });
});
