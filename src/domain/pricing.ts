// Deterministic pricing + negotiation rules. The LLM never decides a price; it may only phrase messages.
import { MERCHANT } from './catalog';
import { bps } from './money';
import { DomainError, type LineItem, type NegotiationRound, type NegotiationState, type Product } from './types';

export const LIMITS = { maxQtyPerLine: 10, maxBagsPerOrder: 20, maxLines: 12, maxRounds: 3 };
/** Fraction of the (list - floor) gap the merchant still asks for in round 1..3. */
export const ASK_CURVE = [0.6, 0.3, 0];
export const BUNDLE_TIERS = [ { minBags: 5, bps: 800 }, { minBags: 3, bps: 500 } ];
export const FLOOR_MARKUP = 1.3; // never sell below cost * 1.3

export interface Quote {
  items: LineItem[];
  subtotalCents: number;
  bundleDiscountCents: number;
  goodsAfterBundleCents: number;
  floorCents: number;          // lowest goods total the merchant will ever accept (never exposed to agents)
  negotiable: boolean;
  bags: number;
}

export function lineFloorCents(p: Product): number {
  if (!p.negotiable || p.maxDiscountBps <= 0) return p.priceCents;
  const costFloor = Math.ceil(p.costCents * FLOOR_MARKUP);
  const discountFloor = p.priceCents - bps(p.priceCents, p.maxDiscountBps);
  return Math.min(p.priceCents, Math.max(costFloor, discountFloor));
}

export function quote(req: { sku: string; qty: number }[], catalog: Map<string, Product>): Quote {
  if (!Array.isArray(req) || req.length === 0) throw new DomainError('empty_cart', 'Cart must contain at least one item');
  if (req.length > LIMITS.maxLines) throw new DomainError('too_many_lines', `At most ${LIMITS.maxLines} distinct items`);
  const merged = new Map<string, number>();
  for (const r of req) {
    if (!Number.isInteger(r.qty) || r.qty < 1) throw new DomainError('invalid_qty', `Quantity for ${r.sku} must be a positive integer`);
    merged.set(r.sku, (merged.get(r.sku) ?? 0) + r.qty);
  }
  const items: LineItem[] = [];
  let subtotal = 0, floor = 0, bags = 0, negotiable = false, bundleEligible = 0, bundleEligibleFloor = 0;
  for (const [sku, qty] of merged) {
    const p = catalog.get(sku);
    if (!p || !p.active) throw new DomainError('unknown_sku', `Unknown or unavailable SKU ${sku}`, 404);
    if (qty > LIMITS.maxQtyPerLine) throw new DomainError('qty_limit', `At most ${LIMITS.maxQtyPerLine} of ${sku} per order`);
    if (qty > p.stock) throw new DomainError('out_of_stock', `Only ${p.stock} of ${sku} in stock`, 409);
    const line = p.priceCents * qty;
    items.push({ sku, name: p.name, qty, unitPriceCents: p.priceCents, lineTotalCents: line, category: p.category });
    subtotal += line;
    const lf = lineFloorCents(p) * qty;
    floor += lf;
    if (p.category !== 'gear') bags += qty;
    if (p.negotiable) { negotiable = true; bundleEligible += line; bundleEligibleFloor += lf; }
  }
  if (bags > LIMITS.maxBagsPerOrder) throw new DomainError('bag_limit', `At most ${LIMITS.maxBagsPerOrder} bags per order`);
  const tier = BUNDLE_TIERS.find((t) => bags >= t.minBags);
  // Bundle discount applies only to negotiable lines and can never push those lines below their floor.
  const bundle = tier ? Math.min(bps(bundleEligible, tier.bps), bundleEligible - bundleEligibleFloor) : 0;
  return { items, subtotalCents: subtotal, bundleDiscountCents: bundle, goodsAfterBundleCents: subtotal - bundle, floorCents: floor, negotiable, bags };
}

export function shippingFor(goodsCents: number): number {
  return goodsCents >= MERCHANT.freeShippingThresholdCents ? 0 : MERCHANT.flatShippingCents;
}

export function askForRound(q: Quote, round: number): number {
  const f = ASK_CURVE[Math.min(round, ASK_CURVE.length) - 1] ?? 0;
  return q.floorCents + Math.round((q.goodsAfterBundleCents - q.floorCents) * f);
}

export function emptyNegotiation(): NegotiationState {
  return { rounds: [], agreedTotalBeforeShippingCents: null, locked: false };
}

export interface NegotiationDecision { decision: NegotiationRound['decision']; merchantPriceCents: number; round: number; final: boolean; agreedCents: number | null }

/** offerCents is the buyer's proposed goods total (before shipping). */
export function decideOffer(q: Quote, state: NegotiationState, offerCents: number): NegotiationDecision {
  if (!Number.isInteger(offerCents) || offerCents <= 0) throw new DomainError('invalid_offer', 'Offer must be a positive integer number of cents');
  if (state.locked) throw new DomainError('negotiation_closed', 'Negotiation for this checkout is closed', 409);
  if (!q.negotiable || q.floorCents >= q.goodsAfterBundleCents) {
    return { decision: 'reject', merchantPriceCents: q.goodsAfterBundleCents, round: state.rounds.length + 1, final: true, agreedCents: null };
  }
  const round = state.rounds.length + 1;
  const ask = askForRound(q, round);
  if (offerCents >= ask) {
    const agreed = Math.min(offerCents, q.goodsAfterBundleCents);
    return { decision: 'accept', merchantPriceCents: agreed, round, final: true, agreedCents: agreed };
  }
  if (round >= LIMITS.maxRounds) {
    return { decision: 'reject', merchantPriceCents: q.goodsAfterBundleCents, round, final: true, agreedCents: null };
  }
  return { decision: 'counter', merchantPriceCents: ask, round, final: false, agreedCents: null };
}

export interface Totals { subtotalCents: number; bundleDiscountCents: number; negotiatedDiscountCents: number; shippingCents: number; totalCents: number }
export function totalsFor(q: Quote, agreedGoodsCents: number | null): Totals {
  const goods = agreedGoodsCents == null ? q.goodsAfterBundleCents : Math.max(agreedGoodsCents, q.floorCents);
  const negotiated = q.goodsAfterBundleCents - goods;
  const shipping = shippingFor(goods);
  return { subtotalCents: q.subtotalCents, bundleDiscountCents: q.bundleDiscountCents, negotiatedDiscountCents: negotiated, shippingCents: shipping, totalCents: goods + shipping };
}
