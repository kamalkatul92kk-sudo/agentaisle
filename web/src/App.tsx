import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardSnapshot, EventRow } from '../../src/shared/contracts';
import { api, getToken, setToken, money, type OpsReply, type Replay } from './api';
import { Funnel, DemandGaps, ApprovalQueue, MandateGauges, Agents, SessionReplay } from './widgets';
import { LiveDesk } from './widgets/LiveDesk';
import { Rollup } from './widgets/Rollup';
import { GridThemeContext, type ThemeName } from './widgets/Grid';

// AG Studio is a commercial product (free 45-day trial). The public demo build ships AG Grid/AG Charts Community only;
// the Studio tab (and the ag-studio bundle) is compiled in only when VITE_ENABLE_AG_STUDIO=true at build time.
const STUDIO_ENABLED = import.meta.env.VITE_ENABLE_AG_STUDIO === 'true';
const StudioView = STUDIO_ENABLED ? lazy(() => import('./studio/StudioView').then((m) => ({ default: m.StudioView }))) : null;

type Tab = 'live' | 'approvals' | 'agents' | 'replay' | 'ops' | 'studio';
const TABS: [Tab, string][] = [['live', 'Live'], ['approvals', 'Approvals'], ['agents', 'Agents & rollups'], ['replay', 'Replay'], ['ops', 'Ops agent'], ...(STUDIO_ENABLED ? [['studio', 'AG Studio'] as [Tab, string]] : [])];

export function App() {
  const [tab, setTab] = useState<Tab>('live');
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const lastEvent = useRef(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [chat, setChat] = useState<{ me?: string; bot?: OpsReply }[]>([]);
  const [msg, setMsg] = useState('');
  const [themeName, setThemeName] = useState<ThemeName>(() => (localStorage.getItem('agentaisle.theme') === 'dark' ? 'dark' : 'light'));
  useEffect(() => { localStorage.setItem('agentaisle.theme', themeName); document.documentElement.dataset.theme = themeName; }, [themeName]);

  const refresh = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([api.dashboard(), api.events(lastEvent.current, 500)]);
      setSnap(s); setErr(null);
      if (e.events.length) { lastEvent.current = Math.max(...e.events.map((x) => x.id)); setEvents((old) => [...old, ...e.events].slice(-3000)); }
    } catch (e: any) { setErr(e.status === 401 ? 'This action needs the merchant token.' : String(e.message)); }
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [refresh]);

  const act = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); await refresh(); } catch (e: any) { alert(e.message); } finally { setBusy(false); } };
  const openReplay = async (id: string) => { setReplay(await api.replay(id)); setTab('replay'); };
  const sendOps = async (text: string) => { setChat((c) => [...c, { me: text }]); setMsg(''); const r = await api.ops(text); setChat((c) => [...c, { bot: r }]); await refresh(); };
  const k = snap?.kpis;

  return (<GridThemeContext.Provider value={themeName}>
    <header>
      <h1>☕ AgentAisle · Pecan Plume Coffee Co.</h1>
      <span className="mode">PayPal: {snap?.paypalMode ?? '…'} · LLM: {snap?.llm ?? '…'}</span>
      <span className="spacer" />
      <button className="ghost" style={{ color: '#f6efe6', borderColor: '#8c6b4f' }} onClick={() => setThemeName(themeName === 'dark' ? 'light' : 'dark')} aria-label="Toggle dark theme">{themeName === 'dark' ? '☀ Light' : '☾ Dark'}</button>
      <input type="password" placeholder="merchant token" defaultValue={getToken()} onBlur={(e) => { setToken(e.target.value); refresh(); }} style={{ width: 180 }} />
      <button className="primary" disabled={busy} onClick={() => act(() => api.simulate(10))}>Simulate 10 agents</button>
      <button className="ghost" style={{ color: '#f6efe6', borderColor: '#8c6b4f' }} disabled={busy} onClick={() => confirm('Reset demo data?') && act(async () => { await api.reset(); lastEvent.current = 0; setEvents([]); })}>Reset</button>
    </header>
    <div className="demo-banner" role="note">
      Hackathon demo · <b>Pecan Plume Coffee Co.</b> is a fictional merchant in Texas · payments run on the <b>PayPal {snap?.paypalMode === 'sandbox' ? 'sandbox' : 'mock (offline)'}</b>, no real money moves · buyers are simulated AI agents.
    </div>
    <nav>{TABS.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'approvals' && k?.pendingApprovals ? ` (${k.pendingApprovals})` : ''}</button>)}</nav>
    <main>
      {err && <p className="err">{err}</p>}
      {k && <div className="kpis">
        {[['Agent sessions', k.agentSessions], ['Unique agents', k.uniqueAgents], ['Orders', k.completedOrders], ['Revenue', money(k.revenueCents)], ['AOV', money(k.aovCents)], ['Conversion', `${(k.conversionRate * 100).toFixed(0)}%`], ['Avg negotiated', `${(k.avgNegotiatedDiscountBps / 100).toFixed(1)}%`], ['Held / rejected', `${k.heldOrders} / ${k.rejectedOrders}`], ['Zero-result searches', k.zeroResultSearches]].map(([l, v]) => <div key={l as string} className="kpi"><b>{v}</b><span>{l}</span></div>)}
      </div>}
      {snap && tab === 'live' && <div className="grid2">
        <div className="card" style={{ gridColumn: '1 / -1' }}><h3>Live agent traffic <span className="muted">(rows update in place as PayPal webhooks land · click a row to inspect)</span></h3><LiveDesk rows={snap.sessions} onReplay={openReplay} /></div>
        <div className="card"><h3>Agent funnel</h3><Funnel rows={snap.funnel} /></div>
        <div className="card"><h3>Buyer mandates</h3><MandateGauges rows={snap.mandates} onRevoke={(id) => act(() => api.revoke(id))} /></div>
        <div className="card" style={{ gridColumn: '1 / -1' }}><h3>Demand gaps: what agents searched for and didn't find</h3><DemandGaps rows={snap.demandGaps} onDraft={(q) => { setTab('ops'); sendOps(`Draft a new product for "${q}"`); }} /></div>
      </div>}
      {snap && tab === 'approvals' && <div className="card"><h3>Approval queue <span className="muted">(held orders and ops-agent proposals: nothing executes until you approve)</span></h3><ApprovalQueue rows={snap.approvals} onDecide={(id, d) => act(() => api.decide(id, d))} /></div>}
      {snap && tab === 'agents' && <div style={{ display: 'grid', gap: 14 }}>
        <div className="card"><h3>Rollups <span className="muted">(group sessions by persona, agent, platform, status or payment mode)</span></h3><Rollup rows={snap.sessions} /></div>
        <div className="card"><h3>Agents & trust</h3><Agents rows={snap.agents} onTrust={(id, t) => act(() => api.trust(id, t))} /></div>
      </div>}
      {tab === 'replay' && <div className="card">{replay ? <SessionReplay header={`Session ${String(replay.session.id)} · ${String(replay.session.agentId)} · ${String(replay.session.status)}`} events={replay.events} /> : <p className="muted">Pick a session on the Live tab.</p>}</div>}
      {tab === 'ops' && <div className="card chat">
        <p className="muted">The ops agent reads store data and can only <b>propose</b> actions (refunds, prices, new products). Each one lands in the approval queue.</p>
        {chat.map((c, i) => c.me ? <div key={i} className="msg me">{c.me}</div> : <div key={i} className="msg bot">{c.bot!.reply}{c.bot!.proposals.length ? `\n\n→ ${c.bot!.proposals.length} proposal(s) sent to Approvals` : ''}</div>)}
        <form onSubmit={(e) => { e.preventDefault(); if (msg.trim()) sendOps(msg.trim()); }} style={{ display: 'flex', gap: 8 }}>
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="e.g. What are agents asking for that we don't sell?" style={{ flex: 1 }} />
          <button className="primary">Send</button>
        </form>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{['How are agent sales today?', 'What are agents searching for that we are missing?', 'Which orders are on hold and why?', 'Refund the last order'].map((q) => <button key={q} className="ghost" onClick={() => sendOps(q)}>{q}</button>)}</div>
      </div>}
      {tab === 'studio' && StudioView && <Suspense fallback={<p className="muted">Loading AG Studio…</p>}><StudioView snapshot={snap} events={events} /></Suspense>}
    </main>
  </GridThemeContext.Provider>);
}
