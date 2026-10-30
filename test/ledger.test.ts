import { describe, it, expect } from 'vitest';
import { LedgerCore } from '../src/domain/ledger';
import { assessMandateCharge, RISK } from '../src/domain/risk';

const now = '2026-11-05T12:00:00.000Z';
describe('mandate ledger (Durable Object core)', () => {
  const base = { perOrderCapCents: 5000, monthlyCapCents: 10000, now };
  it('enforces per-order and monthly caps including pending reservations', () => {
    const l = new LedgerCore(null);
    expect(l.reserve({ ...base, sessionId: 'a', cents: 6000 }).ok).toBe(false);
    expect(l.reserve({ ...base, sessionId: 'a', cents: 5000 }).ok).toBe(true);
    expect(l.reserve({ ...base, sessionId: 'b', cents: 5000 }).ok).toBe(true);
    expect(l.reserve({ ...base, sessionId: 'c', cents: 1 }).ok).toBe(false); // month full via pending
    l.release('b', now);
    expect(l.reserve({ ...base, sessionId: 'c', cents: 4000 }).ok).toBe(true);
  });
  it('is idempotent per session and credits refunds', () => {
    const l = new LedgerCore(null);
    l.reserve({ ...base, sessionId: 'a', cents: 5000 });
    l.reserve({ ...base, sessionId: 'a', cents: 5000 });
    expect(l.snapshot(now).reservedCents).toBe(5000);
    l.commit('a', now);
    expect(l.snapshot(now).spentCents).toBe(5000);
    l.credit(2000, now);
    expect(l.snapshot(now).spentCents).toBe(3000);
  });
  it('rolls over at month boundary', () => {
    const l = new LedgerCore(null);
    l.reserve({ ...base, sessionId: 'a', cents: 5000 }); l.commit('a', now);
    expect(l.snapshot('2026-12-01T00:00:01.000Z').spentCents).toBe(0);
  });
});

describe('risk', () => {
  const s: any = { totalCents: 3000 };
  const known: any = { trust: 'known' }, fresh: any = { trust: 'new' }, blocked: any = { trust: 'blocked' };
  it('rejects blocked, holds velocity / large / new+medium, allows normal', () => {
    expect(assessMandateCharge(s, blocked, 0).action).toBe('reject');
    expect(assessMandateCharge(s, known, RISK.velocityMaxOrders).action).toBe('hold');
    expect(assessMandateCharge({ totalCents: RISK.holdAboveCents + 1 } as any, known, 0).action).toBe('hold');
    expect(assessMandateCharge({ totalCents: RISK.newAgentHoldAboveCents + 1 } as any, fresh, 0).action).toBe('hold');
    expect(assessMandateCharge(s, fresh, 0).action).toBe('allow');
  });
});
