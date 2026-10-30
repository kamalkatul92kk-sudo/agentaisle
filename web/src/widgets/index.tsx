// Merchant widgets on AG Grid Community + AG Charts Community. Every widget consumes exactly one table from
// ../studio/dataSources.ts, so it can be rebuilt as an AG Studio widget (or embedded as a custom component) unchanged.
import { AgCharts } from 'ag-charts-react';
import type { ColDef } from 'ag-grid-community';
import type { SessionRow, FunnelRow, DemandGapRow, ApprovalRow, MandateRow, EventRow, AgentRow } from '../../../src/shared/contracts';
import { Grid, useChartTheme } from './Grid';
import { money } from '../api';

const pill = (v: string | null) => (v ? <span className={`pill ${v}`}>{v}</span> : null);

export function LiveTraffic({ rows, onOpen }: { rows: SessionRow[]; onOpen: (id: string) => void }) {
  const cols: ColDef<SessionRow>[] = [
    { field: 'createdAt', headerName: 'Time', sort: 'desc', valueFormatter: (p) => new Date(p.value).toLocaleTimeString() },
    { field: 'agentId', headerName: 'Agent' }, { field: 'platform' },
    { field: 'status', cellRenderer: (p: { value: string }) => pill(p.value) },
    { field: 'items', flex: 2 }, { field: 'negotiationRounds', headerName: 'Rounds', maxWidth: 100 },
    { field: 'totalCents', headerName: 'Total', valueFormatter: (p) => money(p.value) },
    { field: 'paymentMode', headerName: 'Pay' }, { headerName: 'Why', valueGetter: (p) => p.data?.holdReason ?? p.data?.rejectReason ?? '' },
    { field: 'paypalOrderId', headerName: 'PayPal order', cellClass: 'mono' }, { field: 'captureId', headerName: 'Capture', cellClass: 'mono' },
    { field: 'refundedCents', headerName: 'Refunded', maxWidth: 120, valueFormatter: (p) => (p.value ? money(p.value) : '') },
  ];
  return <Grid rows={rows} cols={cols} rowId={(r) => r.id} height={360} onRowClicked={(r) => onOpen(r.id)} />;
}

export function Funnel({ rows }: { rows: FunnelRow[] }) {
  const theme = useChartTheme();
  return <div style={{ height: 260 }}><AgCharts options={{ theme, data: rows, series: [{ type: 'bar', direction: 'horizontal', xKey: 'stage', yKey: 'sessions', fill: '#7a4a24' }], axes: { y: { type: 'category', position: 'left', reverse: true }, x: { type: 'number', position: 'bottom' } }, background: { visible: false } } as any} /></div>;
}

export function DemandGaps({ rows, onDraft }: { rows: DemandGapRow[]; onDraft: (q: string) => void }) {
  const cols: ColDef<DemandGapRow>[] = [
    { field: 'query', flex: 2 }, { field: 'searches', sort: 'desc' }, { field: 'agents' },
    { headerName: '', cellRenderer: (p: { data: DemandGapRow }) => <button className="ghost" onClick={() => onDraft(p.data.query)}>Draft product</button> },
  ];
  return <Grid rows={rows} cols={cols} rowId={(r) => r.query} height={240} />;
}

export function ApprovalQueue({ rows, onDecide }: { rows: ApprovalRow[]; onDecide: (id: string, d: 'approve' | 'reject') => void }) {
  const cols: ColDef<ApprovalRow>[] = [
    { field: 'createdAt', headerName: 'Created', sort: 'desc', valueFormatter: (p) => new Date(p.value).toLocaleString() },
    { field: 'kind' }, { field: 'status', cellRenderer: (p: { value: string }) => pill(p.value) },
    { field: 'summary', flex: 3 }, { field: 'reason', flex: 2 }, { field: 'requestedBy' },
    { field: 'amountCents', headerName: 'Amount', valueFormatter: (p) => money(p.value) },
    { headerName: 'Decide', minWidth: 170, cellRenderer: (p: { data: ApprovalRow }) => p.data.status === 'pending' ? (
      <span style={{ display: 'flex', gap: 6 }}><button className="primary" onClick={() => onDecide(p.data.id, 'approve')}>Approve</button><button className="ghost" onClick={() => onDecide(p.data.id, 'reject')}>Reject</button></span>) : null },
  ];
  return <Grid rows={rows} cols={cols} rowId={(r) => r.id} height={420} />;
}

export function MandateGauges({ rows, onRevoke }: { rows: MandateRow[]; onRevoke: (id: string) => void }) {
  if (!rows.length) return <p className="muted">No buyer mandates yet. Run the simulator or POST /api/mandates.</p>;
  return (<div style={{ display: 'grid', gap: 10 }}>{rows.map((m) => {
    const pct = (v: number) => `${Math.min(100, (v / m.monthlyCapCents) * 100)}%`;
    return (<div key={m.id}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><b>{m.buyerName}</b> {pill(m.status)}<span>{money(m.spentThisMonthCents)} / {money(m.monthlyCapCents)} · per order ≤ {money(m.perOrderCapCents)}</span></div>
      <div className="gauge"><i style={{ width: pct(m.spentThisMonthCents), background: '#7a4a24' }} /><i style={{ width: pct(m.reservedCents), background: '#d4a373' }} /></div>
      {m.status === 'active' && <button className="ghost" style={{ marginTop: 4, fontSize: 11 }} onClick={() => onRevoke(m.id)}>Revoke</button>}
    </div>);
  })}</div>);
}

export function Agents({ rows, onTrust }: { rows: AgentRow[]; onTrust: (id: string, t: 'new' | 'known' | 'blocked') => void }) {
  const cols: ColDef<AgentRow>[] = [
    { field: 'id', headerName: 'Agent' }, { field: 'platform' }, { field: 'trust', cellRenderer: (p: { value: string }) => pill(p.value) },
    { field: 'sessions' }, { field: 'orders' }, { field: 'revenueCents', headerName: 'Revenue', sort: 'desc', valueFormatter: (p) => money(p.value) },
    { headerName: 'Trust', minWidth: 200, cellRenderer: (p: { data: AgentRow }) => <span style={{ display: 'flex', gap: 4 }}>{(['known', 'new', 'blocked'] as const).filter((t) => t !== p.data.trust).map((t) => <button key={t} className="ghost" onClick={() => onTrust(p.data.id, t)}>{t}</button>)}</span> },
  ];
  return <Grid rows={rows} cols={cols} rowId={(r) => r.id} height={360} />;
}

export function SessionReplay({ events, header }: { events: EventRow[]; header: string }) {
  return (<div><h3>{header}</h3><ul className="timeline">{events.map((e) => (
    <li key={e.id}><span className="muted">{new Date(e.ts).toLocaleTimeString()}</span> <code>{e.type}</code> {e.summary}</li>))}</ul></div>);
}

/** Widget contract: which Studio table each widget reads. Used by docs/ag-studio-integration.md and the Studio view. */
export const WIDGETS = [
  { id: 'live-traffic', title: 'Live agent traffic', table: 'sessions' },
  { id: 'funnel', title: 'Agent funnel', table: 'funnel' },
  { id: 'demand-gaps', title: 'Demand gaps (zero-result searches)', table: 'demand_gaps' },
  { id: 'approval-queue', title: 'Approval queue', table: 'approvals' },
  { id: 'mandate-gauge', title: 'Buyer mandate spend', table: 'mandates' },
  { id: 'agents', title: 'Agents & trust', table: 'agents' },
  { id: 'session-replay', title: 'Session replay', table: 'events' },
] as const;
