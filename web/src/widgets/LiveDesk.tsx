// Live agent traffic on AG Grid Community: delta transactions as webhooks land (applyTransactionAsync + cell flash),
// custom renderers, quick filter, preset + saved views (column state, filter model), pinned totals row, CSV export,
// and a session inspector panel (events + verified webhooks). Every feature here is in AG Grid Community (MIT).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, GridApi, IRowNode, RowClassRules } from 'ag-grid-community';
import type { EventRow, SessionRow } from '../../../src/shared/contracts';
import { diffRows, isEmptyTx, lifecycle, loadViews, presetMatches, PRESETS, saveView, deleteView, totals, type Preset, type SavedView } from '../grid/logic';
import { useGridTheme } from './Grid';
import { StatusCell, PayPalIdCell, LifecycleCell, WebhookCell, MoneyCell } from './renderers';
import { api, money } from '../api';

const fmtTime = (iso: string) => (iso ? new Date(iso).toLocaleTimeString() : '');
const isFresh = (iso: string | null, ms = 20000) => !!iso && Date.now() - Date.parse(iso) < ms;

export function LiveDesk({ rows, onReplay }: { rows: SessionRow[]; onReplay: (id: string) => void }) {
  const theme = useGridTheme();
  const gridApi = useRef<GridApi<SessionRow> | null>(null);
  const prev = useRef<SessionRow[]>([]);
  const [initialRows] = useState(rows);
  const [quick, setQuick] = useState('');
  const [preset, setPreset] = useState<Preset>('all');
  const presetRef = useRef(preset); presetRef.current = preset;
  const [views, setViews] = useState<SavedView[]>(() => loadViews(localStorage));
  const [ticker, setTicker] = useState<string>('Waiting for live updates…');
  const [selected, setSelected] = useState<string | null>(null);

  const cols = useMemo<ColDef<SessionRow>[]>(() => [
    { field: 'createdAt', headerName: 'Time', sort: 'desc', pinned: 'left', width: 110, valueFormatter: (p) => (p.node?.rowPinned ? 'Totals' : fmtTime(p.value)) },
    { field: 'agentId', headerName: 'Agent', pinned: 'left', width: 190 },
    { field: 'persona', width: 140 },
    { field: 'status', cellRenderer: StatusCell, width: 150, enableCellChangeFlash: true },
    { headerName: 'Lifecycle', colId: 'lifecycle', width: 120, sortable: false, filter: false, cellRenderer: LifecycleCell,
      valueGetter: (p) => (p.data && !p.node?.rowPinned ? lifecycle(p.data).map((s) => `${s.key}:${s.state}`).join(' ') : '') },
    { field: 'items', flex: 2, minWidth: 180 },
    { field: 'totalCents', headerName: 'Total', headerTooltip: 'Basket total. The pinned Totals row sums paid sessions only, matching the Revenue KPI.', width: 110, cellRenderer: MoneyCell, filter: 'agNumberColumnFilter', enableCellChangeFlash: true },
    { field: 'refundedCents', headerName: 'Refunded', width: 110, valueFormatter: (p) => (p.value ? money(p.value) : ''), filter: 'agNumberColumnFilter', enableCellChangeFlash: true },
    { field: 'webhooks', headerName: 'PayPal webhooks', width: 190, cellRenderer: WebhookCell, filter: 'agNumberColumnFilter', enableCellChangeFlash: true },
    { field: 'paymentMode', headerName: 'Pay', width: 120 },
    { field: 'negotiationRounds', headerName: 'Rounds', width: 90, filter: 'agNumberColumnFilter' },
    { headerName: 'Why', colId: 'why', valueGetter: (p) => p.data?.holdReason ?? p.data?.rejectReason ?? '', minWidth: 140 },
    { field: 'paypalOrderId', headerName: 'PayPal order', cellRenderer: PayPalIdCell, width: 200, enableCellChangeFlash: true },
    { field: 'captureId', headerName: 'Capture', cellRenderer: PayPalIdCell, width: 200, enableCellChangeFlash: true },
    { field: 'platform', width: 170, hide: true },
  ], []);

  const rowClassRules = useMemo<RowClassRules<SessionRow>>(() => ({
    'row-hook-fresh': (p) => !p.node.rowPinned && isFresh(p.data?.lastWebhookAt ?? null),
    'row-attention': (p) => !p.node.rowPinned && !!p.data && presetMatches('attention', p.data),
    'row-selected-insp': (p) => !!p.data && p.data.id === selected,
  }), [selected]);

  // Live updates: diff the 3s snapshot against what the grid holds and apply only the delta.
  useEffect(() => {
    const g = gridApi.current; if (!g) return;
    const tx = diffRows(prev.current, rows, (r) => r.id);
    prev.current = rows;
    if (isEmptyTx(tx)) return;
    g.applyTransactionAsync(tx, () => {
      const hooks = tx.update.filter((r) => isFresh(r.lastWebhookAt));
      const bits = [tx.add.length && `+${tx.add.length} new`, tx.update.length && `${tx.update.length} updated`, tx.remove.length && `${tx.remove.length} removed`].filter(Boolean).join(' · ');
      setTicker(`${new Date().toLocaleTimeString()} · ${bits}${hooks.length ? ` · webhook ${hooks[0].lastWebhook} on ${hooks[0].id}` : ''}`);
    });
  }, [rows]);

  const onModelUpdated = useCallback(() => {
    const g = gridApi.current; if (!g) return;
    const shown: SessionRow[] = []; g.forEachNodeAfterFilter((n: IRowNode<SessionRow>) => { if (n.data) shown.push(n.data); });
    const t = totals(shown);
    g.setGridOption('pinnedBottomRowData', [{ id: '__totals', createdAt: '', agentId: `${t.sessions} sessions`, persona: '', status: '', items: `${t.paid} paid`, totalCents: t.totalCents, refundedCents: t.refundedCents, webhooks: t.webhooks } as unknown as SessionRow]);
  }, []);

  useEffect(() => { gridApi.current?.onFilterChanged(); }, [preset]);
  useEffect(() => { gridApi.current?.redrawRows(); }, [selected]);

  const applyView = (v: SavedView) => {
    const g = gridApi.current; if (!g) return;
    setPreset(v.preset); setQuick(v.quickFilter);
    if (v.columnState.length) g.applyColumnState({ state: v.columnState as any, applyOrder: true });
    g.setFilterModel(v.filterModel ?? null);
  };
  const onPick = (val: string) => {
    if (val.startsWith('preset:')) { setPreset(val.slice(7) as Preset); return; }
    const v = views.find((x) => `view:${x.name}` === val); if (v) applyView(v);
  };
  const save = () => {
    const g = gridApi.current; if (!g) return;
    const name = prompt('Name this view (saved in this browser):'); if (!name) return;
    setViews(saveView(localStorage, { name, preset, quickFilter: quick, columnState: g.getColumnState(), filterModel: g.getFilterModel() }));
  };
  const resetLayout = () => { const g = gridApi.current; if (!g) return; g.resetColumnState(); g.setFilterModel(null); setQuick(''); setPreset('all'); };

  return (<div className="desk">
    <div className="toolbar">
      <input className="search" placeholder="Quick filter: agent, item, PayPal id, status…" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Quick filter" />
      <select value={`preset:${preset}`} onChange={(e) => onPick(e.target.value)} aria-label="Views">
        <optgroup label="Views">{PRESETS.map(([k, l]) => <option key={k} value={`preset:${k}`}>{l}</option>)}</optgroup>
        {views.length > 0 && <optgroup label="My saved views">{views.map((v) => <option key={v.name} value={`view:${v.name}`}>{v.name}</option>)}</optgroup>}
      </select>
      <button className="ghost" onClick={save}>Save view</button>
      {views.length > 0 && <button className="ghost" title="Delete a saved view" onClick={() => { const n = prompt(`Delete which view? (${views.map((v) => v.name).join(', ')})`); if (n) setViews(deleteView(localStorage, n)); }}>Delete view</button>}
      <button className="ghost" onClick={resetLayout}>Reset layout</button>
      <button className="ghost" onClick={() => gridApi.current?.exportDataAsCsv({ fileName: 'agentaisle-sessions.csv', skipPinnedBottom: true })}>Export CSV</button>
      <span className="ticker" aria-live="polite">● {ticker}</span>
    </div>
    <div style={{ height: 420 }}>
      <AgGridReact<SessionRow> theme={theme} rowData={initialRows} columnDefs={cols}
        defaultColDef={{ sortable: true, filter: true, resizable: true, minWidth: 80 }}
        getRowId={(p: GetRowIdParams<SessionRow>) => p.data.id} animateRows asyncTransactionWaitMillis={150}
        quickFilterText={quick} cacheQuickFilter
        isExternalFilterPresent={() => presetRef.current !== 'all'}
        doesExternalFilterPass={(n) => !!n.data && presetMatches(presetRef.current, n.data)}
        rowClassRules={rowClassRules} onModelUpdated={onModelUpdated}
        onGridReady={(e) => { gridApi.current = e.api; prev.current = initialRows; onModelUpdated(); }}
        onRowClicked={(e) => e.data && !e.node.rowPinned && setSelected(e.data.id)}
        overlayNoRowsTemplate="No agent sessions yet. Press “Simulate 10 agents”." />
    </div>
    {selected && <Inspector row={rows.find((r) => r.id === selected) ?? null} onClose={() => setSelected(null)} onReplay={onReplay} />}
  </div>);
}

/** Per-session detail panel: lifecycle, PayPal ids, and the session's event + webhook trail (refreshes as webhooks land). */
function Inspector({ row, onClose, onReplay }: { row: SessionRow | null; onClose: () => void; onReplay: (id: string) => void }) {
  const theme = useGridTheme();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const key = row ? `${row.id}|${row.status}|${row.webhooks}|${row.refundedCents}|${row.captureId}` : '';
  useEffect(() => {
    if (!row) return; let dead = false;
    api.replay(row.id).then((r) => { if (!dead) { setEvents(r.events); setErr(null); } }).catch((e) => !dead && setErr(String(e.message)));
    return () => { dead = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!row) return null;
  const cols: ColDef<EventRow>[] = [
    { field: 'ts', headerName: 'Time', width: 110, valueFormatter: (p) => fmtTime(p.value), sort: 'asc' },
    { field: 'type', width: 330, cellRenderer: (p: { value: string }) => p.value === 'ai.model' ? <span className="aibadge model" title="Answered by the AI model (validated by code)">model</span>
      : p.value === 'ai.fallback' ? <span className="aibadge fallback" title="Model unavailable, invalid or rejected by a guardrail; deterministic rules answered">fallback</span>
      : <code className={p.value.startsWith('webhook.') ? 'hooktype' : ''}>{p.value.startsWith('webhook.') ? '🔏 ' : ''}{p.value}</code> },
    { field: 'summary', flex: 1, wrapText: true, autoHeight: true },
  ];
  const hooks = events.filter((e) => e.type.startsWith('webhook.')).length;
  return (<div className="inspector">
    <div className="insp-head">
      <b>Session {row.id}</b><span className="muted">{row.agentId} · {row.persona} · {row.platform}</span>
      <span style={{ flex: 1 }} />
      <button className="ghost" onClick={() => onReplay(row.id)}>Open full replay</button>
      <button className="ghost" onClick={onClose} aria-label="Close inspector">✕</button>
    </div>
    <div className="stepper">{lifecycle(row).map((s) => <div key={s.key} className={`stp ${s.state}`}><i />{s.label}</div>)}</div>
    <div className="insp-facts">
      <span>Total <b>{money(row.totalCents)}</b></span>{row.refundedCents > 0 && <span>Refunded <b>{money(row.refundedCents)}</b></span>}
      <span>Order <code>{row.paypalOrderId ?? '-'}</code></span><span>Capture <code>{row.captureId ?? '-'}</code></span>
      <span>Verified webhooks <b>{hooks}</b></span>{row.holdReason && <span>Hold: {row.holdReason}</span>}
    </div>
    {err ? <p className="err">{err}</p> : <div style={{ height: 240 }}><AgGridReact<EventRow> theme={theme} rowData={events} columnDefs={cols} getRowId={(p) => String(p.data.id)}
      rowClassRules={{ 'row-hook': (p) => !!p.data?.type.startsWith('webhook.') }} defaultColDef={{ resizable: true, sortable: true }} /></div>}
  </div>);
}
