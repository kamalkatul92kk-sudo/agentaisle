#!/usr/bin/env node
// Oct 29 GO/NO-GO: can AgentAisle save a buyer's PayPal wallet while the buyer is present,
// then charge it later with NO buyer present (what an autonomous shopping agent needs)?
//
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/sandbox-go-no-go.mjs [--path-b] [--no-refund] [--timeout-min=10]
//   node scripts/sandbox-go-no-go.mjs --fake            # offline dry run against scripts/fake-paypal.mjs
//   Resume after the buyer approves later:  --setup-token=<id> (path A)  |  --path-b --order-id=<id> (path B)
//   A timeout waiting for the buyer is verdict PENDING_BUYER_APPROVAL (exit 3), not NO-GO: nothing failed on PayPal's side.
//
// Path A (primary): Vault v3 "save without purchase": setup-token -> buyer approves -> payment-token -> buyer-absent order with vault_id.
// Path B (--path-b): "save during purchase": buyer pays order #1 with store_in_vault=ON_SUCCESS -> vault id from capture -> buyer-absent order #2.
// Sandbox only (refuses any non-sandbox base). Writes reports/go-no-go-*.json (debug_ids + timings, no secrets).
import { args, arg, target, makeClient, link, unit, poll, writeReport } from './lib/paypal-cli.mjs';

const t = await target();
const log = [];
const pp = makeClient(t, log);
const timeoutMs = Number(arg('timeout-min', '10')) * 60_000;
const report = { test: 'vaulted-payment buyer-absent charge', mode: t.mode, apiBase: t.base, startedAt: new Date().toISOString(), path: args.has('--path-b') ? 'B save-during-purchase' : 'A save-without-purchase', checks: {}, ids: {}, verdict: 'NO-GO', log };
class PendingApproval extends Error {}
const resumeSetup = arg('setup-token'), resumeOrder = arg('order-id');
const RETURN = arg('return-url', 'https://example.com/agentaisle/return'), CANCEL = arg('cancel-url', 'https://example.com/agentaisle/cancel');
const line = { name: 'Ethiopia Guji Natural 12oz', sku: 'PP-SO-ETH-12', unitCents: 1950 };

async function buyerApproves(url, isDone, what) {
  if (t.autoApprove) { await t.autoApprove(url); console.log(`  (fake) buyer approved ${what}`); }
  else {
    console.log(`\n>>> BUYER STEP: open this URL, log in with the SANDBOX PERSONAL (buyer) account, and approve ${what}:\n\n    ${url}\n\n    (after approving you land on ${RETURN}; that page can 404, it does not matter)\n`);
  }
  return poll(isDone, { timeoutMs, label: `buyer approval of ${what}` });
}

try {
  const tok = await pp.oauth();
  report.checks.oauth = true;
  console.log(`✓ OAuth OK (${t.mode})`);
  if (t.mode === 'sandbox' && typeof tok.scope === 'string') {
    report.checks.vaultScopePresent = /vault/.test(tok.scope);
    console.log(report.checks.vaultScopePresent ? '✓ token scope mentions vault' : '! token scope has no vault entry; enable "Save payment methods"/Vault on the sandbox app if the next call fails');
  }

  let vaultId;
  if (!args.has('--path-b')) {
    const st = resumeSetup ? await pp.call('get-setup-token', 'GET', `/v3/vault/setup-tokens/${resumeSetup}`) : await pp.call('create-setup-token', 'POST', '/v3/vault/setup-tokens', { payment_source: { paypal: { description: 'AgentAisle: let your shopping agent buy coffee within your caps', permit_multiple_payment_tokens: false, usage_pattern: 'IMMEDIATE', usage_type: 'MERCHANT', customer_type: 'CONSUMER', experience_context: { shipping_preference: 'NO_SHIPPING', payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED', brand_name: 'Pecan Plume Coffee Co.', locale: 'en-US', return_url: RETURN, cancel_url: CANCEL } } } });
    const approveUrl = link(st.body, 'approve') || `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${st.body.id}`;
    report.checks.setupTokenCreated = !!st.body.id;
    report.ids.setupTokenId = st.body.id; report.ids.setupTokenApproveUrl = approveUrl; report.ids.customerId = st.body.customer?.id;
    console.log(`✓ setup token ${st.body.id} (${st.body.status})${resumeSetup ? ' [resumed]' : ''}`);
    const t0 = Date.now();
    const approved = st.body.status === 'APPROVED' || await buyerApproves(approveUrl, async () => (await pp.call('poll-setup-token', 'GET', `/v3/vault/setup-tokens/${st.body.id}`, undefined, { allowFail: true })).body.status === 'APPROVED', 'saving PayPal');
    log.splice(0, log.length, ...log.filter((e, i, a) => e.step !== 'poll-setup-token' || i === a.findLastIndex((x) => x.step === 'poll-setup-token')));
    if (!approved) throw new PendingApproval(`Timed out waiting for the buyer to approve setup token ${st.body.id}`);
    report.checks.buyerApprovedSetup = true; report.timings = { buyerApprovalMs: Date.now() - t0 };
    const pt = await pp.call('create-payment-token', 'POST', '/v3/vault/payment-tokens', { payment_source: { token: { id: st.body.id, type: 'SETUP_TOKEN' } } });
    vaultId = pt.body.id;
    report.checks.paymentTokenCreated = !!vaultId;
    report.vault = { vaultIdSuffix: vaultId?.slice(-4), customerId: pt.body.customer?.id };
    report.ids.vaultId = vaultId; report.ids.customerId = pt.body.customer?.id ?? report.ids.customerId;
    console.log(`✓ payment token / vault id ${vaultId} for customer ${pt.body.customer?.id}`);
  } else {
    const o1 = resumeOrder ? await pp.call('get-order-1', 'GET', `/v2/checkout/orders/${resumeOrder}`) : await pp.call('create-order-with-vault-on-success', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [unit({ ref: 'gonogo-b-1', items: [{ ...line, qty: 1 }], shippingCents: 699 })], payment_source: { paypal: { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } }, experience_context: { user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', brand_name: 'Pecan Plume Coffee Co.', return_url: RETURN, cancel_url: CANCEL } } } });
    const url = link(o1.body, 'payer-action') || link(o1.body, 'approve') || `https://www.sandbox.paypal.com/checkoutnow?token=${o1.body.id}`;
    report.ids.order1Id = o1.body.id; report.ids.order1ApproveUrl = url;
    console.log(`✓ order #1 ${o1.body.id} (${o1.body.status})${resumeOrder ? ' [resumed]' : ''}`);
    const ok = o1.body.status === 'APPROVED' || await buyerApproves(url, async () => (await pp.call('poll-order', 'GET', `/v2/checkout/orders/${o1.body.id}`, undefined, { allowFail: true })).body.status === 'APPROVED', 'order #1 (buyer present, saves PayPal)');
    log.splice(0, log.length, ...log.filter((e, i, a) => e.step !== 'poll-order' || i === a.findLastIndex((x) => x.step === 'poll-order')));
    if (!ok) throw new PendingApproval(`Timed out waiting for buyer approval of order #1 ${o1.body.id}`);
    const cap = await pp.call('capture-order-1', 'POST', `/v2/checkout/orders/${o1.body.id}/capture`, {});
    vaultId = cap.body.payment_source?.paypal?.attributes?.vault?.id;
    report.checks.firstOrderCaptured = cap.body.status === 'COMPLETED';
    report.checks.paymentTokenCreated = !!vaultId;
    report.vault = { vaultIdSuffix: vaultId?.slice(-4), vaultStatus: cap.body.payment_source?.paypal?.attributes?.vault?.status };
    report.ids.vaultId = vaultId; report.ids.customerId = cap.body.payment_source?.paypal?.attributes?.vault?.customer?.id; report.ids.order1CaptureId = cap.body.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    console.log(`✓ order #1 captured; vault ${vaultId ? '…' + vaultId.slice(-4) : 'MISSING'} (${report.vault.vaultStatus ?? 'no status'})`);
    if (!vaultId) throw new Error('Capture response had no payment_source.paypal.attributes.vault.id');
  }

  // THE test: merchant-initiated charge, no buyer redirect, no buyer session.
  console.log('… charging the saved wallet with no buyer present');
  const t1 = Date.now();
  const ch = await pp.call('buyer-absent-charge', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [unit({ ref: 'gonogo-absent-1', items: [{ ...line, qty: 2 }], shippingCents: 699, discountCents: 195 })], payment_source: { paypal: { vault_id: vaultId } } }, { allowFail: true });
  const capture = ch.body.purchase_units?.[0]?.payments?.captures?.[0];
  report.charge = { http: ch.http, orderStatus: ch.body.status, captureId: capture?.id, captureStatus: capture?.status, amount: capture?.amount?.value, ms: Date.now() - t1, needsPayerAction: !!link(ch.body, 'payer-action'), error: ch.http >= 400 ? ch.body : undefined };
  report.ids.chargeOrderId = ch.body.id; report.ids.chargeCaptureId = capture?.id;
  report.checks.buyerAbsentChargeCompleted = ch.body.status === 'COMPLETED' && capture?.status === 'COMPLETED';
  console.log(report.checks.buyerAbsentChargeCompleted ? `✓ buyer-absent charge COMPLETED ($${capture.amount.value}, capture ${capture.id})` : `✗ buyer-absent charge did not complete: ${JSON.stringify(report.charge).slice(0, 500)}`);

  // Idempotency: replaying the same PayPal-Request-Id must not double-charge.
  if (report.checks.buyerAbsentChargeCompleted) {
    const rid = log.findLast((e) => e.step === 'buyer-absent-charge');
    const reqId = `gonogo-idem-${Date.now()}`;
    const a = await pp.call('idem-charge-1', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [unit({ ref: 'gonogo-idem', items: [{ ...line, qty: 1 }] })], payment_source: { paypal: { vault_id: vaultId } } }, { requestId: reqId, allowFail: true });
    const b = await pp.call('idem-charge-2', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [unit({ ref: 'gonogo-idem', items: [{ ...line, qty: 1 }] })], payment_source: { paypal: { vault_id: vaultId } } }, { requestId: reqId, allowFail: true });
    report.ids.idempotencyOrderIds = [a.body.id, b.body.id];
    report.checks.idempotentReplay = !!a.body.id && a.body.id === b.body.id;
    console.log(report.checks.idempotentReplay ? '✓ PayPal-Request-Id replay returned the same order (no double charge)' : `! replay returned different orders (${a.body.id} vs ${b.body.id}); app-level idempotency still protects us`);
    void rid;
    if (!args.has('--no-refund')) {
      for (const [k, cid] of [['refund-charge', capture.id], ['refund-idem', a.body.purchase_units?.[0]?.payments?.captures?.[0]?.id]]) {
        if (!cid) continue;
        const r = await pp.call(k, 'POST', `/v2/payments/captures/${cid}/refund`, { note_to_payer: 'AgentAisle sandbox test refund' }, { allowFail: true });
        report.ids[k === 'refund-charge' ? 'refundId' : 'idemRefundId'] = r.body.id;
        if (k === 'refund-charge') { report.checks.refundWorks = r.body.status === 'COMPLETED' || r.body.status === 'PENDING'; console.log(report.checks.refundWorks ? `✓ refund ${r.body.status}` : `! refund failed: ${JSON.stringify(r.body).slice(0, 300)}`); }
      }
    }
  }

  report.verdict = report.checks.buyerAbsentChargeCompleted ? 'GO' : 'NO-GO';
} catch (e) {
  report.error = String(e.message || e);
  if (e instanceof PendingApproval) report.verdict = 'PENDING_BUYER_APPROVAL';
  console.error(`✗ ${report.error}`);
} finally {
  report.finishedAt = new Date().toISOString();
  const resumeCmd = args.has('--path-b') ? `npm run gonogo:path-b -- --order-id=${report.ids.order1Id}` : `npm run gonogo -- --setup-token=${report.ids.setupTokenId}`;
  report.nextStep = report.verdict === 'PENDING_BUYER_APPROVAL'
    ? `PENDING (not a failure): log in as the sandbox buyer at ${report.ids.setupTokenApproveUrl ?? report.ids.order1ApproveUrl}, approve, then resume with: ${resumeCmd}`
    : report.verdict === 'GO'
    ? 'GO: build on the mandate (vault) flow; keep per-order approval links as the fallback for buyers who decline to save PayPal.'
    : (args.has('--path-b') ? 'NO-GO on both paths: switch the demo to the per-order approval flow (scripts/sandbox-fallback-approval.mjs) and pitch vaulting as roadmap.' : 'Path A failed: retry with --path-b (save during purchase). If that also fails, use the per-order approval fallback.');
  const file = writeReport(args.has('--path-b') ? 'go-no-go-pathB' : 'go-no-go', report);
  console.log(`\n==== ${report.verdict} ====\n${report.nextStep}\nreport: ${file}`);
  t.close();
  process.exitCode = report.verdict === 'GO' ? 0 : report.verdict === 'PENDING_BUYER_APPROVAL' ? 3 : 1;
}
