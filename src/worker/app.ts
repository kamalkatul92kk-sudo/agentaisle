// HTTP surface: MCP + REST for buyer agents, buyer-facing PayPal return pages, webhooks, merchant APIs, mock PayPal pages.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AgentCtx, Deps } from '../domain/deps';
import { handleMcpRequest } from '../mcp/server';
import { agentSearch, seedCatalogIfEmpty } from '../domain/catalogService';
import { agentView, cancelBuyerAction, captureApprovedOrder, completeCheckout, createCheckout, getOwnSession, negotiate, updateCheckout } from '../domain/checkout';
import { finishMandate, mandateView, revokeMandate, startMandate } from '../domain/mandates';
import { decideApproval } from '../domain/approvals';
import { handleWebhook } from '../domain/webhooks';
import { buildDashboard, eventRows } from '../domain/dashboard';
import { runOpsAgent } from '../agents/opsAgent';
import { runSimulation } from '../sim/simulator';
import { setTrust, AGENT_ID_RE } from '../domain/agents';
import { DomainError } from '../domain/types';
import { MockPayPalGateway } from '../adapters/paypalMock';
import { esc, page } from './html';
import { fmt } from '../domain/money';

export interface Runtime {
  deps: Deps;
  merchantToken?: string;
  demoMode: boolean;
  simSecret: string;
  simVaultId?: string;
  simSessionsPerTick: number;
}
type Env = { Variables: { rt: Runtime } };

function agentCtx(c: Context<Env>): AgentCtx {
  const id = c.req.header('x-agent-id') ?? '';
  if (!AGENT_ID_RE.test(id)) throw new DomainError('agent_id_required', 'Send an x-agent-id header (3-64 chars: letters, digits, . _ : -)', 401);
  const platform = (c.req.header('x-agent-platform') ?? 'unknown').slice(0, 60);
  const name = (c.req.header('x-agent-name') ?? id).slice(0, 80);
  return { agentId: id, platform, displayName: name };
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

let seeded = new WeakSet<object>();
export function resetSeedCache() { seeded = new WeakSet(); }

export function createApp(resolve: (c: Context<Env>) => Runtime | Promise<Runtime>) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const rt = await resolve(c);
    c.set('rt', rt);
    if (!seeded.has(rt.deps.store)) { await seedCatalogIfEmpty(rt.deps); seeded.add(rt.deps.store); }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.code, message: err.message }, err.status as any);
    if (err instanceof z.ZodError) return c.json({ error: 'invalid_request', issues: err.issues.slice(0, 5) }, 400);
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  const D = (c: Context<Env>) => c.get('rt').deps;

  app.get('/api/health', (c) => c.json({ ok: true, paypalMode: D(c).payments.mode, demoMode: c.get('rt').demoMode, merchant: D(c).config.merchantName, location: 'Texas', llm: D(c).llm.name, time: D(c).clock.now().toISOString() }));
  app.get('/api/catalog', async (c) => c.json({ products: (await D(c).store.listProducts()).map((p) => ({ sku: p.sku, name: p.name, category: p.category, roast: p.roast, price_cents: p.priceCents, in_stock: p.stock > 0 })) }));

  // ---------------- Buyer agents: MCP ----------------
  app.post('/mcp', async (c) => handleMcpRequest(D(c), agentCtx(c), c.req.raw));
  app.on(['GET', 'DELETE'], '/mcp', (c) => c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null }, 405));

  // ---------------- Buyer agents: REST mirror of the MCP tools ----------------
  const itemsSchema = z.array(z.object({ sku: z.string(), qty: z.number().int() })).min(1);
  app.get('/api/agent/search', async (c) => c.json({ results: await agentSearch(D(c), agentCtx(c), c.req.query('q') ?? '', { roast: c.req.query('roast') as any, category: c.req.query('category') as any, maxPriceCents: c.req.query('max_price_cents') ? Number(c.req.query('max_price_cents')) : undefined }) }));
  app.post('/api/agent/checkouts', async (c) => { const b = z.object({ items: itemsSchema, buyer_note: z.string().max(500).optional() }).parse(await c.req.json()); return c.json(agentView(await createCheckout(D(c), agentCtx(c), b)), 201); });
  app.get('/api/agent/checkouts/:id', async (c) => c.json(agentView(await getOwnSession(D(c), agentCtx(c), c.req.param('id')))));
  app.put('/api/agent/checkouts/:id', async (c) => { const b = z.object({ items: itemsSchema, buyer_note: z.string().max(500).optional() }).parse(await c.req.json()); return c.json(agentView(await updateCheckout(D(c), agentCtx(c), c.req.param('id'), b))); });
  app.post('/api/agent/checkouts/:id/negotiate', async (c) => { const b = z.object({ offer_cents: z.number().int().positive() }).parse(await c.req.json()); const r = await negotiate(D(c), agentCtx(c), c.req.param('id'), b.offer_cents); return c.json({ decision: r.decision, merchant_price_cents: r.merchant_price_cents, message: r.message, final: r.final, checkout: agentView(r.session) }); });
  app.post('/api/agent/checkouts/:id/complete', async (c) => {
    const b = z.object({ payment_mode: z.enum(['mandate', 'approval_link']), mandate_token: z.string().optional(), idempotency_key: z.string().min(8).max(100) }).parse(await c.req.json());
    return c.json(agentView(await completeCheckout(D(c), agentCtx(c), c.req.param('id'), b)));
  });

  // ---------------- Buyer (human, present): mandate setup ----------------
  app.post('/api/mandates', async (c) => {
    const b = z.object({ buyer_name: z.string().min(1).max(80), buyer_email: z.string().email().optional(), per_order_cap_cents: z.number().int(), monthly_cap_cents: z.number().int(), allowed_categories: z.array(z.enum(['single_origin', 'blend', 'reserve', 'gear'])).optional(), ttl_days: z.number().int().optional() }).parse(await c.req.json());
    const r = await startMandate(D(c), { buyerName: b.buyer_name, buyerEmail: b.buyer_email, perOrderCapCents: b.per_order_cap_cents, monthlyCapCents: b.monthly_cap_cents, allowedCategories: b.allowed_categories, ttlDays: b.ttl_days });
    return c.json({ mandate_id: r.mandate.id, status: r.mandate.status, approve_url: r.approveUrl, mandate_token: r.mandateToken, note: 'Give mandate_token to your shopping agent. It only works after you approve on PayPal, within your caps.' }, 201);
  });
  app.get('/mandates/return', async (c) => {
    const id = c.req.query('mandate') ?? '';
    try {
      const m = await finishMandate(D(c), id);
      const v = await mandateView(D(c), m);
      return c.html(page('PayPal saved', `<div class="card"><h1>PayPal saved for agent purchases</h1><p>Your agent can now buy from ${esc(D(c).config.merchantName)} without asking you each time, up to <b>${fmt(v.perOrderCapCents)}</b> per order and <b>${fmt(v.monthlyCapCents)}</b> per month, until ${esc(v.expiresAt.slice(0, 10))}.</p><p>Mandate: <code>${esc(m.id)}</code></p></div>`));
    } catch (e) {
      return c.html(page('Not completed', `<div class="card"><h1>Setup not completed</h1><p>${esc((e as Error).message)}</p></div>`), 400);
    }
  });
  app.get('/mandates/cancel', (c) => c.html(page('Canceled', '<div class="card"><h1>No changes made</h1><p>You canceled saving PayPal. Your agent cannot charge you.</p></div>')));

  // ---------------- Buyer (human): per-order approval return ----------------
  app.get('/checkout/return', async (c) => {
    const token = c.req.query('token') ?? '';
    try {
      const s = await captureApprovedOrder(D(c), token);
      return c.html(page('Order placed', `<div class="card"><h1>${s.status === 'completed' ? 'Thanks! Your order is placed.' : `Order status: ${esc(s.status)}`}</h1><p>${esc(s.items.map((i) => `${i.qty}× ${i.name}`).join(', '))}</p><p>Total paid: <b>${fmt(s.totalCents)}</b></p><p>You can close this tab; your agent will see the update.</p></div>`));
    } catch (e) {
      return c.html(page('Problem', `<div class="card"><h1>We couldn't complete the order</h1><p>${esc((e as Error).message)}</p></div>`), 400);
    }
  });
  app.get('/checkout/cancel', async (c) => { await cancelBuyerAction(D(c), c.req.query('token') ?? ''); return c.html(page('Canceled', '<div class="card"><h1>Order canceled</h1><p>Nothing was charged.</p></div>')); });

  // ---------------- PayPal webhooks ----------------
  app.post('/api/webhooks/paypal', async (c) => c.json(await handleWebhook(D(c), c.req.raw.headers, await c.req.text())));

  // ---------------- Mock PayPal approval pages (mock mode only) ----------------
  const mock = (c: Context<Env>) => { const p = D(c).payments; if (!(p instanceof MockPayPalGateway)) throw new DomainError('not_found', 'Not found', 404); return p; };
  app.get('/mock-paypal/approve-setup', (c) => { mock(c); const id = esc(c.req.query('approval_session_id')); return c.html(page('Mock PayPal', `<p class="mock">MOCK PayPal (no real PayPal account, no money). Sandbox mode shows the real PayPal page here.</p><div class="card"><h1>Save PayPal with ${esc(D(c).config.merchantName)}?</h1><p>This lets the merchant charge your PayPal later, when your agent buys within your limits.</p><form method="post"><input type="hidden" name="id" value="${id}"><button class="yes" name="a" value="yes">Agree and Continue</button><button class="no" name="a" value="no">Cancel</button></form></div>`)); });
  app.post('/mock-paypal/approve-setup', async (c) => { const f = await c.req.parseBody(); return c.redirect(await mock(c).approveSetupToken(String(f.id), f.a === 'yes')); });
  app.get('/mock-paypal/approve-order', async (c) => { const p = mock(c); const id = c.req.query('token') ?? ''; const o = await p.getOrder(id); const s = await D(c).store.getSessionByOrderId(id); return c.html(page('Mock PayPal', `<p class="mock">MOCK PayPal (no real PayPal account, no money).</p><div class="card"><h1>Pay ${esc(D(c).config.merchantName)}</h1><p>${esc(s?.items.map((i) => `${i.qty}× ${i.name}`).join(', ') ?? '')}</p><p>Total <b>${fmt(s?.totalCents ?? 0)}</b> (${esc(o.status)})</p><form method="post"><input type="hidden" name="id" value="${esc(id)}"><button class="yes" name="a" value="yes">Pay Now</button><button class="no" name="a" value="no">Cancel</button></form></div>`)); });
  app.post('/mock-paypal/approve-order', async (c) => { const f = await c.req.parseBody(); return c.redirect(await mock(c).approveOrder(String(f.id), f.a === 'yes')); });

  // ---------------- Merchant APIs (authenticated) ----------------
  app.use('/api/merchant/*', async (c, next) => {
    const rt = c.get('rt');
    // DEMO_MODE (public deployment): anyone may READ the control room; every action (simulate, approve, refund, reset,
    // revoke, trust, ops chat) still needs the merchant token.
    if (rt.demoMode && c.req.method === 'GET') return next();
    if (!rt.merchantToken) return c.json({ error: 'merchant_token_not_configured' }, 503);
    const got = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(got, rt.merchantToken)) return c.json({ error: 'unauthorized' }, 401);
    return next();
  });
  app.get('/api/merchant/dashboard', async (c) => c.json(await buildDashboard(D(c), Number(c.req.query('window_hours') ?? 24 * 30))));
  app.get('/api/merchant/events', async (c) => c.json({ events: await eventRows(D(c), { afterId: Number(c.req.query('after') ?? 0), limit: Math.min(500, Number(c.req.query('limit') ?? 200)) }) }));
  app.get('/api/merchant/sessions/:id/replay', async (c) => {
    const s = await D(c).store.getSession(c.req.param('id'));
    if (!s) throw new DomainError('not_found', 'Unknown session', 404);
    return c.json({ session: s, events: await eventRows(D(c), { sessionId: s.id, limit: 500 }), payment: await D(c).store.getPaymentBySession(s.id) });
  });
  app.get('/api/merchant/approvals', async (c) => c.json({ approvals: await D(c).store.listApprovals({ status: (c.req.query('status') as any) || undefined }) }));
  app.post('/api/merchant/approvals/:id/decide', async (c) => { const b = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(300).optional() }).parse(await c.req.json()); return c.json(await decideApproval(D(c), c.req.param('id'), b.decision, 'merchant', b.note)); });
  app.post('/api/merchant/ops/chat', async (c) => { const b = z.object({ message: z.string().min(1).max(2000) }).parse(await c.req.json()); return c.json(await runOpsAgent(D(c), b.message)); });
  app.post('/api/merchant/agents/:id/trust', async (c) => { const b = z.object({ trust: z.enum(['new', 'known', 'blocked']) }).parse(await c.req.json()); return c.json(await setTrust(D(c), c.req.param('id'), b.trust)); });
  app.get('/api/merchant/mandates', async (c) => { const out = []; for (const m of await D(c).store.listMandates()) out.push(await mandateView(D(c), m)); return c.json({ mandates: out }); });
  app.post('/api/merchant/mandates/:id/revoke', async (c) => c.json(await revokeMandate(D(c), c.req.param('id'))));
  app.post('/api/merchant/simulate', async (c) => {
    const rt = c.get('rt');
    const b = z.object({ sessions: z.number().int().min(1).max(50).default(10), seed: z.number().int().optional() }).parse(await c.req.json().catch(() => ({})));
    const r = await runSimulation(rt.deps, async (req) => app.fetch(req, c.env), { sessions: b.sessions, seed: b.seed, secret: rt.simSecret, simVaultId: rt.simVaultId });
    return c.json(r);
  });
  app.post('/api/merchant/reset', async (c) => {
    if (!D(c).config.allowDemoReset) throw new DomainError('forbidden', 'Reset disabled', 403);
    await D(c).store.resetDemo(); seeded = new WeakSet(); await seedCatalogIfEmpty(D(c));
    return c.json({ ok: true });
  });

  return app;
}
