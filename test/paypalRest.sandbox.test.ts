// Opt-in probe of the REST adapter against the REAL PayPal sandbox (no buyer needed).
// Runs only with PAYPAL_SANDBOX_PROBE=1 plus PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET in the environment. Never logs secrets.
import { describe, it, expect } from 'vitest';
import { PayPalRestGateway, PayPalApiError } from '../src/adapters/paypalRest';

const env = process.env;
const on = env.PAYPAL_SANDBOX_PROBE === '1' && !!env.PAYPAL_CLIENT_ID && !!env.PAYPAL_CLIENT_SECRET;
const apiBase = env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
const out: Record<string, unknown> = {};

describe.skipIf(!on)('PayPalRestGateway vs REAL sandbox (no buyer)', () => {
  if (on && !/sandbox\.paypal\.com$/.test(new URL(apiBase).host)) throw new Error('sandbox only');
  const g = new PayPalRestGateway({ clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET!, apiBase });
  const rid = (s: string) => `probe-${s}-${Date.now()}`;
  const order = { referenceId: 'probe_cs_1', totalCents: 3699, itemTotalCents: 3900, discountCents: 900, shippingCents: 699, description: 'AgentAisle adapter probe', lines: [{ name: 'Ethiopia Guji Natural 12oz', sku: 'PP-SO-ETH-12', qty: 2, unitCents: 1950 }] };

  it('setup token is created and readable', async () => {
    const st = await g.createSetupToken({ requestId: rid('st'), returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c', description: 'probe', brandName: 'Pecan Plume Coffee Co.' });
    out.setupToken = st;
    expect(st.status).toBe('PAYER_ACTION_REQUIRED');
    expect(st.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect((await g.getSetupToken(st.setupTokenId)).status).toBe('PAYER_ACTION_REQUIRED');
    const err = await g.createPaymentToken({ requestId: rid('pt'), setupTokenId: st.setupTokenId }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    out.paymentTokenBeforeApproval = { status: err.status, debugId: err.debugId, issue: err.body?.details?.[0]?.issue };
  });

  it('approval order: create, read, early capture refused', async () => {
    const o = await g.createOrderForApproval({ ...order, requestId: rid('o'), returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c', brandName: 'Pecan Plume Coffee Co.' });
    out.approvalOrder = o;
    expect(o.status).toBe('PAYER_ACTION_REQUIRED');
    expect(o.approveUrl).toMatch(/sandbox\.paypal\.com/);
    expect((await g.getOrder(o.orderId)).status).toBe('PAYER_ACTION_REQUIRED');
    const err = await g.captureOrder(o.orderId, rid('cap')).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    out.earlyCapture = { status: err.status, issue: err.body?.details?.[0]?.issue };
  });

  it('bogus vault id is rejected as a PayPalApiError (not a crash)', async () => {
    const err = await g.chargeVaulted({ ...order, requestId: rid('v'), vaultId: 'NOTAREALVAULTID' }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    out.bogusVault = { status: err.status, issue: err.body?.details?.[0]?.issue };
  });

  it('webhook verify with a forged signature returns false against real PayPal (no throw)', async () => {
    const wg = new PayPalRestGateway({ clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET!, apiBase, webhookId: env.PAYPAL_WEBHOOK_ID || '1AB23456CD789012E' });
    const h = new Headers({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270', 'paypal-transmission-id': '00000000-0000-0000-0000-000000000000', 'paypal-transmission-sig': 'Zm9yZ2Vk', 'paypal-transmission-time': new Date().toISOString() });
    const ok = await wg.verifyWebhook(h, JSON.stringify({ id: 'WH-PROBE', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'X' } }));
    out.forgedWebhookVerified = ok;
    expect(ok).toBe(false);
  });

  it('report', () => { console.log(JSON.stringify(out, null, 2)); });
});
