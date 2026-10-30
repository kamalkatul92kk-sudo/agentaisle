// Custom AG Grid Community cell renderers (custom components are Community features).
import { useState } from 'react';
import type { ICellRendererParams } from 'ag-grid-community';
import type { SessionRow } from '../../../src/shared/contracts';
import { lifecycle } from '../grid/logic';

const STATUS_ICON: Record<string, string> = { completed: '✓', on_hold: '⏸', rejected: '✕', failed: '✕', requires_buyer_action: '⏳', open: '…', canceled: '–', pending: '⏳', executed: '✓', known: '★', new: '•', blocked: '⛔', active: '●', revoked: '✕' };
export function StatusCell(p: ICellRendererParams) {
  if (p.node.rowPinned || !p.value) return null;
  const v = String(p.value);
  return <span className={`pill ${v}`} title={v}>{STATUS_ICON[v] ?? ''} {v.replace(/_/g, ' ')}</span>;
}

export function PayPalIdCell(p: ICellRendererParams) {
  const [copied, setCopied] = useState(false);
  if (!p.value) return <span className="muted">-</span>;
  const copy = (e: React.MouseEvent) => { e.stopPropagation(); navigator.clipboard?.writeText(String(p.value)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  return <span className="idcell"><span className="mono">{String(p.value)}</span><button className="copy" title="Copy PayPal id" onClick={copy}>{copied ? '✓' : '⧉'}</button></span>;
}

export function LifecycleCell(p: ICellRendererParams<SessionRow>) {
  if (!p.data || p.node.rowPinned) return null;
  return <span className="steps">{lifecycle(p.data).map((s) => <i key={s.key} className={`step ${s.state}`} title={`${s.label}: ${s.state}`} />)}</span>;
}

export function WebhookCell(p: ICellRendererParams<SessionRow>) {
  if (!p.data) return null;
  if (p.node.rowPinned) return <b>{p.data.webhooks}</b>;
  if (!p.data.webhooks) return <span className="muted">none yet</span>;
  return <span className="hook" title={`Last: ${p.data.lastWebhook} at ${p.data.lastWebhookAt}`}>✓ {p.data.webhooks} · {String(p.data.lastWebhook ?? '').replace(/^(PAYMENT|CHECKOUT|VAULT)\./, '')}</span>;
}

export function MoneyCell(p: ICellRendererParams<SessionRow>) {
  if (p.value == null) return null;
  const refunded = p.data?.refundedCents ?? 0;
  const v = `$${(Number(p.value) / 100).toFixed(2)}`;
  if (!p.node.rowPinned && refunded > 0 && refunded >= Number(p.value)) return <s title="Fully refunded">{v}</s>;
  return <span>{v}</span>;
}

/** Tiny SVG sparkline (hand-rolled, so it stays Community-only; AG Grid's built-in sparklines are Enterprise). */
export function Sparkline({ values, width = 110, height = 24 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join(' ');
  return <svg width={width} height={height} className="spark" aria-label="revenue trend"><polyline points={pts} fill="none" strokeWidth="1.6" />{values.map((v, i) => v > 0 && i === values.length - 1 ? <circle key={i} cx={i * step} cy={height - 2 - (v / max) * (height - 4)} r="2" /> : null)}</svg>;
}

export function RatioBar({ value, warnAbove }: { value: number; warnAbove?: number }) {
  const pct = Math.max(0, Math.min(1, value));
  const warn = warnAbove != null && value > warnAbove;
  return <span className="ratio"><i style={{ width: `${pct * 100}%` }} className={warn ? 'warn' : ''} /><b>{(value * 100).toFixed(0)}%</b></span>;
}
