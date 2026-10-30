import { DurableObject } from 'cloudflare:workers';
import { LedgerCore, type LedgerState } from '../domain/ledger';
import type { LedgerSnapshot, MandateLedgerClient, ReserveResult } from '../ports';

/** One instance per mandate (idFromName(mandateId)); single-threaded, so cap checks are race-free. */
export class MandateLedger extends DurableObject {
  private async load() { return new LedgerCore((await this.ctx.storage.get<LedgerState>('s')) ?? null); }
  private async save(c: LedgerCore) { await this.ctx.storage.put('s', c.get()); }
  async reserve(input: Parameters<LedgerCore['reserve']>[0]): Promise<ReserveResult> { const c = await this.load(); const r = c.reserve(input); await this.save(c); return r; }
  async commit(sessionId: string, now: string) { const c = await this.load(); c.commit(sessionId, now); await this.save(c); }
  async release(sessionId: string, now: string) { const c = await this.load(); c.release(sessionId, now); await this.save(c); }
  async credit(cents: number, now: string) { const c = await this.load(); c.credit(cents, now); await this.save(c); }
  async snapshot(now: string): Promise<LedgerSnapshot> { const c = await this.load(); const s = c.snapshot(now); await this.save(c); return s; }
}

export class DurableLedgerClient implements MandateLedgerClient {
  constructor(private ns: DurableObjectNamespace<MandateLedger>) {}
  private stub(id: string) { return this.ns.get(this.ns.idFromName(id)); }
  reserve(id: string, input: Parameters<LedgerCore['reserve']>[0]) { return this.stub(id).reserve(input) as Promise<ReserveResult>; }
  async commit(id: string, s: string, now: string) { await this.stub(id).commit(s, now); }
  async release(id: string, s: string, now: string) { await this.stub(id).release(s, now); }
  async credit(id: string, cents: number, now: string) { await this.stub(id).credit(cents, now); }
  snapshot(id: string, now: string) { return this.stub(id).snapshot(now) as Promise<LedgerSnapshot>; }
}
