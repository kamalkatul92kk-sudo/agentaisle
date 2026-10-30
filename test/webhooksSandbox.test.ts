// Webhook handlers added for the sandbox deploy: ORDER.COMPLETED reconciles without a 2nd capture, CAPTURE.REFUNDED
// reconciles refunds made outside AgentAisle (PayPal dashboard) and credits the mandate back.
import { describe, it, expect, beforeEach } from 'vitest';
import { harness, BASE, WEBHOOK_SECRET, activeMandate, agent, type H } from './harness';
import { createCheckout, completeCheckout, refundSession } from '../src/domain/checkout';

let h: H;
beforeEach(async () => { h = await harness(); });
const hook = async (ev: unknown) => (await h.fetch(new Request(`${BASE}/api/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-signature': WEBHOOK_SECRET }, body: JSON.stringify(ev) }))).json() as Promise<any>;

async function paid() {
  const { token } = await activeMandate(h);
  const A = agent('agent-wh2');
  const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-BL-HC-12', qty: 1 }] });
  const r = await completeCheckout(h.d, A, s.id, { payment_mode: 'mandate', mandate_token: token, idempotency_key: 'wh2-idem-0001' });
  expect(r.status).toBe('completed');
  return { s: (await h.d.store.getSession(s.id))!, p: (await h.d.store.getPaymentBySession(s.id))! };
}
const refundEv = (id: string, captureId: string, total: string) => ({ id, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: `RF-${id}`, amount: { value: total }, seller_payable_breakdown: { total_refunded_amount: { value: total } }, links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] } });

describe('sandbox webhook handlers', () => {
  it('CHECKOUT.ORDER.COMPLETED for an already-captured order is a no-op reconcile tied to the session', async () => {
    const { s } = await paid();
    const out = await hook({ id: 'WH-OC-1', event_type: 'CHECKOUT.ORDER.COMPLETED', resource: { id: s.paypalOrderId } });
    expect(out).toMatchObject({ handled: true, sessionStatus: 'completed' });
    const evs = (await h.d.store.listEvents({ sessionId: s.id })).map((e: any) => e.type);
    expect(evs).toContain('webhook.CHECKOUT.ORDER.COMPLETED');
  });

  it('CHECKOUT.ORDER.COMPLETED for an unknown order is ignored safely', async () => {
    expect(await hook({ id: 'WH-OC-2', event_type: 'CHECKOUT.ORDER.COMPLETED', resource: { id: 'NOPE123' } })).toMatchObject({ handled: false, reason: 'unknown_order' });
  });

  it('PAYMENT.CAPTURE.REFUNDED after our own refund changes nothing', async () => {
    const { s, p } = await paid();
    await refundSession(h.d, s.id, null, 'test');
    const out = await hook(refundEv('WH-RF-1', p.captureId!, (p.amountCents / 100).toFixed(2)));
    expect(out).toMatchObject({ handled: true, reconciled: false, refundedCents: p.amountCents });
  });

  it('a late PAYMENT.CAPTURE.COMPLETED after a refund keeps the payment refunded', async () => {
    const { s, p } = await paid();
    await refundSession(h.d, s.id, null, 'test');
    await hook({ id: 'WH-CC-late', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: p.captureId } });
    expect((await h.d.store.getPaymentBySession(s.id))!.status).toBe('refunded');
  });

  it('PAYMENT.CAPTURE.REFUNDED from outside AgentAisle reconciles the payment and credits the mandate', async () => {
    const { s, p } = await paid();
    const before = await h.d.ledger.snapshot(s.mandateId!, h.clock.now().toISOString());
    const out = await hook(refundEv('WH-RF-2', p.captureId!, '5.00'));
    expect(out).toMatchObject({ handled: true, reconciled: true, refundedCents: 500 });
    const after = (await h.d.store.getPaymentBySession(s.id))!;
    expect(after.status).toBe('partially_refunded');
    expect((await h.d.ledger.snapshot(s.mandateId!, h.clock.now().toISOString())).spentCents).toBe(before.spentCents - 500);
  });
});
