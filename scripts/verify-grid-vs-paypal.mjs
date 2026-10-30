#!/usr/bin/env node
// Cross-check the AG Grid control room against PayPal: every row with a PayPal order id is re-read from the PayPal
// sandbox (GET /v2/checkout/orders/{id}) and its status, capture id, amount and refunds must match what the grid shows.
// Usage: node scripts/verify-grid-vs-paypal.mjs [baseUrl]   (MERCHANT_TOKEN env unless the target runs DEMO_MODE)
import { target, makeClient, writeReport } from './lib/paypal-cli.mjs';

const BASE = (process.argv.slice(2).find((a) => a.startsWith('http')) || 'http://127.0.0.1:8787').replace(/\/$/, '');
const h = process.env.MERCHANT_TOKEN ? { authorization: `Bearer ${process.env.MERCHANT_TOKEN}` } : {};
const dash = await (await fetch(`${BASE}/api/merchant/dashboard`, { headers: h })).json();
if (!dash.sessions) { console.error('dashboard unavailable', dash); process.exit(1); }
if (dash.paypalMode !== 'sandbox') { console.error(`target runs PAYPAL_MODE=${dash.paypalMode}; nothing to verify against PayPal`); process.exit(1); }
const t = await target(); const log = []; const pp = makeClient(t, log);
const rows = []; let bad = 0; let expired = 0;
for (const s of dash.sessions.filter((x) => x.paypalOrderId)) {
  const res = await pp.call(`get-order-${s.id}`, 'GET', `/v2/checkout/orders/${s.paypalOrderId}`, undefined, { allowFail: true });
  // PayPal purges orders that were created but never approved by the buyer (GET returns 404 RESOURCE_NOT_FOUND).
  // That is consistent with a grid row still awaiting buyer approval with no capture and no refund: no money moved.
  if (res.http === 404 && res.body?.name === 'RESOURCE_NOT_FOUND' && s.status !== 'completed' && !s.captureId && !s.refundedCents) {
    expired++;
    rows.push({ session: s.id, gridStatus: s.status, paypalStatus: 'EXPIRED_UNAPPROVED (404)', orderId: s.paypalOrderId, captureId: null, captureStatus: null, captures: 0, totalCents: s.totalCents, refundedCents: 0, refundIds: [], problems: [] });
    console.log(`✓ ${s.id} grid=${s.status} paypal=EXPIRED (never approved, 404) order=${s.paypalOrderId} capture=- $${(s.totalCents / 100).toFixed(2)}`);
    continue;
  }
  const o = res.body;
  const caps = o.purchase_units?.flatMap((u) => u.payments?.captures ?? []) ?? [];
  const refunds = o.purchase_units?.flatMap((u) => u.payments?.refunds ?? []) ?? [];
  const amount = Math.round(Number(o.purchase_units?.[0]?.amount?.value ?? 0) * 100);
  const refunded = refunds.filter((r) => r.status === 'COMPLETED').reduce((a, r) => a + Math.round(Number(r.amount.value) * 100), 0);
  const problems = [];
  if (amount !== s.totalCents) problems.push(`amount ${amount} != grid ${s.totalCents}`);
  if (s.status === 'completed' && (o.status !== 'COMPLETED' || caps.length !== 1 || caps[0].id !== s.captureId)) problems.push(`grid completed but PayPal ${o.status} with ${caps.length} capture(s)`);
  if (s.status !== 'completed' && caps.length) problems.push(`PayPal has a capture but grid says ${s.status}`);
  if (refunded !== s.refundedCents) problems.push(`refunded ${refunded} != grid ${s.refundedCents}`);
  if (problems.length) bad++;
  rows.push({ session: s.id, gridStatus: s.status, paypalStatus: o.status, orderId: s.paypalOrderId, captureId: caps[0]?.id ?? null, captureStatus: caps[0]?.status ?? null, captures: caps.length, totalCents: s.totalCents, refundedCents: refunded, refundIds: refunds.map((r) => r.id), problems });
  console.log(`${problems.length ? '✗' : '✓'} ${s.id} grid=${s.status} paypal=${o.status} order=${s.paypalOrderId} capture=${caps[0]?.id ?? '-'}${caps[0] ? ` (${caps[0].status})` : ''} $${(s.totalCents / 100).toFixed(2)}${refunded ? ` refunded $${(refunded / 100).toFixed(2)} ${refunds.map((r) => r.id).join(',')}` : ''}${problems.length ? '  ' + problems.join('; ') : ''}`);
}
console.log(`\n${rows.length} grid rows with PayPal ids checked, ${bad} mismatch(es)${expired ? ` (${expired} unapproved order(s) already expired at PayPal, no money moved)` : ''}`);
writeReport('grid-vs-paypal', { mode: 'sandbox', base: BASE, checked: rows.length, mismatches: bad, expiredUnapproved: expired, rows, log });
process.exit(bad ? 1 : 0);
