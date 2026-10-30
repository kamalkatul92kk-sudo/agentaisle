// Spend ledger for mandates. In production one Durable Object instance per mandate serialises access,
// so two agents racing the same mandate can never both slip under the cap.
import type { LedgerSnapshot, MandateLedgerClient, ReserveResult } from '../ports';

export interface LedgerState { month: string; spentCents: number; reservations: Record<string, number> }
const monthOf = (iso: string) => iso.slice(0, 7);

export class LedgerCore {
  constructor(private state: LedgerState | null) {}
  get(): LedgerState { return this.state ?? { month: '', spentCents: 0, reservations: {} }; }
  private roll(now: string): LedgerState {
    const s = this.get();
    if (s.month !== monthOf(now)) this.state = { month: monthOf(now), spentCents: 0, reservations: s.reservations };
    else this.state = s;
    return this.state;
  }
  reserve(input: { sessionId: string; cents: number; perOrderCapCents: number; monthlyCapCents: number; now: string }): ReserveResult {
    const s = this.roll(input.now);
    const reserved = () => Object.values(s.reservations).reduce((a, b) => a + b, 0);
    if (s.reservations[input.sessionId] != null) return { ok: true, reason: 'duplicate', spentThisMonthCents: s.spentCents, reservedCents: reserved() };
    if (input.cents > input.perOrderCapCents) return { ok: false, reason: 'per_order_cap', spentThisMonthCents: s.spentCents, reservedCents: reserved() };
    if (s.spentCents + reserved() + input.cents > input.monthlyCapCents) return { ok: false, reason: 'monthly_cap', spentThisMonthCents: s.spentCents, reservedCents: reserved() };
    s.reservations[input.sessionId] = input.cents;
    return { ok: true, spentThisMonthCents: s.spentCents, reservedCents: reserved() };
  }
  commit(sessionId: string, now: string) {
    const s = this.roll(now);
    const c = s.reservations[sessionId];
    if (c == null) return;
    delete s.reservations[sessionId];
    s.spentCents += c;
  }
  release(sessionId: string, now: string) { const s = this.roll(now); delete s.reservations[sessionId]; }
  credit(cents: number, now: string) { const s = this.roll(now); s.spentCents = Math.max(0, s.spentCents - cents); }
  snapshot(now: string): LedgerSnapshot {
    const s = this.roll(now);
    return { month: s.month, spentCents: s.spentCents, reservedCents: Object.values(s.reservations).reduce((a, b) => a + b, 0), reservations: { ...s.reservations } };
  }
}

/** In-memory ledger used by tests and the Node simulator. */
export class InMemoryLedger implements MandateLedgerClient {
  private cores = new Map<string, LedgerCore>();
  private core(id: string) { let c = this.cores.get(id); if (!c) { c = new LedgerCore(null); this.cores.set(id, c); } return c; }
  async reserve(id: string, input: Parameters<LedgerCore['reserve']>[0]) { return this.core(id).reserve(input); }
  async commit(id: string, sessionId: string, now: string) { this.core(id).commit(sessionId, now); }
  async release(id: string, sessionId: string, now: string) { this.core(id).release(sessionId, now); }
  async credit(id: string, cents: number, now: string) { this.core(id).credit(cents, now); }
  async snapshot(id: string, now: string) { return this.core(id).snapshot(now); }
}
