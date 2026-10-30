#!/usr/bin/env node
// Fallback flow if vaulting is NO-GO: the agent builds the cart, and the buyer approves each order once on PayPal.
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/sandbox-fallback-approval.mjs [--timeout-min=10] [--no-refund]
//   node scripts/sandbox-fallback-approval.mjs --fake
//   Resume after the buyer approves later: --order-id=<id>. A buyer timeout is verdict PENDING_BUYER_APPROVAL (exit 3), not FAIL.
// Steps: create order (PAY_NOW, payer-action link) -> buyer approves -> server captures -> optional refund. Also checks the
// "capture before approval" guard and double-capture safety (one capture per order, however PayPal answers the retry) so the app's error handling is proven against real responses.
import { args, arg, target, makeClient, link, unit, poll, writeReport, checkDoubleCapture } from './lib/paypal-cli.mjs';

const t = await target();
const log = [];
const pp = makeClient(t, log);
const timeoutMs = Number(arg('timeout-min', '10')) * 60_000;
const RETURN = arg('return-url', 'https://example.com/agentaisle/checkout/return'), CANCEL = arg('cancel-url', 'https://example.com/agentaisle/checkout/cancel');
const report = { test: 'per-order buyer approval (fallback)', mode: t.mode, apiBase: t.base, startedAt: new Date().toISOString(), checks: {}, ids: {}, verdict: 'FAIL', log };
class PendingApproval extends Error {}
const resumeOrder = arg('order-id');
try {
  await pp.oauth(); report.checks.oauth = true; console.log(`✓ OAuth OK (${t.mode})`);
  const o = resumeOrder ? await pp.call('get-order', 'GET', `/v2/checkout/orders/${resumeOrder}`) : await pp.call('create-order', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [unit({ ref: 'fallback-1', items: [{ name: 'Lone Star Morning Blend 12oz', sku: 'PP-BL-HC-12', qty: 3, unitCents: 1650 }], shippingCents: 0, discountCents: 248 })], payment_source: { paypal: { experience_context: { user_action: 'PAY_NOW', shipping_preference: 'GET_FROM_FILE', brand_name: 'Pecan Plume Coffee Co.', locale: 'en-US', return_url: RETURN, cancel_url: CANCEL } } } });
  const url = link(o.body, 'payer-action') || link(o.body, 'approve') || `https://www.sandbox.paypal.com/checkoutnow?token=${o.body.id}`;
  report.ids.orderId = o.body.id; report.ids.approveUrl = url;
  report.checks.orderCreated = !!o.body.id; console.log(`✓ order ${o.body.id} (${o.body.status})${resumeOrder ? ' [resumed]' : ''}`);
  if (o.body.status === 'COMPLETED') { // resumed on an order that is already captured: only re-run the double-capture check
    const c0 = o.body.purchase_units?.[0]?.payments?.captures?.[0];
    report.ids.captureId = c0?.id; report.checks.captured = true; report.capture = { id: c0?.id, status: c0?.status, amount: c0?.amount?.value };
    console.log(`✓ order already captured: ${c0?.id} ${c0?.status} $${c0?.amount?.value}`);
    const dc = await checkDoubleCapture(pp, o.body.id, c0?.id);
    report.checks.doubleCaptureSafe = dc.safe; report.doubleCapture = dc;
    console.log(dc.safe ? `✓ double capture safe: ${dc.how}` : `✗ DOUBLE CAPTURE: ${dc.how}`);
    report.verdict = dc.safe ? 'PASS' : 'FAIL';
  } else {
  if (o.body.status !== 'APPROVED') {
  const early = await pp.call('capture-before-approval', 'POST', `/v2/checkout/orders/${o.body.id}/capture`, {}, { allowFail: true });
  report.checks.earlyCaptureRefused = early.http >= 400; console.log(report.checks.earlyCaptureRefused ? `✓ capture before approval refused (${early.body.details?.[0]?.issue ?? early.http})` : '✗ capture before approval was NOT refused');
  if (t.autoApprove) { await t.autoApprove(url); console.log('  (fake) buyer approved'); }
  else console.log(`\n>>> BUYER STEP: open, log in with the SANDBOX PERSONAL account, click Pay:\n\n    ${url}\n`);
  }
  const ok = o.body.status === 'APPROVED' || await poll(async () => (await pp.call('poll-order', 'GET', `/v2/checkout/orders/${o.body.id}`, undefined, { allowFail: true })).body.status === 'APPROVED', { timeoutMs, label: 'buyer approval' });
  log.splice(0, log.length, ...log.filter((e, i, a) => e.step !== 'poll-order' || i === a.findLastIndex((x) => x.step === 'poll-order')));
  if (!ok) throw new PendingApproval(`Timed out waiting for buyer approval of order ${o.body.id}`);
  report.checks.buyerApproved = true;
  const cap = await pp.call('capture', 'POST', `/v2/checkout/orders/${o.body.id}/capture`, {});
  const c = cap.body.purchase_units?.[0]?.payments?.captures?.[0];
  report.ids.captureId = c?.id;
  report.checks.captured = cap.body.status === 'COMPLETED'; report.capture = { id: c?.id, status: c?.status, amount: c?.amount?.value };
  console.log(`✓ captured ${c?.status} $${c?.amount?.value}`);
  // Double-capture check. PayPal may answer a second capture of a COMPLETED order either with 422 ORDER_ALREADY_CAPTURED
  // or with 201 and the SAME completed order (the sandbox did the latter on 2026-10-28). Either is safe; what matters is
  // that the order still has exactly one capture, with the original id. Re-read the order to prove it.
  const dc = await checkDoubleCapture(pp, o.body.id, c?.id);
  report.checks.doubleCaptureSafe = dc.safe; report.doubleCapture = dc;
  console.log(dc.safe ? `✓ double capture safe: ${dc.how}` : `✗ DOUBLE CAPTURE: ${dc.how}`);
  if (!args.has('--no-refund') && c?.id) {
    const r = await pp.call('refund-partial', 'POST', `/v2/payments/captures/${c.id}/refund`, { amount: { currency_code: 'USD', value: '5.00' }, note_to_payer: 'AgentAisle sandbox partial refund' }, { allowFail: true });
    report.ids.refundId = r.body.id; report.checks.partialRefund = ['COMPLETED', 'PENDING'].includes(r.body.status); console.log(report.checks.partialRefund ? `✓ partial refund ${r.body.status}` : `! refund: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  report.verdict = report.checks.captured && report.checks.doubleCaptureSafe !== false ? 'PASS' : 'FAIL';
  }
} catch (e) { report.error = String(e.message || e); if (e instanceof PendingApproval) report.verdict = 'PENDING_BUYER_APPROVAL'; console.error(`✗ ${report.error}`); }
finally {
  report.finishedAt = new Date().toISOString();
  if (report.verdict === 'PENDING_BUYER_APPROVAL') report.nextStep = `PENDING (not a failure): approve ${report.ids.approveUrl} as the sandbox buyer, then resume with: npm run fallback -- --order-id=${report.ids.orderId}`;
  const file = writeReport('fallback-approval', report);
  console.log(`\n==== ${report.verdict} ====${report.nextStep ? '\n' + report.nextStep : ''}\nreport: ${file}`); t.close(); process.exitCode = report.verdict === 'PASS' ? 0 : report.verdict === 'PENDING_BUYER_APPROVAL' ? 3 : 1;
}
