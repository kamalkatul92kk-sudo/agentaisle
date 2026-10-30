import { describe, it, expect, beforeEach } from 'vitest';
import { harness, agent, activeMandate, type H } from './harness';
import { createCheckout, negotiate, completeCheckout, updateCheckout, captureApprovedOrder, cancelCheckout, agentView } from '../src/domain/checkout';
import { askForRound } from '../src/domain/pricing';

let h: H;
beforeEach(async () => { h = await harness(); });
const A = agent('agent-alpha');

describe('checkout lifecycle (sql.js D1 + mock PayPal)', () => {
  it('mandate path: create -> negotiate -> buyer-absent vault charge -> completed', async () => {
    const { token } = await activeMandate(h);
    const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-SO-ETH-12', qty: 2 }] });
    expect(s.totalCents).toBe(2 * 1950 + 699);
    const n1 = await negotiate(h.d, A, s.id, 3000);
    expect(n1.decision).toBe('counter');
    const n2 = await negotiate(h.d, A, s.id, n1.merchant_price_cents);
    expect(n2.decision).toBe('accept');
    expect(n2.session.negotiatedDiscountCents).toBeGreaterThan(0);
    const before = (await h.d.store.getProduct('PP-SO-ETH-12'))!.stock;
    const done = await completeCheckout(h.d, A, s.id, { payment_mode: 'mandate', mandate_token: token, idempotency_key: 'idem-0001' });
    expect(done.status).toBe('completed');
    expect(done.captureId).toBeTruthy();
    expect((await h.d.store.getProduct('PP-SO-ETH-12'))!.stock).toBe(before - 2);
    const charge = h.payments.calls.find((c) => c.op === 'chargeVaulted')!.args as any;
    expect(charge.totalCents).toBe(done.totalCents);
    expect(charge.itemTotalCents - charge.discountCents + charge.shippingCents).toBe(done.totalCents); // PayPal breakdown consistency
    expect((await h.d.store.getPaymentBySession(s.id))!.amountCents).toBe(done.totalCents);
  });

  it('approval-link fallback: requires_buyer_action -> buyer approves -> capture', async () => {
    const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-BL-HC-12', qty: 1 }] });
    const r = await completeCheckout(h.d, A, s.id, { payment_mode: 'approval_link', idempotency_key: 'idem-0002' });
    expect(r.status).toBe('requires_buyer_action');
    expect(agentView(r).approve_url).toContain('/mock-paypal/approve-order');
    await h.payments.approveOrder(r.paypalOrderId!);
    const done = await captureApprovedOrder(h.d, r.paypalOrderId!);
    expect(done.status).toBe('completed');
    expect((await captureApprovedOrder(h.d, r.paypalOrderId!)).status).toBe('completed'); // idempotent
    expect(h.payments.calls.filter((c) => c.op === 'captureOrder').length).toBe(1);
  });

  it('cart update voids an agreed price', async () => {
    const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-SO-COL-12', qty: 3 }] });
    const q1 = await negotiate(h.d, A, s.id, 100);
    await negotiate(h.d, A, s.id, q1.merchant_price_cents);
    const u = await updateCheckout(h.d, A, s.id, { items: [{ sku: 'PP-SO-COL-12', qty: 4 }] });
    expect(u.negotiation.agreedTotalBeforeShippingCents).toBeNull();
    expect(u.negotiatedDiscountCents).toBe(0);
  });

  it('declined vault charge fails cleanly and restores stock + ledger', async () => {
    const { token, mandate } = await activeMandate(h);
    const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-SO-KEN-12', qty: 1 }] });
    const before = (await h.d.store.getProduct('PP-SO-KEN-12'))!.stock;
    h.payments.declineNextCharge = true;
    const r = await completeCheckout(h.d, A, s.id, { payment_mode: 'mandate', mandate_token: token, idempotency_key: 'idem-0003' });
    expect(r.status).toBe('failed');
    expect((await h.d.store.getProduct('PP-SO-KEN-12'))!.stock).toBe(before);
    const snap = await h.d.ledger.snapshot(mandate.id, h.clock.now().toISOString());
    expect(snap.spentCents + snap.reservedCents).toBe(0);
  });

  it('cancel works only while open', async () => {
    const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-BL-HC-12', qty: 1 }] });
    expect((await cancelCheckout(h.d, A, s.id)).status).toBe('canceled');
    await expect(cancelCheckout(h.d, A, s.id)).rejects.toMatchObject({ code: 'not_open' });
  });

  it('reserve SKU is not negotiable', async () => {
    const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-RS-PAN-8', qty: 1 }] });
    const r = await negotiate(h.d, A, s.id, 3000);
    expect(r.decision).toBe('reject');
    expect(r.session.totalCents).toBe(4800 + 699);
  });
});
