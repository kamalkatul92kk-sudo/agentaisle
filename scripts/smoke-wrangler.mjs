#!/usr/bin/env node
// Smoke test against a running `wrangler dev` (real workerd + local D1 + Durable Object ledger).
// Usage: npm run dev (in another shell)  then  node scripts/smoke-wrangler.mjs [baseUrl]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:8787';
import { readFileSync, existsSync } from 'node:fs';
// Token comes from the env or the gitignored .dev.vars, never from source.
const devVar = (k) => existsSync('.dev.vars') ? (readFileSync('.dev.vars', 'utf8').match(new RegExp(`^${k}=["']?([^"'\r\n]*)`, 'm')) || [])[1] : undefined;
const MT = process.env.MERCHANT_TOKEN || devVar('MERCHANT_TOKEN');
if (!MT) { console.error('Set MERCHANT_TOKEN (or put it in .dev.vars)'); process.exit(2); }
const M = { authorization: `Bearer ${MT}`, 'content-type': 'application/json' };
const ok = (c, m) => { if (!c) { console.error('✗', m); process.exit(1); } console.log('✓', m); };
const j = async (p, i) => { const r = await fetch(BASE + p, i); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t), r } } catch { return { s: r.status, b: t, r } } };

ok((await j('/api/health')).b.ok, 'health');
const reset = await j('/api/merchant/reset', { method: 'POST', headers: M });
ok(reset.s === 200, 'reset store');

// buyer-present mandate (mock PayPal page) -> Durable Object ledger
const m = (await j('/api/mandates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_name: 'Smoke Buyer', per_order_cap_cents: 8000, monthly_cap_cents: 20000 }) })).b;
const au = new URL(m.approve_url);
const ap = await fetch(BASE + '/mock-paypal/approve-setup', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: au.searchParams.get('approval_session_id'), a: 'yes' }) });
const back = new URL(ap.headers.get('location'));
ok((await (await fetch(BASE + back.pathname + back.search)).text()).includes('PayPal saved'), 'mandate approved via mock PayPal page');

// MCP purchase with the official SDK client
const client = new Client({ name: 'smoke-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { 'x-agent-id': 'smoke-agent-1', 'x-agent-platform': 'smoke' } } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
ok(tools.includes('complete_checkout'), `MCP tools: ${tools.join(', ')}`);
const P = (r) => JSON.parse(r.content[0].text);
const s = P(await client.callTool({ name: 'search_catalog', arguments: { query: 'ethiopia' } }));
const co = P(await client.callTool({ name: 'create_checkout', arguments: { items: [{ sku: s.results[0].sku, qty: 2 }] } }));
const n = P(await client.callTool({ name: 'negotiate', arguments: { checkout_id: co.checkout_id, offer_cents: 2500 } }));
console.log('  negotiate:', n.message);
const done = P(await client.callTool({ name: 'complete_checkout', arguments: { checkout_id: co.checkout_id, payment_mode: 'mandate', mandate_token: m.mandate_token, idempotency_key: 'smoke-idem-0001' } }));
ok(done.status === 'completed', `MCP purchase completed, total ${done.total_cents}c, PayPal order ${done.paypal_order_id}`);
await client.close();

const mand = (await j('/api/merchant/mandates', { headers: M })).b;
const row = (mand.mandates || mand).find((x) => x.id === m.mandate_id);
ok(row && row.spentThisMonthCents === done.total_cents, `Durable Object ledger shows spent ${row?.spentThisMonthCents}c of ${row?.monthlyCapCents}c`);

const sim = (await j('/api/merchant/simulate', { method: 'POST', headers: M, body: JSON.stringify({ sessions: 25, seed: 3 }) })).b;
ok(sim.errors === 0 && sim.completed > 0, `simulator: ${JSON.stringify({ completed: sim.completed, held: sim.held, rejected: sim.rejected, abandoned: sim.abandoned, deniedMandate: sim.deniedMandate, errors: sim.errors })}`);

const d = (await j('/api/merchant/dashboard', { headers: M })).b;
ok(d.kpis && d.sessions.length > 0, `dashboard: ${JSON.stringify(d.kpis)}`);
ok((await j('/api/merchant/dashboard')).s === 401, 'merchant API rejects missing token');
const sched = await fetch(BASE + '/__scheduled?cron=*/5+*+*+*+*');
ok(sched.ok, 'cron trigger (simulator tick) ran');
console.log('\nSMOKE OK');
