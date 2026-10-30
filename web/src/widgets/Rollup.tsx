// "Pivot-lite" on AG Grid Community: sessions rolled up by persona / agent / platform / status / payment mode in a
// tested pure function (Enterprise row grouping and pivoting are not used), with hand-rolled sparklines and a linked
// AG Charts Community chart that follows the grid's current filter and sort order.
import { useCallback, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AgCharts } from 'ag-charts-react';
import type { ColDef, GridApi } from 'ag-grid-community';
import type { SessionRow } from '../../../src/shared/contracts';
import { DIMS, rollup, type Dim, type RollupRow } from '../grid/logic';
import { useGridTheme, useChartTheme } from './Grid';
import { Sparkline, RatioBar } from './renderers';
import { money } from '../api';

export function Rollup({ rows }: { rows: SessionRow[] }) {
  const theme = useGridTheme();
  const chartTheme = useChartTheme();
  const [dim, setDim] = useState<Dim>('persona');
  const data = useMemo(() => rollup(rows, dim), [rows, dim]);
  const g = useRef<GridApi<RollupRow> | null>(null);
  const [shown, setShown] = useState<RollupRow[]>([]);
  const sync = useCallback(() => { const out: RollupRow[] = []; g.current?.forEachNodeAfterFilterAndSort((n) => n.data && out.push(n.data)); setShown(out.slice(0, 12)); }, []);
  const cols = useMemo<ColDef<RollupRow>[]>(() => [
    { field: 'key', headerName: DIMS.find(([d]) => d === dim)![1], pinned: 'left', minWidth: 170, flex: 1 },
    { field: 'sessions', width: 100 }, { field: 'orders', width: 95 },
    { field: 'conversion', width: 140, cellRenderer: (p: { value: number }) => <RatioBar value={p.value} /> },
    { field: 'revenueCents', headerName: 'Revenue', width: 120, valueFormatter: (p) => money(p.value), sort: 'desc' },
    { field: 'trend', headerName: 'Revenue trend', width: 140, sortable: false, filter: false, cellDataType: false, valueFormatter: (p) => (p.value as number[]).map((c) => (c / 100).toFixed(2)).join(' '), cellRenderer: (p: { value: number[] }) => <Sparkline values={p.value} /> },
    { field: 'aovCents', headerName: 'AOV', width: 100, valueFormatter: (p) => money(p.value) },
    { field: 'refundRate', headerName: 'Refund rate', width: 140, cellRenderer: (p: { value: number }) => <RatioBar value={p.value} warnAbove={0.1} /> },
    { field: 'held', width: 85 }, { field: 'avgRounds', headerName: 'Avg rounds', width: 115, valueFormatter: (p) => p.value.toFixed(1) },
    { field: 'webhooks', headerName: 'Webhooks', width: 110 },
  ], [dim]);
  return (<div className="rollup">
    <div className="toolbar">
      <span className="muted">Roll up by</span>
      <div className="seg" role="tablist">{DIMS.map(([d, l]) => <button key={d} role="tab" aria-selected={dim === d} className={dim === d ? 'on' : ''} onClick={() => setDim(d)}>{l}</button>)}</div>
    </div>
    <div className="rollup-body">
      <div style={{ height: 330 }}>
        <AgGridReact<RollupRow> theme={theme} rowData={data} columnDefs={cols} getRowId={(p) => p.data.key}
          defaultColDef={{ sortable: true, filter: true, resizable: true }} animateRows
          onGridReady={(e) => { g.current = e.api; sync(); }} onModelUpdated={sync} />
      </div>
      <div style={{ height: 330 }}>
        <AgCharts options={{
          theme: chartTheme,
          data: shown.map((r) => ({ key: r.key, revenue: r.revenueCents / 100, refunded: r.refundedCents / 100 })),
          title: { text: 'Revenue vs refunds (follows grid filter/sort)', fontSize: 13 },
          series: [{ type: 'bar', xKey: 'key', yKey: 'revenue', yName: 'Revenue $', fill: '#7a4a24' }, { type: 'bar', xKey: 'key', yKey: 'refunded', yName: 'Refunded $', fill: '#d4a373' }],
          legend: { position: 'bottom' }, background: { visible: false },
        }} />
      </div>
    </div>
  </div>);
}
