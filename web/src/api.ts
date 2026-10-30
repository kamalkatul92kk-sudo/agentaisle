import type { DashboardSnapshot, EventRow, ApprovalRow } from '../../src/shared/contracts';

const TOKEN_KEY = 'agentaisle.merchantToken';
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}`, ...(init.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.error?.message ?? body?.message ?? `HTTP ${r.status}`), { status: r.status });
  return body as T;
}

export interface SimResult { sessions: number; completed: number; held: number; rejected: number; abandoned: number; awaitingBuyer: number; deniedMandate: number; errors: number }
export interface OpsReply { reply: string; steps: { tool: string; result: unknown }[]; proposals: ApprovalRow[] }
export interface Replay { session: Record<string, unknown>; events: EventRow[]; payment: Record<string, unknown> | null }

export const api = {
  dashboard: () => call<DashboardSnapshot>('/api/merchant/dashboard'),
  events: (after: number, limit = 200) => call<{ events: EventRow[] }>(`/api/merchant/events?after=${after}&limit=${limit}`),
  replay: (id: string) => call<Replay>(`/api/merchant/sessions/${encodeURIComponent(id)}/replay`),
  decide: (id: string, decision: 'approve' | 'reject', note?: string) => call(`/api/merchant/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) }),
  ops: (message: string) => call<OpsReply>('/api/merchant/ops/chat', { method: 'POST', body: JSON.stringify({ message }) }),
  trust: (id: string, trust: 'new' | 'known' | 'blocked') => call(`/api/merchant/agents/${encodeURIComponent(id)}/trust`, { method: 'POST', body: JSON.stringify({ trust }) }),
  revoke: (id: string) => call(`/api/merchant/mandates/${id}/revoke`, { method: 'POST' }),
  simulate: (sessions = 10) => call<SimResult>('/api/merchant/simulate', { method: 'POST', body: JSON.stringify({ sessions }) }),
  reset: () => call('/api/merchant/reset', { method: 'POST' }),
};

export const money = (c: number | null | undefined) => (c == null ? '' : `$${(c / 100).toFixed(2)}`);
