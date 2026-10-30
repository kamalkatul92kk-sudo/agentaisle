// Shared helpers for the sandbox go/no-go scripts. Plain Node 20, no dependencies.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createFakePayPal } from '../fake-paypal.mjs';

export const args = new Set(process.argv.slice(2));
export const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : dflt; };

/** Resolve target: --fake runs an in-process fake PayPal (dry run); otherwise sandbox via env vars. Live is refused. */
export async function target() {
  if (args.has('--fake')) {
    const port = 18790 + Math.floor(Math.random() * 500);
    const base = `http://127.0.0.1:${port}`;
    const fake = createFakePayPal({ base });
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await fake.handle(new Request(base + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
    return { mode: 'fake', base, clientId: 'fake-client', clientSecret: 'fake-secret', autoApprove: (url) => fetch(url), close: () => server.close() };
  }
  const base = (process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
  if (!/sandbox\.paypal\.com$/.test(new URL(base).host)) { console.error(`Refusing non-sandbox PAYPAL_API_BASE (${base}). These scripts never touch live money.`); process.exit(2); }
  const clientId = process.env.PAYPAL_CLIENT_ID, clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) { console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app from developer.paypal.com). Or pass --fake for a dry run.'); process.exit(2); }
  return { mode: 'sandbox', base, clientId, clientSecret, autoApprove: null, close: () => {} };
}

export function makeClient(t, log) {
  let token = null;
  async function oauth() {
    const t0 = Date.now();
    const r = await fetch(`${t.base}/v1/oauth2/token`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${t.clientId}:${t.clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    const b = await r.json().catch(() => ({}));
    log.push({ step: 'oauth', http: r.status, ms: Date.now() - t0, debug_id: r.headers.get('paypal-debug-id'), scopes: typeof b.scope === 'string' ? b.scope.split(' ').filter((s) => /vault|payments|checkout/.test(s)) : undefined, error: r.ok ? undefined : b });
    if (!r.ok) throw new Error(`OAuth failed ${r.status}: ${JSON.stringify(b)}`);
    token = b.access_token; return b;
  }
  async function call(step, method, path, body, { requestId = randomUUID(), allowFail = false } = {}) {
    if (!token) await oauth();
    const t0 = Date.now();
    const r = await fetch(t.base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'paypal-request-id': requestId, prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const b = r.status === 204 ? {} : await r.json().catch(() => ({}));
    log.push({ step, http: r.status, ms: Date.now() - t0, debug_id: r.headers.get('paypal-debug-id') || b.debug_id, id: b.id, status: b.status, error: r.ok ? undefined : { name: b.name, message: b.message, details: b.details } });
    if (!r.ok && !allowFail) throw Object.assign(new Error(`${step} failed ${r.status}: ${b.name ?? ''} ${b.message ?? ''} ${JSON.stringify(b.details ?? [])}`), { body: b });
    return { http: r.status, body: b };
  }
  return { oauth, call };
}

export const link = (b, rel) => b?.links?.find((l) => l.rel === rel)?.href;
export const usd = (c) => (c / 100).toFixed(2);
export function unit({ ref, items, shippingCents = 0, discountCents = 0 }) {
  const itemTotal = items.reduce((s, i) => s + i.unitCents * i.qty, 0);
  const total = itemTotal + shippingCents - discountCents;
  return { reference_id: ref, description: 'Pecan Plume Coffee Co. (AgentAisle sandbox test)', amount: { currency_code: 'USD', value: usd(total), breakdown: { item_total: { currency_code: 'USD', value: usd(itemTotal) }, shipping: { currency_code: 'USD', value: usd(shippingCents) }, discount: { currency_code: 'USD', value: usd(discountCents) } } },
    items: items.map((i) => ({ name: i.name, sku: i.sku, quantity: String(i.qty), unit_amount: { currency_code: 'USD', value: usd(i.unitCents) }, category: 'PHYSICAL_GOODS' })) };
}

/** Poll until fn() returns truthy, or timeout. */
export async function poll(fn, { timeoutMs, everyMs = 4000, label }) {
  const end = Date.now() + timeoutMs; let n = 0;
  while (Date.now() < end) { const v = await fn(); if (v) return v; if (++n % 5 === 0) console.log(`  …still waiting for ${label}`); await new Promise((r) => setTimeout(r, everyMs)); }
  return null;
}

export function writeReport(name, report) {
  mkdirSync(new URL('../../reports/', import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = new URL(`../../reports/${name}-${report.mode}-${stamp}.json`, import.meta.url);
  writeFileSync(url, JSON.stringify(report, null, 2));
  return url.pathname;
}

/**
 * Try to capture an already-captured order twice (a fresh PayPal-Request-Id, then a replay of that same id)
 * and decide whether a second capture really happened. Safe = every attempt was refused (4xx) or echoed the original
 * capture, and a fresh GET of the order shows exactly one capture with the original id.
 */
export async function checkDoubleCapture(pp, orderId, firstCaptureId) {
  const attempts = [];
  const rid = randomUUID();
  for (const step of ['double-capture-new-request-id', 'double-capture-replay-same-request-id']) {
    const r = await pp.call(step, 'POST', `/v2/checkout/orders/${orderId}/capture`, {}, { allowFail: true, requestId: rid });
    const caps = r.body.purchase_units?.flatMap((u) => u.payments?.captures ?? []) ?? [];
    attempts.push({ http: r.http, issue: r.body.details?.[0]?.issue ?? null, status: r.body.status ?? null, captureIds: caps.map((x) => x.id) });
  }
  const g = await pp.call('double-capture-verify-order', 'GET', `/v2/checkout/orders/${orderId}`);
  const captureIds = g.body.purchase_units?.flatMap((u) => u.payments?.captures ?? []).map((x) => x.id) ?? [];
  const echoedOrRefused = attempts.every((a) => a.http >= 400 || (a.captureIds.length === 1 && a.captureIds[0] === firstCaptureId));
  const safe = echoedOrRefused && captureIds.length === 1 && captureIds[0] === firstCaptureId;
  const kinds = [...new Set(attempts.map((a) => (a.http >= 400 ? `refused ${a.issue ?? a.http}` : `idempotent ${a.http} (same capture ${a.captureIds.join(',')})`)))];
  const how = safe ? `${kinds.join('; ')}; order has exactly 1 capture (${firstCaptureId})` : `order ${orderId} has ${captureIds.length} capture(s): ${captureIds.join(', ')}; attempts ${JSON.stringify(attempts)}`;
  return { safe, how, attempts, captureIds };
}
