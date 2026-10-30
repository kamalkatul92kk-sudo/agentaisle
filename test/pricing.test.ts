import { describe, it, expect } from 'vitest';
import { seedProducts } from '../src/domain/catalog';
import { quote, lineFloorCents, decideOffer, emptyNegotiation, totalsFor, shippingFor, askForRound, LIMITS } from '../src/domain/pricing';
import { fmt, toValue, fromValue } from '../src/domain/money';

const cat = new Map(seedProducts('2026-11-01T00:00:00Z').map((p) => [p.sku, p]));
const P = (sku: string) => cat.get(sku)!;

describe('money', () => {
  it('formats and round-trips integer cents', () => {
    expect(fmt(1999)).toBe('$19.99');
    expect(toValue(5)).toBe('0.05');
    expect(fromValue('12.30')).toBe(1230);
  });
});

describe('catalog', () => {
  it('is fictional Texas roaster data with sane economics', () => {
    expect(cat.size).toBe(14);
    for (const p of cat.values()) {
      expect(p.priceCents).toBeGreaterThan(p.costCents);
      expect(lineFloorCents(p)).toBeGreaterThanOrEqual(Math.ceil(p.costCents * 1.3));
      expect(lineFloorCents(p)).toBeLessThanOrEqual(p.priceCents);
    }
    expect(lineFloorCents(P('PP-RS-PAN-8'))).toBe(P('PP-RS-PAN-8').priceCents); // reserve not negotiable
  });
});

describe('quote', () => {
  it('applies bundle tiers at 3 and 5 bags', () => {
    const one = quote([{ sku: 'PP-SO-ETH-12', qty: 1 }], cat);
    const three = quote([{ sku: 'PP-SO-ETH-12', qty: 3 }], cat);
    const five = quote([{ sku: 'PP-SO-ETH-12', qty: 5 }], cat);
    expect(one.bundleDiscountCents).toBe(0);
    expect(three.bundleDiscountCents).toBeGreaterThan(0);
    expect(five.bundleDiscountCents / five.subtotalCents).toBeGreaterThan(three.bundleDiscountCents / three.subtotalCents);
    expect(five.goodsAfterBundleCents).toBeGreaterThanOrEqual(five.floorCents);
  });
  it('rejects unknown SKUs, zero/over qty and too many bags', () => {
    expect(() => quote([{ sku: 'NOPE', qty: 1 }], cat)).toThrow();
    expect(() => quote([{ sku: 'PP-SO-ETH-12', qty: 0 }], cat)).toThrow();
    expect(() => quote([{ sku: 'PP-SO-ETH-12', qty: LIMITS.maxQtyPerLine + 1 }], cat)).toThrow();
    expect(() => quote([{ sku: 'PP-SO-ETH-12', qty: 10 }, { sku: 'PP-SO-COL-12', qty: 10 }, { sku: 'PP-SO-GUA-12', qty: 1 }], cat)).toThrow();
  });
  it('free shipping at $50', () => {
    expect(shippingFor(4999)).toBe(699);
    expect(shippingFor(5000)).toBe(0);
  });
});

describe('negotiation', () => {
  const q = quote([{ sku: 'PP-SO-KEN-12', qty: 2 }, { sku: 'PP-BL-HC-12', qty: 2 }], cat);
  it('never accepts below floor across all rounds', () => {
    let st = emptyNegotiation();
    for (let r = 0; r < 3; r++) {
      const dcs = decideOffer(q, st, 1);
      expect(dcs.decision).not.toBe('accept');
      expect(dcs.merchantPriceCents).toBeGreaterThanOrEqual(q.floorCents);
      st = { ...st, rounds: [...st.rounds, { round: r + 1, offerCents: 1, merchantPriceCents: dcs.merchantPriceCents, decision: dcs.decision, message: '', at: '' }], locked: dcs.final };
    }
    expect(st.locked).toBe(true);
    expect(st.rounds.at(-1)!.decision).toBe('reject');
  });
  it('accepts an offer at the ask and the ask descends toward floor', () => {
    expect(askForRound(q, 1)).toBeGreaterThan(askForRound(q, 2));
    expect(askForRound(q, 3)).toBe(q.floorCents);
    const dcs = decideOffer(q, emptyNegotiation(), askForRound(q, 1));
    expect(dcs.decision).toBe('accept');
    expect(dcs.agreedCents).toBe(askForRound(q, 1));
  });
  it('caps agreed price at list (overpaying is not possible)', () => {
    const dcs = decideOffer(q, emptyNegotiation(), q.goodsAfterBundleCents + 5000);
    expect(dcs.agreedCents).toBeLessThanOrEqual(q.goodsAfterBundleCents);
  });
  it('totals add up', () => {
    const t = totalsFor(q, q.floorCents);
    expect(t.totalCents).toBe(t.subtotalCents - t.bundleDiscountCents - t.negotiatedDiscountCents + t.shippingCents);
  });
});
