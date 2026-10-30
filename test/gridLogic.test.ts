// AG Grid Community console logic (web/src/grid/logic.ts) + the dashboard fields it relies on + a license guard.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { diffRows, isEmptyTx, lifecycle, rollup, totals, presetMatches, loadViews, saveView, deleteView, VIEWS_KEY, type KV } from '../web/src/grid/logic';
import { personaOf, buildDashboard } from '../src/domain/dashboard';
import type { SessionRow } from '../src/shared/contracts';
import { harness, BASE, WEBHOOK_SECRET, activeMandate, agent, type H } from './harness';
import { createCheckout, completeCheckout } from '../src/domain/checkout';

const row = (o: Partial<SessionRow>): SessionRow => ({
  id: 'cs_1', createdAt: '2026-10-28T10:00:00Z', agentId: 'sim-budget-brewer-1', platform: 'sim/chat-assistant', status: 'completed', paymentMode: 'mandate',
  items: '1× Blend', bags: 1, subtotalCents: 2000, discountCents: 0, totalCents: 2000, negotiationRounds: 0, holdReason: null, rejectReason: null, completedAt: null,
  paypalOrderId: 'O1', captureId: 'C1', refundedCents: 0, persona: 'budget-brewer', webhooks: 1, lastWebhook: 'PAYMENT.CAPTURE.COMPLETED', lastWebhookAt: '2026-10-28T10:00:05Z', ...o,
});
const mem = (): KV & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } }; };

describe('live transactions (diffRows)', () => {
  it('emits only adds, changed rows and removals', () => {
    const a = row({ id: 'a' }), b = row({ id: 'b' }), c = row({ id: 'c' });
    const tx = diffRows([a, b, c], [a, { ...b, webhooks: 2, lastWebhook: 'PAYMENT.CAPTURE.REFUNDED' }, row({ id: 'd' })], (r) => r.id);
    expect(tx.add.map((r) => r.id)).toEqual(['d']);
    expect(tx.update.map((r) => r.id)).toEqual(['b']);
    expect(tx.remove.map((r) => r.id)).toEqual(['c']);
  });
  it('identical snapshots (new objects, same values) produce an empty transaction', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    expect(isEmptyTx(diffRows(rows, rows.map((r) => ({ ...r })), (r) => r.id))).toBe(true);
  });
});

describe('payment lifecycle', () => {
  it('captured + webhook verified + fully refunded', () => {
    const s = lifecycle(row({ refundedCents: 2000 }));
    expect(s.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(s[4]!.label).toBe('Refunded');
  });
  it('captured but webhook not yet landed shows waiting', () => {
    expect(lifecycle(row({ webhooks: 0 })).find((x) => x.key === 'webhook')!.state).toBe('wait');
  });
  it('rejected before PayPal shows failure, partial refunds are labelled', () => {
    const r = lifecycle(row({ status: 'rejected', paypalOrderId: null, captureId: null, webhooks: 0 }));
    expect(r[1]!.state).toBe('bad');
    expect(lifecycle(row({ refundedCents: 500 }))[4]!.label).toBe('Part refunded');
  });
});

describe('rollups (Community stand-in for row grouping)', () => {
  const rows = [
    row({ id: '1', persona: 'budget-brewer', totalCents: 2000, createdAt: '2026-10-28T10:00:00Z' }),
    row({ id: '2', persona: 'budget-brewer', totalCents: 3000, refundedCents: 3000, createdAt: '2026-10-28T11:00:00Z', negotiationRounds: 2 }),
    row({ id: '3', persona: 'gift-shopper', status: 'on_hold', captureId: null, holdReason: 'over cap', totalCents: 15000, webhooks: 0, createdAt: '2026-10-28T12:00:00Z' }),
  ];
  it('aggregates by persona with conversion, refund rate, holds and a revenue trend', () => {
    const [bb, gs] = rollup(rows, 'persona', 4) as [ReturnType<typeof rollup>[number], ReturnType<typeof rollup>[number]];
    expect(bb).toMatchObject({ key: 'budget-brewer', sessions: 2, orders: 2, revenueCents: 5000, refundedCents: 3000, aovCents: 2500, avgRounds: 1, webhooks: 2 });
    expect(bb.refundRate).toBeCloseTo(0.6);
    expect(bb.trend.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(bb.trend).toHaveLength(4);
    expect(gs).toMatchObject({ key: 'gift-shopper', sessions: 1, orders: 0, conversion: 0, held: 1, revenueCents: 0 });
  });
  it('groups by status and payment mode too', () => {
    expect(rollup(rows, 'status').map((r) => r.key).sort()).toEqual(['completed', 'on_hold']);
    expect(rollup([], 'agentId')).toEqual([]);
  });
  it('totals for the pinned row: gross of paid sessions only (matches Revenue KPI)', () => {
    expect(totals(rows)).toEqual({ sessions: 3, paid: 2, totalCents: 5000, refundedCents: 3000, webhooks: 2 });
  });
});

describe('views', () => {
  it('presets filter the right rows', () => {
    expect(presetMatches('attention', row({ status: 'on_hold' }))).toBe(true);
    expect(presetMatches('attention', row({ webhooks: 0 }))).toBe(true); // captured, webhook missing
    expect(presetMatches('attention', row({}))).toBe(false);
    expect(presetMatches('refunds', row({ refundedCents: 1 }))).toBe(true);
    expect(presetMatches('high_value', row({ totalCents: 9999 }))).toBe(false);
    expect(presetMatches('external', row({ persona: 'external' }))).toBe(true);
  });
  it('saved views round-trip, replace by name, delete, and survive corrupt storage', () => {
    const kv = mem();
    saveView(kv, { name: ' Refund desk ', preset: 'refunds', quickFilter: 'cap', columnState: [{ colId: 'status', hide: true }], filterModel: {} });
    saveView(kv, { name: 'Refund desk', preset: 'attention', quickFilter: '', columnState: [], filterModel: {} });
    expect(loadViews(kv)).toEqual([{ name: 'Refund desk', preset: 'attention', quickFilter: '', columnState: [], filterModel: {} }]);
    expect(deleteView(kv, 'Refund desk')).toEqual([]);
    kv.setItem(VIEWS_KEY, '{nope'); expect(loadViews(kv)).toEqual([]);
    kv.setItem(VIEWS_KEY, JSON.stringify([{ name: 'x', preset: 'evil' }])); expect(loadViews(kv)).toEqual([]);
  });
});

describe('dashboard rows carry persona + verified webhook stats', () => {
  let h: H;
  beforeEach(async () => { h = await harness(); });
  it('personaOf', () => {
    expect(personaOf('sim-office-manager-12')).toBe('office-manager');
    expect(personaOf('claude-desktop')).toBe('external');
  });
  it('a signed webhook shows up on its session row', async () => {
    const { token } = await activeMandate(h);
    const A = agent('agent-grid1');
    const s = await createCheckout(h.d, A, { items: [{ sku: 'PP-BL-HC-12', qty: 1 }] });
    await completeCheckout(h.d, A, s.id, { payment_mode: 'mandate', mandate_token: token, idempotency_key: 'grid-idem-0001' });
    const sess = (await h.d.store.getSession(s.id))!;
    const before = (await buildDashboard(h.d, 24)).sessions.find((r) => r.id === s.id)!;
    expect(before).toMatchObject({ persona: 'external', webhooks: 0, lastWebhook: null });
    const res = await h.fetch(new Request(`${BASE}/api/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-signature': WEBHOOK_SECRET },
      body: JSON.stringify({ id: 'WH-GRID-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: sess.captureId, supplementary_data: { related_ids: { order_id: sess.paypalOrderId } } } }) }));
    expect(res.status).toBe(200);
    const after = (await buildDashboard(h.d, 24)).sessions.find((r) => r.id === s.id)!;
    expect(after.webhooks).toBe(1);
    expect(after.lastWebhook).toBe('PAYMENT.CAPTURE.COMPLETED');
    expect(after.lastWebhookAt).toBeTruthy();
  });
});

describe('license guard: public console uses only MIT AG Grid / AG Charts Community', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  it('no Enterprise packages or Enterprise-only grid options', () => {
    const pkg = JSON.parse(readFileSync('web/package.json', 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /enterprise/.test(d))).toEqual([]);
    const src = walk('web/src').filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const bad of ['ag-grid-enterprise', 'ag-charts-enterprise', 'rowGroup:', 'pivotMode', 'masterDetail', 'enableCharts', 'agSparklineCellRenderer', 'sideBar', 'statusBar'])
      expect(src.includes(bad), bad).toBe(false);
  });
  it('AG Studio (commercial) is only imported behind the VITE_ENABLE_AG_STUDIO build flag', () => {
    const app = readFileSync('web/src/App.tsx', 'utf8');
    expect(app).toMatch(/VITE_ENABLE_AG_STUDIO === 'true'/);
    expect(app).not.toMatch(/^import .*studio\/StudioView/m);
    const importers = walk('web/src').filter((f) => /ag-studio'/.test(readFileSync(f, 'utf8')));
    expect(importers.every((f) => f.includes('/studio/'))).toBe(true);
  });
});
