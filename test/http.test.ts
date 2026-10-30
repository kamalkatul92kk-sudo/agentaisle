// Worker HTTP surface: buyer pages, mandates, webhooks, merchant auth, REST mirror, simulator.
import { describe, it, expect, beforeEach } from 'vitest';
import { harness, BASE, WEBHOOK_SECRET, merchantHeaders, activeMandate, agent, type H } from './harness';
import { createCheckout, completeCheckout } from '../src/domain/checkout';

let h: H;
beforeEach(async () => { h = await harness(); });
type AnyRes = Omit<Response, 'json'> & { json(): Promise<any> };
const req = (path: string, init: RequestInit = {}) => h.fetch(new Request(`${BASE}${path}`, init)) as Promise<AnyRes>;
const json = (b: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
const agentH = { 'x-agent-id': 'agent-rest-1', 'x-agent-platform': 'curl' };

describe('HTTP', () => {
  it('health + public catalog never leak cost', async () => {
    expect((await (await req('/api/health')).json()).paypalMode).toBe('mock');
    const cat = await (await req('/api/catalog')).text();
    expect(cat).toContain('PP-SO-ETH-12');
    expect(cat).not.toMatch(/cost/i);
  });

  it('buyer-present mandate setup through the HTML pages', async () => {
    const r = await (await req('/api/mandates', json({ buyer_name: 'Ana', per_order_cap_cents: 6000, monthly_cap_cents: 15000 }))).json();
    expect(r.status).toBe('pending');
    const page = await (await req(new URL(r.approve_url).pathname + new URL(r.approve_url).search)).text();
    expect(page).toContain('MOCK PayPal');
    const form = new URLSearchParams({ id: new URL(r.approve_url).searchParams.get('approval_session_id')!, a: 'yes' });
    const redir = await req('/mock-paypal/approve-setup', { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(redir.status).toBe(302);
    const back = new URL(redir.headers.get('location')!);
    const done = await req(back.pathname + back.search);
    expect(await done.text()).toContain('PayPal saved');
    expect((await h.d.store.getMandate(r.mandate_id))!.status).toBe('active');
  });

  it('mandate caps above platform limits are refused', async () => {
    expect((await req('/api/mandates', json({ buyer_name: 'Ana', per_order_cap_cents: 900000, monthly_cap_cents: 900000 }))).status).toBe(400);
  });

  it('REST mirror: search, checkout, approval link, buyer pays on mock page, return captures', async () => {
    const s = await (await req('/api/agent/search?q=espresso', { headers: agentH })).json();
    expect(s.results.length).toBeGreaterThan(0);
    const co = await (await req('/api/agent/checkouts', json({ items: [{ sku: s.results[0].sku, qty: 1 }] }, agentH))).json();
    const done = await (await req(`/api/agent/checkouts/${co.checkout_id}/complete`, json({ payment_mode: 'approval_link', idempotency_key: 'rest-idem-01' }, agentH))).json();
    expect(done.status).toBe('requires_buyer_action');
    const u = new URL(done.approve_url);
    const redir = await req('/mock-paypal/approve-order', { method: 'POST', body: new URLSearchParams({ id: u.searchParams.get('token')!, a: 'yes' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const back = new URL(redir.headers.get('location')!);
    expect(back.pathname).toBe('/checkout/return');
    expect(await (await req(back.pathname + back.search)).text()).toContain('order is placed');
    expect((await (await req(`/api/agent/checkouts/${co.checkout_id}`, { headers: agentH })).json()).status).toBe('completed');
    expect((await req(`/api/agent/checkouts/${co.checkout_id}`, { headers: { 'x-agent-id': 'someone-else' } })).status).toBe(404);
  });

  it('webhooks: signature required, deduped, VAULT.PAYMENT-TOKEN.DELETED revokes mandate', async () => {
    const { mandate } = await activeMandate(h);
    const ev = { id: 'WH-1', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: mandate.vaultId } };
    expect((await req('/api/webhooks/paypal', json(ev))).status).toBe(401);
    const ok = await (await req('/api/webhooks/paypal', json(ev, { 'x-mock-signature': WEBHOOK_SECRET }))).json();
    expect(ok.duplicate).toBe(false);
    expect((await req('/api/webhooks/paypal', json(ev, { 'x-mock-signature': WEBHOOK_SECRET })).then((r) => r.json())).duplicate).toBe(true);
    expect((await h.d.store.getMandate(mandate.id))!.status).toBe('revoked');
  });

  it('webhook CHECKOUT.ORDER.APPROVED captures even if the buyer never returns to the site', async () => {
    const A = agent('agent-wh');
    const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-BL-HC-12', qty: 1 }] });
    const r = await completeCheckout(h.d, A, s.id, { payment_mode: 'approval_link', idempotency_key: 'wh-idem-0001' });
    await h.payments.approveOrder(r.paypalOrderId!);
    const out = await (await req('/api/webhooks/paypal', json({ id: 'WH-2', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: r.paypalOrderId } }, { 'x-mock-signature': WEBHOOK_SECRET }))).json();
    expect(out.sessionStatus).toBe('completed');
  });

  it('merchant API requires the bearer token', async () => {
    expect((await req('/api/merchant/dashboard')).status).toBe(401);
    expect((await req('/api/merchant/dashboard', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const d = await (await req('/api/merchant/dashboard', { headers: merchantHeaders })).json();
    expect(d.kpis).toBeDefined();
    expect(d.products.length).toBe(14);
  });

  it('simulator drives real MCP traffic and fills every dashboard widget', async () => {
    const sim = await (await req('/api/merchant/simulate', { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ sessions: 30, seed: 42 }) })).json();
    expect(sim.sessions).toBe(30);
    expect(sim.errors).toBe(0);
    expect(sim.completed).toBeGreaterThan(5);
    expect(sim.held).toBeGreaterThan(0); // velocity / new-agent holds
    expect(sim.deniedMandate).toBeGreaterThan(0); // forger persona refused
    const d = await (await req('/api/merchant/dashboard', { headers: merchantHeaders })).json();
    expect(d.kpis.completedOrders).toBe(sim.completed);
    expect(d.demandGaps.map((g: any) => g.query).join(' ')).toMatch(/oat|pod/);
    expect(d.funnel.length).toBeGreaterThan(3);
    expect((await (await req('/api/merchant/events?after=0', { headers: merchantHeaders })).json()).events.length).toBeGreaterThan(30);
    const ev = await (await req('/api/merchant/events?after=0&limit=5', { headers: merchantHeaders })).json();
    expect(ev.events).toHaveLength(5);
    const replay = await (await req(`/api/merchant/sessions/${d.sessions[0].id}/replay`, { headers: merchantHeaders })).json();
    expect(replay.events.length).toBeGreaterThan(0);
  });

  it('ops chat drafts a product from demand gaps; approving publishes it', async () => {
    await req('/api/merchant/simulate', { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ sessions: 20, seed: 7 }) });
    const chat = await (await req('/api/merchant/ops/chat', { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ message: 'what are agents searching for that we are missing? add a new product for it' }) })).json();
    const prop = chat.proposals.find((p: any) => p.kind === 'create_product');
    expect(prop).toBeTruthy();
    const dec = await (await req(`/api/merchant/approvals/${prop.id}/decide`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ decision: 'approve' }) })).json();
    expect(dec.status).toBe('executed');
    expect((await h.d.store.getProduct(dec.result.sku))!.paypalProductId).toMatch(/^PROD/);
  });
});
