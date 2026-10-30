// Pure, framework-free logic behind the AG Grid Community console: row diffs for live transactions,
// client-side rollups (our Community-legal stand-in for Enterprise row grouping/pivot), lifecycle steps,
// saved views. No React or AG Grid imports, so it is unit-tested from the root vitest suite.
import type { SessionRow } from '../../../src/shared/contracts';

// ---------- live transactions ----------
export interface RowTx<T> { add: T[]; update: T[]; remove: T[] }
/** Delta between two snapshots, keyed by id. `same` decides whether a kept row changed. */
export function diffRows<T>(prev: T[], next: T[], id: (r: T) => string, same: (a: T, b: T) => boolean = shallowEqual): RowTx<T> {
  const before = new Map(prev.map((r) => [id(r), r]));
  const after = new Set<string>();
  const add: T[] = []; const update: T[] = [];
  for (const r of next) {
    const k = id(r); after.add(k);
    const old = before.get(k);
    if (!old) add.push(r); else if (!same(old, r)) update.push(r);
  }
  const remove = prev.filter((r) => !after.has(id(r)));
  return { add, update, remove };
}
export const isEmptyTx = (t: RowTx<unknown>) => !t.add.length && !t.update.length && !t.remove.length;
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object); const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => (a as any)[k] === (b as any)[k]);
}

// ---------- payment lifecycle ----------
export type StepState = 'done' | 'wait' | 'bad' | 'skip';
export interface Step { key: 'checkout' | 'order' | 'capture' | 'webhook' | 'refund'; label: string; state: StepState }
export function lifecycle(r: Pick<SessionRow, 'status' | 'paypalOrderId' | 'captureId' | 'webhooks' | 'refundedCents' | 'totalCents'>): Step[] {
  const failed = ['rejected', 'failed', 'canceled'].includes(r.status);
  const s = (key: Step['key'], label: string, state: StepState): Step => ({ key, label, state });
  return [
    s('checkout', 'Checkout', 'done'),
    s('order', 'PayPal order', r.paypalOrderId ? 'done' : failed ? 'bad' : 'wait'),
    s('capture', 'Captured', r.captureId ? 'done' : failed ? 'bad' : r.paypalOrderId ? 'wait' : 'skip'),
    s('webhook', 'Webhook verified', r.webhooks > 0 ? 'done' : r.captureId ? 'wait' : 'skip'),
    s('refund', r.refundedCents >= r.totalCents && r.refundedCents > 0 ? 'Refunded' : r.refundedCents > 0 ? 'Part refunded' : 'Refund', r.refundedCents > 0 ? 'done' : 'skip'),
  ];
}

// ---------- rollups ----------
export type Dim = 'persona' | 'agentId' | 'platform' | 'status' | 'paymentMode';
export const DIMS: [Dim, string][] = [['persona', 'Persona'], ['agentId', 'Agent'], ['platform', 'Platform'], ['status', 'Status'], ['paymentMode', 'Payment mode']];
export interface RollupRow {
  key: string; sessions: number; orders: number; conversion: number; revenueCents: number; aovCents: number;
  refundedCents: number; refundRate: number; held: number; avgRounds: number; webhooks: number; trend: number[];
}
const PAID = new Set(['completed']);
export const isPaid = (r: Pick<SessionRow, 'status' | 'captureId'>) => PAID.has(r.status) || (!!r.captureId && r.status !== 'rejected');
/** Group sessions by a dimension; `trend` is revenue per time bucket across the whole data span (oldest → newest). */
export function rollup(rows: SessionRow[], dim: Dim, buckets = 12): RollupRow[] {
  const times = rows.map((r) => Date.parse(r.createdAt)).filter(Number.isFinite);
  const t0 = times.length ? Math.min(...times) : 0; const span = Math.max(1, (times.length ? Math.max(...times) : 0) - t0);
  const bucketOf = (iso: string) => Math.min(buckets - 1, Math.floor(((Date.parse(iso) - t0) / span) * buckets));
  const groups = new Map<string, SessionRow[]>();
  for (const r of rows) { const k = String(r[dim] ?? '(none)'); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  return [...groups].map(([key, rs]) => {
    const paid = rs.filter(isPaid);
    const revenueCents = paid.reduce((a, r) => a + r.totalCents, 0);
    const refundedCents = rs.reduce((a, r) => a + (r.refundedCents ?? 0), 0);
    const trend = Array(buckets).fill(0) as number[];
    for (const r of paid) { const b = bucketOf(r.createdAt); trend[b] = (trend[b] ?? 0) + r.totalCents; }
    return {
      key, sessions: rs.length, orders: paid.length, conversion: rs.length ? paid.length / rs.length : 0,
      revenueCents, aovCents: paid.length ? Math.round(revenueCents / paid.length) : 0, refundedCents,
      refundRate: revenueCents ? refundedCents / revenueCents : 0, held: rs.filter((r) => r.status === 'on_hold' || r.holdReason).length,
      avgRounds: rs.length ? rs.reduce((a, r) => a + r.negotiationRounds, 0) / rs.length : 0,
      webhooks: rs.reduce((a, r) => a + (r.webhooks ?? 0), 0), trend,
    };
  }).sort((a, b) => b.revenueCents - a.revenueCents || b.sessions - a.sessions || a.key.localeCompare(b.key));
}
/** Totals for the pinned bottom row of the live grid (computed over the rows currently passing filters). */
/** Pinned-row totals. totalCents is the gross of PAID sessions only (matches the Revenue KPI); unpaid baskets are excluded. */
export function totals(rows: SessionRow[]) {
  const paid = rows.filter(isPaid);
  return {
    sessions: rows.length, paid: paid.length,
    totalCents: paid.reduce((a, r) => a + r.totalCents, 0), refundedCents: rows.reduce((a, r) => a + (r.refundedCents ?? 0), 0),
    webhooks: rows.reduce((a, r) => a + (r.webhooks ?? 0), 0),
  };
}

// ---------- saved views ----------
export type Preset = 'all' | 'attention' | 'refunds' | 'reconciled' | 'high_value' | 'external';
export const PRESETS: [Preset, string][] = [['all', 'All traffic'], ['attention', 'Needs attention'], ['refunds', 'Refunds'], ['reconciled', 'Webhook-verified'], ['high_value', 'High value ($100+)'], ['external', 'External agents']];
export function presetMatches(p: Preset, r: SessionRow): boolean {
  switch (p) {
    case 'all': return true;
    case 'attention': return r.status === 'on_hold' || r.status === 'rejected' || r.status === 'requires_buyer_action' || r.status === 'failed' || !!r.holdReason || (!!r.captureId && r.webhooks === 0);
    case 'refunds': return (r.refundedCents ?? 0) > 0;
    case 'reconciled': return r.webhooks > 0;
    case 'high_value': return r.totalCents >= 10000;
    case 'external': return r.persona === 'external';
  }
}
export interface SavedView { name: string; preset: Preset; quickFilter: string; columnState: unknown[]; filterModel: Record<string, unknown> }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
export const VIEWS_KEY = 'agentaisle.liveViews.v1';
export function loadViews(kv: KV): SavedView[] {
  try {
    const v = JSON.parse(kv.getItem(VIEWS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string' && PRESETS.some(([p]) => p === x.preset)) : [];
  } catch { return []; }
}
export function saveView(kv: KV, view: SavedView): SavedView[] {
  const name = view.name.trim().slice(0, 40);
  if (!name) return loadViews(kv);
  const next = [...loadViews(kv).filter((v) => v.name !== name), { ...view, name }].slice(-12);
  kv.setItem(VIEWS_KEY, JSON.stringify(next));
  return next;
}
export function deleteView(kv: KV, name: string): SavedView[] {
  const next = loadViews(kv).filter((v) => v.name !== name);
  kv.setItem(VIEWS_KEY, JSON.stringify(next));
  return next;
}
