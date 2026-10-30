// Buyer mandates: the buyer saves PayPal once (buyer present) and gets a scoped, capped token for their agent.
// The agent only ever holds the mandate token, never a PayPal credential or vault id.
import type { Deps } from './deps';
import { emit, sha256 } from './deps';
import { DomainError, type Category, type Mandate } from './types';

export const MANDATE_LIMITS = { maxPerOrderCents: 50000, maxMonthlyCents: 200000, maxTtlDays: 90 };
const ALL: Category[] = ['single_origin', 'blend', 'reserve', 'gear'];

export interface CreateMandateInput { buyerName: string; buyerEmail?: string; perOrderCapCents: number; monthlyCapCents: number; allowedCategories?: Category[]; ttlDays?: number }

function validate(i: CreateMandateInput) {
  if (!i.buyerName || i.buyerName.length > 80) throw new DomainError('invalid_buyer', 'buyerName required (max 80 chars)');
  if (!Number.isInteger(i.perOrderCapCents) || i.perOrderCapCents < 100 || i.perOrderCapCents > MANDATE_LIMITS.maxPerOrderCents) throw new DomainError('invalid_cap', `perOrderCapCents must be 100..${MANDATE_LIMITS.maxPerOrderCents}`);
  if (!Number.isInteger(i.monthlyCapCents) || i.monthlyCapCents < i.perOrderCapCents || i.monthlyCapCents > MANDATE_LIMITS.maxMonthlyCents) throw new DomainError('invalid_cap', `monthlyCapCents must be >= perOrderCapCents and <= ${MANDATE_LIMITS.maxMonthlyCents}`);
  const cats = i.allowedCategories ?? ['single_origin', 'blend'];
  if (!cats.length || cats.some((c) => !ALL.includes(c))) throw new DomainError('invalid_categories', 'allowedCategories invalid');
  const ttl = i.ttlDays ?? 30;
  if (ttl < 1 || ttl > MANDATE_LIMITS.maxTtlDays) throw new DomainError('invalid_ttl', `ttlDays must be 1..${MANDATE_LIMITS.maxTtlDays}`);
  return { cats, ttl };
}

/** Step 1 (buyer present): create a pending mandate + PayPal setup token. Returns the one-time mandate token. */
export async function startMandate(d: Deps, i: CreateMandateInput) {
  const { cats, ttl } = validate(i);
  const id = d.ids.id('mdt');
  const token = d.ids.secret();
  const base = d.config.publicBaseUrl;
  const st = await d.payments.createSetupToken({ requestId: `${id}-setup`, returnUrl: `${base}/mandates/return?mandate=${id}`, cancelUrl: `${base}/mandates/cancel?mandate=${id}`, description: `${d.config.merchantName} agent purchases (capped mandate)`, brandName: d.config.merchantName });
  const now = d.clock.now();
  const m: Mandate = {
    id, buyerName: i.buyerName, buyerEmail: i.buyerEmail ?? null, tokenHash: await sha256(token), status: 'pending', vaultId: null,
    paypalCustomerId: st.customerId, setupTokenId: st.setupTokenId, approveUrl: st.approveUrl, perOrderCapCents: i.perOrderCapCents,
    monthlyCapCents: i.monthlyCapCents, allowedCategories: cats, expiresAt: new Date(now.getTime() + ttl * 86400_000).toISOString(), createdAt: now.toISOString(),
  };
  await d.store.insertMandate(m);
  await emit(d, 'mandate.started', { data: { mandateId: id, perOrderCapCents: m.perOrderCapCents, monthlyCapCents: m.monthlyCapCents } });
  if (st.status === 'APPROVED') await finishMandate(d, id);
  return { mandate: (await d.store.getMandate(id))!, mandateToken: token, approveUrl: st.approveUrl };
}

/** Step 2 (after buyer approval on PayPal): exchange the approved setup token for a vaulted payment token. */
export async function finishMandate(d: Deps, mandateId: string) {
  const m = await d.store.getMandate(mandateId);
  if (!m) throw new DomainError('not_found', 'Unknown mandate', 404);
  if (m.status === 'active') return m;
  if (m.status !== 'pending' || !m.setupTokenId) throw new DomainError('bad_state', `Mandate is ${m.status}`, 409);
  const st = await d.payments.getSetupToken(m.setupTokenId);
  if (st.status !== 'APPROVED') throw new DomainError('not_approved', `Setup token is ${st.status}`, 409);
  const pt = await d.payments.createPaymentToken({ requestId: `${m.id}-ptoken`, setupTokenId: m.setupTokenId });
  const next: Mandate = { ...m, status: 'active', vaultId: pt.vaultId, paypalCustomerId: pt.customerId ?? m.paypalCustomerId };
  await d.store.updateMandate(next);
  await emit(d, 'mandate.activated', { data: { mandateId: m.id } });
  return next;
}

/** Register a mandate around a vault id obtained out-of-band (e.g. by scripts/sandbox-go-no-go.mjs). */
export async function importVaultedMandate(d: Deps, i: CreateMandateInput & { vaultId: string; customerId?: string; token?: string }) {
  const { cats, ttl } = validate(i);
  const id = d.ids.id('mdt');
  const token = i.token ?? d.ids.secret();
  const now = d.clock.now();
  const m: Mandate = { id, buyerName: i.buyerName, buyerEmail: i.buyerEmail ?? null, tokenHash: await sha256(token), status: 'active', vaultId: i.vaultId, paypalCustomerId: i.customerId ?? null, setupTokenId: null, approveUrl: null, perOrderCapCents: i.perOrderCapCents, monthlyCapCents: i.monthlyCapCents, allowedCategories: cats, expiresAt: new Date(now.getTime() + ttl * 86400_000).toISOString(), createdAt: now.toISOString() };
  await d.store.insertMandate(m);
  await emit(d, 'mandate.activated', { data: { mandateId: id, imported: true } });
  return { mandate: m, mandateToken: token };
}

export async function revokeMandate(d: Deps, mandateId: string) {
  const m = await d.store.getMandate(mandateId);
  if (!m) throw new DomainError('not_found', 'Unknown mandate', 404);
  const next: Mandate = { ...m, status: 'revoked' };
  await d.store.updateMandate(next);
  await emit(d, 'mandate.revoked', { data: { mandateId } });
  return next;
}

export async function mandateView(d: Deps, m: Mandate) {
  const snap = await d.ledger.snapshot(m.id, d.clock.now().toISOString());
  return { id: m.id, buyerName: m.buyerName, status: m.status, perOrderCapCents: m.perOrderCapCents, monthlyCapCents: m.monthlyCapCents,
    allowedCategories: m.allowedCategories, expiresAt: m.expiresAt, spentThisMonthCents: snap.spentCents, reservedCents: snap.reservedCents,
    remainingCents: Math.max(0, m.monthlyCapCents - snap.spentCents - snap.reservedCents), hasVault: !!m.vaultId };
}
