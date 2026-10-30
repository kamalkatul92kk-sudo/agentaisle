import { createHash } from 'node:crypto';
// Public demo deployment rules: read-only without the merchant token, no secrets, location = "Texas" only (no city or employer names),
// and every public surface says it is a sandbox demo.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { harness, BASE } from './harness';
import { MERCHANT, seedProducts } from '../src/domain/catalog';

// Location-privacy guard. Public copy names the location as "Texas" only. The place names that must not appear are
// stored as truncated SHA-256 hashes of lowercase one- and two-word phrases, so this public file does not spell them out.
const BANNED_HASHES = new Set(['c7c1319276e936c8', 'e2947cc4abd70537', '56fe43f748e258de', 'fa2115f8d576a6ab', '9bfb7fdfeb2fb0b5', '559fb55a0e8f116f', 'a733340e6b7d253a']);
const h16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
function bannedHits(text: string): string[] {
  const w = text.toLowerCase().split(/[^a-z]+/).filter(Boolean); const hits: string[] = [];
  for (let i = 0; i < w.length; i++) for (const p of [w[i], i + 1 < w.length ? `${w[i]} ${w[i + 1]}` : '']) if (p && BANNED_HASHES.has(h16(p))) hits.push(h16(p));
  return hits;
}

describe('public demo', () => {
  it('DEMO_MODE: control room is readable without a token, every action still needs it', async () => {
    const h = await harness({ demoMode: true });
    const r = (p: string, init?: RequestInit) => h.fetch(new Request(`${BASE}${p}`, init));
    expect((await r('/api/merchant/dashboard')).status).toBe(200);
    expect((await r('/api/merchant/events')).status).toBe(200);
    const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    for (const p of ['/api/merchant/simulate', '/api/merchant/reset', '/api/merchant/ops/chat', '/api/merchant/approvals/apr_x/decide', '/api/merchant/mandates/m_x/revoke', '/api/merchant/agents/a_x/trust'])
      expect((await r(p, post)).status, p).toBe(401);
  });

  it('health and dashboard expose no secrets and name the location as Texas only', async () => {
    const h = await harness({ demoMode: true });
    const health = await (await h.fetch(new Request(`${BASE}/api/health`))).json() as any;
    expect(health.location).toBe('Texas');
    const all = JSON.stringify(health) + await (await h.fetch(new Request(`${BASE}/api/merchant/dashboard`))).text() + await (await h.fetch(new Request(`${BASE}/api/catalog`))).text();
    expect(bannedHits(all)).toEqual([]);
    expect(all).not.toMatch(/merchant-test-token|client_secret|clientSecret|webhook_secret|vault_id|vaultId/i);
  });

  it('merchant copy and catalog: Texas only, no banned location words', () => {
    expect(MERCHANT.city).toBe('Texas');
    expect(bannedHits(JSON.stringify({ MERCHANT, p: seedProducts('2026-01-01T00:00:00Z') }))).toEqual([]);
  });

  it('buyer-facing HTML pages carry the sandbox notice', async () => {
    const h = await harness();
    const t = await (await h.fetch(new Request(`${BASE}/mandates/cancel`))).text();
    expect(t).toMatch(/sandbox/i); expect(t).toMatch(/no real money/i); expect(bannedHits(t)).toEqual([]);
  });

  it('web console source: sandbox banner, no banned words, no baked-in secrets', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (/\.(tsx?|html|css)$/.test(f.name)) files.push(p); } };
    walk('web/src'); if (existsSync('web/index.html')) files.push('web/index.html');
    const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(src).toMatch(/demo-banner/); expect(src).toMatch(/no real money/);
    expect(bannedHits(src)).toEqual([]);
    expect(src).not.toMatch(/\.dev\.vars|PAYPAL_CLIENT_SECRET/);
  });

  it('public docs (README, docs/, submission/) say sandbox + fictional and avoid banned words', () => {
    const files = ['README.md'];
    for (const d of ['docs', 'submission']) if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.md')) files.push(`${d}/${f}`);
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(bannedHits(all)).toEqual([]);
    expect(all).toMatch(/sandbox/i); expect(all).toMatch(/fictional/i);
    expect(all).not.toMatch(/PAYPAL_CLIENT_SECRET=(?!\.\.\.|\$|<)\S|merchant-test-token/);
  });
});
