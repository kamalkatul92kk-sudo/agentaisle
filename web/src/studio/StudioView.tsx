// AG Studio drop-in. Runs watermarked with no key (local evaluation); set VITE_AG_STUDIO_LICENSE_KEY (trial key) to remove it.
// Lazy-loaded so the Community console works even if ag-studio is removed from package.json.
import { useEffect, useRef, useState } from 'react';
import type { DashboardSnapshot, EventRow } from '../../../src/shared/contracts';
import { toStudioData } from './dataSources';

const LAYOUT_KEY = 'agentaisle.studioReport';
export function StudioView({ snapshot, events }: { snapshot: DashboardSnapshot | null; events: EventRow[] }) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'view'>('edit');

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const mod = await import('ag-studio');
        const key = import.meta.env.VITE_AG_STUDIO_LICENSE_KEY as string | undefined;
        if (key) mod.AgStudioLicenseManager.setLicenseKey(key);
        if (dead || !host.current || !snapshot) return;
        const saved = localStorage.getItem(LAYOUT_KEY);
        api.current = mod.createStudio(host.current, { data: toStudioData(snapshot, events), mode, ...(saved ? { initialState: JSON.parse(saved) } : {}) } as any);
      } catch (e) { setErr(String((e as Error).message ?? e)); }
    })();
    return () => { dead = true; api.current?.destroy?.(); api.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!snapshot]);

  useEffect(() => { if (api.current && snapshot) api.current.updateProperties({ data: toStudioData(snapshot, events) }); }, [snapshot, events]);
  useEffect(() => { api.current?.updateProperties({ mode }); }, [mode]);

  return (<div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
      <b>AG Studio</b><span className="muted">{import.meta.env.VITE_AG_STUDIO_LICENSE_KEY ? 'licensed' : 'watermarked evaluation (no key)'} · tables: sessions, agents, events, products, funnel, demand_gaps, approvals, mandates</span>
      <span style={{ flex: 1 }} />
      <button className="ghost" onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}>{mode === 'edit' ? 'View mode' : 'Edit mode'}</button>
      <button className="ghost" onClick={() => { if (api.current) { localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.current.getState())); alert('Report layout saved in this browser. Export it to web/src/studio/defaultReport.json to ship it.'); } }}>Save layout</button>
    </div>
    {err && <p className="err">AG Studio failed to load: {err}. The AG Grid Community tabs keep working.</p>}
    <div ref={host} className="studio-host" />
  </div>);
}
