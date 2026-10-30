// Fake PayPal REST API (subset) for dry-running the sandbox scripts and testing the REST adapter offline.
// It mimics shapes/statuses of OAuth, Vault v3, Orders v2, Payments v2, Catalog v1 and webhook verification.
// NOT PayPal. Never used when PAYPAL_API_BASE points at api-m.sandbox.paypal.com.
import { createServer } from 'node:http';

// recapture: what a second capture of a COMPLETED order returns. 'error' = 422 ORDER_ALREADY_CAPTURED (documented);
// 'return-order' = 201 with the existing COMPLETED order and its single capture (what the real sandbox did on 2026-10-28).
export function createFakePayPal({ clientId = 'fake-client', clientSecret = 'fake-secret', base = 'http://fake-paypal.local', recapture = 'error' } = {}) {
  const objs = new Map(); const seen = new Map(); let n = 0;
  const id = (p) => `${p}${Date.now().toString(36).toUpperCase()}${(++n).toString(36).toUpperCase()}`;
  const j = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'paypal-debug-id': `fake${n}`, ...extra } });
  const err = (status, name, message, details = []) => j(status, { name, message, details, debug_id: `fake${n}` });
  const sumCheck = (pu) => {
    const v = (x) => Math.round(Number(x?.value ?? 0) * 100);
    const b = pu.amount?.breakdown; if (!b) return null;
    const items = (pu.items ?? []).reduce((a, i) => a + v(i.unit_amount) * Number(i.quantity), 0);
    if (pu.items?.length && items !== v(b.item_total)) return 'ITEM_TOTAL_MISMATCH';
    if (v(b.item_total) + v(b.shipping) - v(b.discount) !== v(pu.amount)) return 'AMOUNT_MISMATCH';
    return null;
  };
  const orderView = (o) => ({ id: o.id, status: o.status, intent: 'CAPTURE', payment_source: o.payment_source, purchase_units: [{ ...o.pu, payments: o.capture ? { captures: [o.capture] } : undefined }],
    links: [{ rel: 'self', href: `${base}/v2/checkout/orders/${o.id}` }, ...(o.status === 'PAYER_ACTION_REQUIRED' ? [{ rel: 'payer-action', href: `${base}/fake/approve?id=${o.id}` }] : [])] });
  const doCapture = (o) => {
    o.status = 'COMPLETED';
    o.capture = { id: id('CAP'), status: 'COMPLETED', amount: o.pu.amount, final_capture: true };
    if (o.vaultOnSuccess) { const t = id('VAULT'); objs.set(t, { kind: 'ptoken', id: t, customer: o.customer }); o.payment_source = { paypal: { email_address: 'sb-buyer@example.com', attributes: { vault: { id: t, status: 'VAULTED', customer: { id: o.customer } } } } }; }
    objs.set(o.capture.id, { kind: 'capture', ...o.capture, refunded: 0 });
  };

  async function handle(req) {
    const url = new URL(req.url); const p = url.pathname; const m = req.method;
    if (p === '/fake/approve') { // what the buyer does on paypal.com
      const o = objs.get(url.searchParams.get('id')); if (!o) return new Response('unknown', { status: 404 });
      if (o.kind === 'setup') o.status = 'APPROVED'; else o.status = 'APPROVED';
      return new Response(null, { status: 302, headers: { location: `${o.returnUrl}${o.returnUrl.includes('?') ? '&' : '?'}token=${o.id}` } });
    }
    if (p === '/v1/oauth2/token' && m === 'POST') {
      const auth = req.headers.get('authorization') ?? '';
      if (auth !== `Basic ${btoa(`${clientId}:${clientSecret}`)}`) return j(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      return j(200, { access_token: 'FAKE-ACCESS-TOKEN', token_type: 'Bearer', expires_in: 32400, scope: 'https://uri.paypal.com/services/vault/payment-tokens/readwrite' });
    }
    if (req.headers.get('authorization') !== 'Bearer FAKE-ACCESS-TOKEN') return err(401, 'AUTHENTICATION_FAILURE', 'Authentication failed');
    const rid = req.headers.get('paypal-request-id'); const key = rid ? `${m} ${p} ${rid}` : null;
    if (key && seen.has(key)) return j(200, seen.get(key));
    const body = m === 'POST' ? await req.json().catch(() => ({})) : null;
    const remember = (status, out) => { if (key) seen.set(key, out); return j(status, out); };
    let mm;
    if (p === '/v3/vault/setup-tokens' && m === 'POST') {
      const ec = body?.payment_source?.paypal?.experience_context ?? {};
      if (!ec.return_url) return err(422, 'UNPROCESSABLE_ENTITY', 'return_url required');
      const o = { kind: 'setup', id: id('SETUP'), status: 'PAYER_ACTION_REQUIRED', customer: id('CUST'), returnUrl: ec.return_url };
      objs.set(o.id, o);
      return remember(201, { id: o.id, status: o.status, customer: { id: o.customer }, links: [{ rel: 'approve', href: `${base}/fake/approve?id=${o.id}` }] });
    }
    if ((mm = p.match(/^\/v3\/vault\/setup-tokens\/([^/]+)$/)) && m === 'GET') { const o = objs.get(mm[1]); return o ? j(200, { id: o.id, status: o.status, customer: { id: o.customer } }) : err(404, 'RESOURCE_NOT_FOUND', 'not found'); }
    if (p === '/v3/vault/payment-tokens' && m === 'POST') {
      const s = objs.get(body?.payment_source?.token?.id);
      if (!s || s.kind !== 'setup') return err(404, 'RESOURCE_NOT_FOUND', 'setup token not found');
      if (s.status !== 'APPROVED') return err(422, 'UNPROCESSABLE_ENTITY', 'Setup token not approved', [{ issue: 'TOKEN_NOT_APPROVED' }]);
      if (s.used) return err(422, 'UNPROCESSABLE_ENTITY', 'Setup token already used', [{ issue: 'TOKEN_ALREADY_USED' }]);
      s.used = true; const t = { kind: 'ptoken', id: id('VAULT'), customer: s.customer }; objs.set(t.id, t);
      return remember(201, { id: t.id, customer: { id: t.customer }, payment_source: { paypal: { email_address: 'sb-buyer@example.com' } } });
    }
    if (p === '/v2/checkout/orders' && m === 'POST') {
      const pu = body?.purchase_units?.[0]; const ps = body?.payment_source?.paypal ?? {};
      const bad = pu ? sumCheck(pu) : 'MISSING_PURCHASE_UNIT'; if (bad) return err(422, 'UNPROCESSABLE_ENTITY', 'Amount mismatch', [{ issue: bad }]);
      const o = { kind: 'order', id: id('ORDER'), pu, status: 'CREATED', returnUrl: ps.experience_context?.return_url ?? `${base}/done`, vaultOnSuccess: ps.attributes?.vault?.store_in_vault === 'ON_SUCCESS', customer: id('CUST') };
      objs.set(o.id, o);
      if (ps.vault_id) { // buyer-absent charge
        const t = objs.get(ps.vault_id); if (!t || t.kind !== 'ptoken' || t.deleted) return err(422, 'UNPROCESSABLE_ENTITY', 'vault id invalid', [{ issue: 'INVALID_PAYMENT_TOKEN' }]);
        doCapture(o);
      } else if (ps.experience_context) o.status = 'PAYER_ACTION_REQUIRED';
      return remember(201, orderView(o));
    }
    if ((mm = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/)) && m === 'POST') {
      const o = objs.get(mm[1]); if (!o) return err(404, 'RESOURCE_NOT_FOUND', 'order not found');
      if (o.status === 'COMPLETED') return recapture === 'return-order' ? j(201, orderView(o)) : err(422, 'UNPROCESSABLE_ENTITY', 'Order already captured', [{ issue: 'ORDER_ALREADY_CAPTURED' }]);
      if (o.status !== 'APPROVED') return err(422, 'UNPROCESSABLE_ENTITY', 'Payer has not yet approved', [{ issue: 'ORDER_NOT_APPROVED' }]);
      doCapture(o); return remember(201, orderView(o));
    }
    if ((mm = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/)) && m === 'GET') { const o = objs.get(mm[1]); return o ? j(200, orderView(o)) : err(404, 'RESOURCE_NOT_FOUND', 'not found'); }
    if ((mm = p.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/)) && m === 'POST') {
      const c = objs.get(mm[1]); if (!c || c.kind !== 'capture') return err(404, 'RESOURCE_NOT_FOUND', 'capture not found');
      const total = Math.round(Number(c.amount.value) * 100); const amt = body?.amount ? Math.round(Number(body.amount.value) * 100) : total - c.refunded;
      if (amt <= 0 || c.refunded + amt > total) return err(422, 'UNPROCESSABLE_ENTITY', 'Refund exceeds capture', [{ issue: 'REFUND_AMOUNT_EXCEEDED' }]);
      c.refunded += amt; return remember(201, { id: id('REFUND'), status: 'COMPLETED', amount: { currency_code: 'USD', value: (amt / 100).toFixed(2) } });
    }
    if (p === '/v1/catalogs/products' && m === 'POST') return remember(201, { id: id('PROD-'), name: body?.name });
    if (p === '/v1/notifications/verify-webhook-signature' && m === 'POST') return j(200, { verification_status: req.headers.get('x-fake-bad-sig') ? 'FAILURE' : 'SUCCESS' });
    if ((mm = p.match(/^\/v3\/vault\/payment-tokens\/([^/]+)$/)) && m === 'DELETE') { const t = objs.get(mm[1]); if (t) t.deleted = true; return new Response(null, { status: 204 }); }
    return err(404, 'NOT_FOUND', `fake has no route ${m} ${p}`);
  }
  return { handle, objs, approve: async (approveUrl) => handle(new Request(approveUrl)) };
}

// `node scripts/fake-paypal.mjs [port]` serves it on localhost for dry runs.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8790);
  const fake = createFakePayPal({ base: `http://localhost:${port}` });
  createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await fake.handle(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(port, () => console.log(`fake PayPal on http://localhost:${port} (client id fake-client / secret fake-secret)`));
}
