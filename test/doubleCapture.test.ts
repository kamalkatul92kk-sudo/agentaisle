// Double-capture safety. On 2026-10-28 the real sandbox answered a second capture of COMPLETED order 1YE03627T73257805
// with 201 + the same single capture (no second charge). These tests pin the app's guard for both PayPal behaviours
// (201 echo and 422 ORDER_ALREADY_CAPTURED), the return-URL vs webhook race, and capture before approval.
import { describe, it, expect } from 'vitest';
import { PayPalRestGateway } from '../src/adapters/paypalRest';
// @ts-expect-error plain JS module
import { createFakePayPal } from '../scripts/fake-paypal.mjs';
import { harness, agent, type H } from './harness';
import { createCheckout, completeCheckout, captureApprovedOrder } from '../src/domain/checkout';

const BASE = 'http://fake-paypal.local';
function gw(recapture: 'error' | 'return-order') {
  const fake = createFakePayPal({ base: BASE, recapture });
  const calls: { method: string; path: string; requestId: string | null }[] = [];
  const f = ((u: any, i: any) => { const r = new Request(u, i); calls.push({ method: r.method, path: new URL(r.url).pathname, requestId: r.headers.get('paypal-request-id') }); return fake.handle(r); }) as typeof fetch;
  const g = new PayPalRestGateway({ clientId: 'fake-client', clientSecret: 'fake-secret', apiBase: BASE, fetch: f });
  return { fake, g, calls, captures: () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/capture')) };
}
async function approvalOrder(h: H, g: PayPalRestGateway, fake: any, id = 'agent-dc') {
  h.d.payments = g;
  const A = agent(id);
  const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-BL-HC-12', qty: 2 }] });
  const r = await completeCheckout(h.d, A, s.id, { payment_mode: 'approval_link', idempotency_key: `dc-${s.id}` });
  return { s: r, approve: () => fake.approve(r.approveUrl!) };
}

describe('double capture', () => {
  for (const mode of ['error', 'return-order'] as const) {
    it(`adapter: re-capturing a completed order returns the original capture (PayPal answers ${mode === 'error' ? '422 ORDER_ALREADY_CAPTURED' : '201 echo'})`, async () => {
      const h = await harness();
      const { fake, g } = gw(mode);
      const { s, approve } = await approvalOrder(h, g, fake);
      await approve();
      const first = await g.captureOrder(s.paypalOrderId!, 'req-1');
      const again = await g.captureOrder(s.paypalOrderId!, 'req-2-different');
      expect(first.captureStatus).toBe('COMPLETED');
      expect(again.captureId).toBe(first.captureId);
      expect(again.captureCount).toBe(1);
    });
  }

  it('domain: return URL and webhook racing capture once, record one payment, emit one payment.captured', async () => {
    const h = await harness();
    const { fake, g, captures } = gw('return-order');
    const { s, approve } = await approvalOrder(h, g, fake);
    await approve();
    const [a, b] = await Promise.all([captureApprovedOrder(h.d, s.paypalOrderId!), captureApprovedOrder(h.d, s.paypalOrderId!)]);
    expect(a.status).toBe('completed'); expect(b.status).toBe('completed');
    expect(a.captureId).toBe(b.captureId);
    const caps = captures();
    expect(new Set(caps.map((c) => c.requestId)).size).toBe(1); // stable PayPal-Request-Id per session
    expect(caps[0]!.requestId).toBe(`${s.id}-capture`);
    expect((await h.d.store.listPayments()).filter((p) => p.sessionId === s.id)).toHaveLength(1);
    expect((await h.d.store.listEvents({ sessionId: s.id })).filter((e) => e.type === 'payment.captured')).toHaveLength(1);
  });

  it('domain: an order already captured at PayPal (e.g. crash after capture) is reconciled without a second capture call', async () => {
    const h = await harness();
    const { fake, g, captures } = gw('error');
    const { s, approve } = await approvalOrder(h, g, fake);
    await approve();
    const direct = await g.captureOrder(s.paypalOrderId!, 'out-of-band'); // captured, but our DB never heard about it
    const n = captures().length;
    const done = await captureApprovedOrder(h.d, s.paypalOrderId!);
    expect(done.status).toBe('completed');
    expect(done.captureId).toBe(direct.captureId);
    expect(captures().length).toBe(n); // checked status first, did not POST /capture again
    expect((await h.d.store.listEvents({ sessionId: s.id })).some((e) => e.type === 'payment.capture_reconciled')).toBe(true);
  });

  it('domain: capture before buyer approval is refused without calling capture and without failing the session', async () => {
    const h = await harness();
    const { fake, g, captures } = gw('error');
    const { s } = await approvalOrder(h, g, fake);
    await expect(captureApprovedOrder(h.d, s.paypalOrderId!)).rejects.toMatchObject({ code: 'not_approved' });
    expect(captures()).toHaveLength(0);
    expect((await h.d.store.getSession(s.id))!.status).toBe('requires_buyer_action');
  });

  it('store: compare-and-set refuses a stale transition and a second payment row per session', async () => {
    const h = await harness();
    const s = await createCheckout(h.d, agent('agent-cas'), { items: [{ sku: 'PP-BL-HC-12', qty: 1 }] });
    expect(await h.d.store.updateSessionIfStatus({ ...s, status: 'canceled' }, 'open')).toBe(true);
    expect(await h.d.store.updateSessionIfStatus({ ...s, status: 'completed' }, 'open')).toBe(false);
    const p = { id: 'pay_1', sessionId: s.id, paypalOrderId: 'O1', captureId: 'C1', amountCents: 100, refundedCents: 0, status: 'completed' as const, createdAt: 'x', updatedAt: 'x' };
    expect(await h.d.store.insertPayment(p)).toBe(true);
    expect(await h.d.store.insertPayment({ ...p, id: 'pay_2', captureId: 'C2' })).toBe(false);
  });
});
