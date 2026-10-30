// Checkout session lifecycle for buyer agents. All state transitions and money math live here.
import type { AgentCtx, Deps } from './deps';
import { emit, sha256 } from './deps';
import { touchAgent, promoteIfEarned } from './agents';
import { decideOffer, emptyNegotiation, quote, totalsFor, type Quote } from './pricing';
import { assessApprovalLink, assessMandateCharge, RISK } from './risk';
import { phraseNegotiation } from './negotiationCopy';
import { DomainError, type CheckoutSession, type Mandate, type Product } from './types';
import type { OrderResult } from '../ports';

export type CartInput = { sku: string; qty: number }[];

async function catalogMap(d: Deps) {
  return new Map<string, Product>((await d.store.listProducts()).map((p) => [p.sku, p]));
}
async function requote(d: Deps, s: CheckoutSession): Promise<Quote> {
  return quote(s.items.map((i) => ({ sku: i.sku, qty: i.qty })), await catalogMap(d));
}
function applyTotals(s: CheckoutSession, q: Quote) {
  const t = totalsFor(q, s.negotiation.agreedTotalBeforeShippingCents);
  Object.assign(s, { items: q.items, ...t });
}
const sanitizeNote = (n: unknown) => (typeof n === 'string' ? n.replace(/[\u0000-\u001f]/g, ' ').slice(0, 500) : null);

/** View returned to buyer agents. Never includes floor prices, mandate internals, or other agents' data. */
export function agentView(s: CheckoutSession) {
  return {
    checkout_id: s.id, status: s.status,
    items: s.items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, unit_price_cents: i.unitPriceCents, line_total_cents: i.lineTotalCents })),
    subtotal_cents: s.subtotalCents, bundle_discount_cents: s.bundleDiscountCents, negotiated_discount_cents: s.negotiatedDiscountCents,
    shipping_cents: s.shippingCents, total_cents: s.totalCents, currency: 'USD',
    negotiation: { rounds_used: s.negotiation.rounds.length, rounds_max: 3, closed: s.negotiation.locked, agreed_goods_cents: s.negotiation.agreedTotalBeforeShippingCents,
      last_message: s.negotiation.rounds.at(-1)?.message ?? null },
    payment_mode: s.paymentMode, paypal_order_id: s.paypalOrderId, approve_url: s.status === 'requires_buyer_action' ? s.approveUrl : null,
    hold_reason: s.status === 'on_hold' ? 'Order is waiting for merchant review. Poll get_checkout for updates.' : null,
    reject_reason: s.rejectReason, created_at: s.createdAt, completed_at: s.completedAt,
  };
}

export async function getOwnSession(d: Deps, ctx: AgentCtx, id: string) {
  const s = await d.store.getSession(id);
  // Same error for "missing" and "not yours" so agents cannot probe other agents' sessions.
  if (!s || s.agentId !== ctx.agentId) throw new DomainError('not_found', 'Checkout not found', 404);
  return s;
}

export async function createCheckout(d: Deps, ctx: AgentCtx, input: { items: CartInput; buyer_note?: string }) {
  const agent = await touchAgent(d, ctx);
  if (agent.trust === 'blocked') throw new DomainError('agent_blocked', 'This agent is not allowed to purchase from this store', 403);
  const q = quote(input.items, await catalogMap(d));
  const now = d.clock.now().toISOString();
  const s: CheckoutSession = {
    id: d.ids.id('cs'), agentId: ctx.agentId, mandateId: null, status: 'open', items: q.items,
    subtotalCents: 0, bundleDiscountCents: 0, negotiatedDiscountCents: 0, shippingCents: 0, totalCents: 0,
    negotiation: emptyNegotiation(), paymentMode: null, paypalOrderId: null, captureId: null, approveUrl: null,
    holdReason: null, rejectReason: null, idempotencyKey: null, buyerNote: sanitizeNote(input.buyer_note), createdAt: now, updatedAt: now, completedAt: null,
  };
  applyTotals(s, q);
  await d.store.insertSession(s);
  await emit(d, 'checkout.created', { sessionId: s.id, agentId: ctx.agentId, data: { items: s.items.map((i) => `${i.qty}x ${i.sku}`), totalCents: s.totalCents } });
  return s;
}

export async function updateCheckout(d: Deps, ctx: AgentCtx, id: string, input: { items: CartInput; buyer_note?: string }) {
  const s = await getOwnSession(d, ctx, id);
  if (s.status !== 'open') throw new DomainError('not_editable', `Checkout is ${s.status} and can no longer be changed`, 409);
  const q = quote(input.items, await catalogMap(d));
  if (s.negotiation.rounds.length) s.negotiation = { ...emptyNegotiation(), rounds: s.negotiation.rounds, locked: s.negotiation.locked }; // cart changed: agreed price voided
  if (input.buyer_note !== undefined) s.buyerNote = sanitizeNote(input.buyer_note);
  applyTotals(s, q);
  s.updatedAt = d.clock.now().toISOString();
  await d.store.updateSession(s);
  await emit(d, 'checkout.updated', { sessionId: s.id, agentId: ctx.agentId, data: { items: s.items.map((i) => `${i.qty}x ${i.sku}`), totalCents: s.totalCents } });
  return s;
}

export async function negotiate(d: Deps, ctx: AgentCtx, id: string, offerGoodsCents: number) {
  const s = await getOwnSession(d, ctx, id);
  if (s.status !== 'open') throw new DomainError('not_editable', `Checkout is ${s.status}`, 409);
  const q = await requote(d, s);
  const dec = decideOffer(q, s.negotiation, offerGoodsCents);
  const message = await phraseNegotiation(d, dec, offerGoodsCents);
  s.negotiation.rounds.push({ round: dec.round, offerCents: offerGoodsCents, decision: dec.decision, merchantPriceCents: dec.merchantPriceCents, message, at: d.clock.now().toISOString() });
  if (dec.final) s.negotiation.locked = true;
  if (dec.agreedCents != null) s.negotiation.agreedTotalBeforeShippingCents = dec.agreedCents;
  applyTotals(s, q);
  s.updatedAt = d.clock.now().toISOString();
  await d.store.updateSession(s);
  await emit(d, 'negotiation.round', { sessionId: s.id, agentId: ctx.agentId, data: { round: dec.round, offerCents: offerGoodsCents, decision: dec.decision, merchantPriceCents: dec.merchantPriceCents } });
  return { session: s, decision: dec.decision, merchant_price_cents: dec.merchantPriceCents, message, final: dec.final };
}

export async function resolveMandate(d: Deps, token: string | undefined): Promise<Mandate> {
  if (!token || typeof token !== 'string') throw new DomainError('mandate_required', 'A mandate_token is required for mandate payments', 401);
  const m = await d.store.getMandateByTokenHash(await sha256(token));
  if (!m) throw new DomainError('mandate_invalid', 'Mandate token is not valid', 401);
  if (m.status !== 'active' || !m.vaultId) throw new DomainError('mandate_inactive', `Mandate is ${m.status}`, 403);
  if (m.expiresAt <= d.clock.now().toISOString()) throw new DomainError('mandate_expired', 'Mandate has expired', 403);
  return m;
}

function orderInput(s: CheckoutSession, requestId: string, merchantName: string) {
  return {
    requestId, referenceId: s.id, totalCents: s.totalCents, itemTotalCents: s.subtotalCents,
    discountCents: s.bundleDiscountCents + s.negotiatedDiscountCents, shippingCents: s.shippingCents,
    lines: s.items.map((i) => ({ name: i.name, sku: i.sku, qty: i.qty, unitCents: i.unitPriceCents })),
    description: `${merchantName} order ${s.id}`,
  };
}

async function reserveStock(d: Deps, s: CheckoutSession) {
  const done: { sku: string; qty: number }[] = [];
  for (const i of s.items) {
    if (!(await d.store.adjustStock(i.sku, -i.qty))) {
      for (const r of done) await d.store.adjustStock(r.sku, r.qty);
      throw new DomainError('out_of_stock', `${i.sku} sold out while checking out`, 409);
    }
    done.push({ sku: i.sku, qty: i.qty });
  }
}
async function releaseStock(d: Deps, s: CheckoutSession) { for (const i of s.items) await d.store.adjustStock(i.sku, i.qty); }

export interface CompleteInput { payment_mode: 'mandate' | 'approval_link'; mandate_token?: string; idempotency_key: string }

export async function completeCheckout(d: Deps, ctx: AgentCtx, id: string, input: CompleteInput) {
  if (!input.idempotency_key || input.idempotency_key.length < 8 || input.idempotency_key.length > 100) throw new DomainError('idempotency_key_required', 'idempotency_key (8-100 chars) is required', 400);
  const idemKey = `${ctx.agentId}:${input.idempotency_key}`;
  const prior = await d.store.getSessionByIdempotencyKey(idemKey);
  if (prior) {
    if (prior.id !== id) throw new DomainError('idempotency_conflict', 'idempotency_key was already used for a different checkout', 409);
    await emit(d, 'checkout.idempotent_replay', { sessionId: prior.id, agentId: ctx.agentId, data: { status: prior.status } });
    return prior;
  }
  const s = await getOwnSession(d, ctx, id);
  if (s.status !== 'open') throw new DomainError('not_open', `Checkout is already ${s.status}`, 409);
  const agent = await touchAgent(d, ctx);
  const q = await requote(d, s); // prices and stock re-checked at completion time
  applyTotals(s, q);
  s.idempotencyKey = idemKey;
  s.paymentMode = input.payment_mode;
  const now = d.clock.now().toISOString();
  s.updatedAt = now;

  if (input.payment_mode === 'approval_link') {
    const risk = assessApprovalLink(s, agent);
    if (risk.action === 'reject') return reject(d, s, risk.reason);
    await reserveStock(d, s);
    const base = d.config.publicBaseUrl;
    const order = await d.payments.createOrderForApproval({ ...orderInput(s, `${s.id}-order`, d.config.merchantName), returnUrl: `${base}/checkout/return`, cancelUrl: `${base}/checkout/cancel`, brandName: d.config.merchantName });
    s.paypalOrderId = order.orderId; s.approveUrl = order.approveUrl; s.status = 'requires_buyer_action';
    await d.store.updateSession(s);
    await emit(d, 'checkout.requires_buyer_action', { sessionId: s.id, agentId: ctx.agentId, data: { orderId: order.orderId, totalCents: s.totalCents } });
    return s;
  }

  if (input.payment_mode !== 'mandate') throw new DomainError('invalid_payment_mode', 'payment_mode must be mandate or approval_link');
  let mandate: Mandate;
  try { mandate = await resolveMandate(d, input.mandate_token); }
  catch (e) {
    await emit(d, 'checkout.mandate_denied', { sessionId: s.id, agentId: ctx.agentId, data: { code: (e as DomainError).code } });
    throw e;
  }
  s.mandateId = mandate.id;
  const blocked = s.items.find((i) => !mandate.allowedCategories.includes(i.category));
  if (blocked) return reject(d, s, `category_not_allowed:${blocked.category}`);
  const risk = assessMandateCharge(s, agent, await d.store.countCompletedByAgentSince(ctx.agentId, new Date(d.clock.now().getTime() - RISK.velocityWindowMin * 60_000).toISOString()));
  if (risk.action === 'reject') return reject(d, s, risk.reason);
  const r = await d.ledger.reserve(mandate.id, { sessionId: s.id, cents: s.totalCents, perOrderCapCents: mandate.perOrderCapCents, monthlyCapCents: mandate.monthlyCapCents, now });
  if (!r.ok) return reject(d, s, r.reason ?? 'cap');
  await reserveStock(d, s).catch(async (e) => { await d.ledger.release(mandate.id, s.id, now); throw e; });
  if (risk.action === 'hold') {
    s.status = 'on_hold'; s.holdReason = risk.reason;
    await d.store.updateSession(s);
    await d.store.insertApproval({ id: d.ids.id('apr'), kind: 'order_release', status: 'pending', sessionId: s.id, payload: { sessionId: s.id, totalCents: s.totalCents, agentId: s.agentId }, reason: risk.reason, requestedBy: 'risk_policy', decidedBy: null, result: null, createdAt: now, decidedAt: null });
    await emit(d, 'checkout.on_hold', { sessionId: s.id, agentId: ctx.agentId, data: { reason: risk.reason, totalCents: s.totalCents } });
    return s;
  }
  await d.store.updateSession(s);
  return chargeMandate(d, s, mandate);
}

async function reject(d: Deps, s: CheckoutSession, reason: string) {
  s.status = 'rejected'; s.rejectReason = reason; s.updatedAt = d.clock.now().toISOString();
  await d.store.updateSession(s);
  await emit(d, 'checkout.rejected', { sessionId: s.id, agentId: s.agentId, data: { reason, totalCents: s.totalCents } });
  return s;
}

/** Buyer-absent charge against the vaulted PayPal wallet. Caller has already reserved ledger headroom and stock. */
export async function chargeMandate(d: Deps, s: CheckoutSession, mandate: Mandate) {
  const now = d.clock.now().toISOString();
  const from = s.status; // 'open' (direct) or 'on_hold' (merchant released)
  let order: OrderResult;
  try {
    order = await d.payments.chargeVaulted({ ...orderInput(s, `${s.id}-charge`, d.config.merchantName), vaultId: mandate.vaultId! });
  } catch (e) {
    await d.ledger.release(mandate.id, s.id, now); await releaseStock(d, s);
    s.status = 'failed'; s.rejectReason = `payment_error: ${(e as Error).message.slice(0, 200)}`; s.updatedAt = now;
    await d.store.updateSession(s);
    await emit(d, 'payment.failed', { sessionId: s.id, agentId: s.agentId, data: { error: (e as Error).message.slice(0, 200) } });
    return s;
  }
  s.paypalOrderId = order.orderId;
  if (isCaptured(order)) {
    await d.ledger.commit(mandate.id, s.id, now);
    return finalizeCaptured(d, s, order, from);
  }
  await d.ledger.release(mandate.id, s.id, now); await releaseStock(d, s);
  s.status = 'failed'; s.rejectReason = `capture_${(order.captureStatus ?? order.status).toLowerCase()}`; s.updatedAt = now;
  await d.store.updateSession(s);
  await emit(d, 'payment.declined', { sessionId: s.id, agentId: s.agentId, data: { orderId: order.orderId, status: order.captureStatus } });
  return s;
}

async function finalizeCaptured(d: Deps, s: CheckoutSession, order: OrderResult, expected: CheckoutSession['status']) {
  const now = d.clock.now().toISOString();
  s.paypalOrderId = order.orderId; s.captureId = order.captureId; s.status = 'completed'; s.completedAt = now; s.updatedAt = now;
  // Compare-and-set: if a concurrent path (return URL vs CHECKOUT.ORDER.APPROVED webhook) already finalized this
  // session, do not record the payment or emit payment.captured a second time.
  if (!(await d.store.updateSessionIfStatus(s, expected))) return (await d.store.getSession(s.id)) ?? s;
  await d.store.insertPayment({ id: d.ids.id('pay'), sessionId: s.id, paypalOrderId: order.orderId, captureId: order.captureId, amountCents: s.totalCents, refundedCents: 0, status: order.captureStatus === 'PENDING' ? 'pending' : 'completed', createdAt: now, updatedAt: now });
  await emit(d, 'payment.captured', { sessionId: s.id, agentId: s.agentId, data: { orderId: order.orderId, captureId: order.captureId, totalCents: s.totalCents, mode: s.paymentMode } });
  if ((order.captureCount ?? 1) > 1) await emit(d, 'payment.multiple_captures', { sessionId: s.id, agentId: s.agentId, data: { orderId: order.orderId, captureCount: order.captureCount } });
  await promoteIfEarned(d, s.agentId);
  return s;
}

const isCaptured = (o: OrderResult) => o.captureStatus === 'COMPLETED' || o.captureStatus === 'PENDING';

/**
 * Called from the PayPal return URL or the CHECKOUT.ORDER.APPROVED webhook. Idempotent and double-capture safe:
 * 1. a session that is already completed returns as is;
 * 2. the PayPal order is read first: if it is already captured (say the other path won, or we crashed after capturing)
 *    we record that capture instead of calling capture again; if the buyer has not approved, nothing is captured;
 * 3. the capture call uses a stable PayPal-Request-Id per session, so a retry replays PayPal's first response;
 * 4. the session moves to completed with a compare-and-set, so only one caller records the payment.
 */
export async function captureApprovedOrder(d: Deps, orderId: string) {
  const s = await d.store.getSessionByOrderId(orderId);
  if (!s) throw new DomainError('not_found', 'Unknown order', 404);
  if (s.status === 'completed') return s;
  if (s.status !== 'requires_buyer_action') throw new DomainError('bad_state', `Checkout is ${s.status}`, 409);
  const current = await d.payments.getOrder(orderId);
  let order: OrderResult;
  if (current.status === 'COMPLETED' && isCaptured(current)) {
    order = current;
    await emit(d, 'payment.capture_reconciled', { sessionId: s.id, agentId: s.agentId, data: { orderId, captureId: current.captureId } });
  } else if (current.status !== 'APPROVED') {
    throw new DomainError('not_approved', `PayPal order is ${current.status}; the buyer has not approved it yet`, 409);
  } else {
    order = await d.payments.captureOrder(orderId, `${s.id}-capture`);
  }
  if (isCaptured(order)) return finalizeCaptured(d, s, order, 'requires_buyer_action');
  const failed: CheckoutSession = { ...s, status: 'failed', rejectReason: `capture_${(order.captureStatus ?? order.status).toLowerCase()}`, updatedAt: d.clock.now().toISOString() };
  if (await d.store.updateSessionIfStatus(failed, 'requires_buyer_action')) { await releaseStock(d, s); return failed; }
  return (await d.store.getSession(s.id)) ?? failed;
}

export async function cancelBuyerAction(d: Deps, orderId: string) {
  const s = await d.store.getSessionByOrderId(orderId);
  if (!s || s.status !== 'requires_buyer_action') return s;
  await releaseStock(d, s);
  s.status = 'canceled'; s.updatedAt = d.clock.now().toISOString();
  await d.store.updateSession(s);
  await emit(d, 'checkout.canceled', { sessionId: s.id, agentId: s.agentId, data: { by: 'buyer' } });
  return s;
}

export async function cancelCheckout(d: Deps, ctx: AgentCtx, id: string) {
  const s = await getOwnSession(d, ctx, id);
  if (s.status !== 'open') throw new DomainError('not_open', `Checkout is ${s.status}`, 409);
  s.status = 'canceled'; s.updatedAt = d.clock.now().toISOString();
  await d.store.updateSession(s);
  await emit(d, 'checkout.canceled', { sessionId: s.id, agentId: ctx.agentId, data: { by: 'agent' } });
  return s;
}

/** Merchant approved a held order: charge now. */
export async function releaseHeld(d: Deps, sessionId: string) {
  const s = await d.store.getSession(sessionId);
  if (!s || s.status !== 'on_hold' || !s.mandateId) throw new DomainError('bad_state', 'Session is not on hold', 409);
  const m = await d.store.getMandate(s.mandateId);
  if (!m || m.status !== 'active' || !m.vaultId) {
    await d.ledger.release(s.mandateId, s.id, d.clock.now().toISOString()); await releaseStock(d, s);
    return reject(d, s, 'mandate_no_longer_active');
  }
  s.holdReason = null;
  return chargeMandate(d, s, m);
}

export async function declineHeld(d: Deps, sessionId: string, reason: string) {
  const s = await d.store.getSession(sessionId);
  if (!s || s.status !== 'on_hold' || !s.mandateId) throw new DomainError('bad_state', 'Session is not on hold', 409);
  await d.ledger.release(s.mandateId, s.id, d.clock.now().toISOString());
  await releaseStock(d, s);
  return reject(d, s, `merchant_declined: ${reason}`.slice(0, 200));
}

export async function refundSession(d: Deps, sessionId: string, cents: number | null, note: string) {
  const s = await d.store.getSession(sessionId);
  const p = s ? await d.store.getPaymentBySession(sessionId) : null;
  if (!s || !p || !p.captureId) throw new DomainError('not_refundable', 'No captured payment for this session', 409);
  const remaining = p.amountCents - p.refundedCents;
  const amount = cents ?? remaining;
  if (amount <= 0 || amount > remaining) throw new DomainError('refund_amount', `Refund must be between 1 and ${remaining} cents`, 400);
  const r = await d.payments.refundCapture(p.captureId, amount, `${s.id}-refund-${p.refundedCents + amount}`, note);
  const now = d.clock.now().toISOString();
  p.refundedCents += amount; p.status = p.refundedCents >= p.amountCents ? 'refunded' : 'partially_refunded'; p.updatedAt = now;
  await d.store.updatePayment(p);
  if (s.mandateId) await d.ledger.credit(s.mandateId, amount, now);
  await emit(d, 'payment.refunded', { sessionId: s.id, agentId: s.agentId, data: { amountCents: amount, refundId: r.refundId } });
  return { refundId: r.refundId, amountCents: amount, status: r.status };
}
