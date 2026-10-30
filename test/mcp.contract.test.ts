// MCP contract tests: the official MCP SDK client talks to our Worker app over Streamable HTTP.
import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { harness, activeMandate, BASE, type H } from './harness';
import { MCP_TOOL_NAMES } from '../src/mcp/server';
import { mcpToolCaller } from '../src/agents/toolCaller';

let h: H;
beforeEach(async () => { h = await harness(); });

async function connect(agentId: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { 'x-agent-id': agentId, 'x-agent-platform': 'mcp-sdk-test' } },
    fetch: (url, init) => h.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'contract-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

describe('MCP contract', () => {
  it('initialize + lists exactly the documented tools with input schemas', async () => {
    const c = await connect('agent-mcp-1');
    expect(c.getServerVersion()?.name).toBe('agentaisle-prickly-pear');
    expect(c.getInstructions()).toMatch(/approval_link/);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    const complete = tools.find((t) => t.name === 'complete_checkout')!;
    expect(complete.inputSchema.required).toEqual(expect.arrayContaining(['checkout_id', 'payment_mode', 'idempotency_key']));
    expect((complete.inputSchema.properties as any).payment_mode.enum).toEqual(['mandate', 'approval_link']);
    expect(tools.find((t) => t.name === 'search_catalog')!.annotations?.readOnlyHint).toBe(true);
    await c.close();
  });

  it('full purchase over MCP with a mandate', async () => {
    const { token } = await activeMandate(h);
    const c = await connect('agent-mcp-2');
    const search = parse(await c.callTool({ name: 'search_catalog', arguments: { query: 'ethiopia light roast' } }));
    expect(search.results[0].sku).toBe('PP-SO-ETH-12');
    expect(JSON.stringify(search)).not.toMatch(/cost|floor/i);
    const co = parse(await c.callTool({ name: 'create_checkout', arguments: { items: [{ sku: 'PP-SO-ETH-12', qty: 2 }] } }));
    const neg = parse(await c.callTool({ name: 'negotiate', arguments: { checkout_id: co.checkout_id, offer_cents: 3000 } }));
    expect(['counter', 'accept']).toContain(neg.decision);
    const done = parse(await c.callTool({ name: 'complete_checkout', arguments: { checkout_id: co.checkout_id, payment_mode: 'mandate', mandate_token: token, idempotency_key: 'mcp-idem-0001' } }));
    expect(done.status).toBe('completed');
    expect(done.paypal_order_id).toMatch(/^MOCK/);
    await c.close();
  });

  it('domain errors come back as isError tool results, schema errors as errors', async () => {
    const c = await connect('agent-mcp-3');
    const r: any = await c.callTool({ name: 'get_checkout', arguments: { checkout_id: 'cs_doesnotexist' } });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('not_found');
    const bad: any = await c.callTool({ name: 'create_checkout', arguments: { items: [{ sku: 'PP-SO-ETH-12', qty: 99 }] } }).catch((e) => ({ thrown: String(e) }));
    expect(bad.isError === true || bad.thrown).toBeTruthy();
    await c.close();
  });

  it('rejects requests without a valid x-agent-id', async () => {
    const res = await h.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
    expect(res.status).toBe(401);
  });

  it('stateless tools/call works without initialize (simulator caller)', async () => {
    const call = mcpToolCaller(h.fetch, `${BASE}/mcp`, { 'x-agent-id': 'agent-raw-1' });
    const r = await call('store_policies', {});
    expect(r.ok).toBe(true);
    expect((r as any).data.fictional_demo).toBe(true);
    const e = await call('get_checkout', { checkout_id: 'cs_nope' });
    expect(e).toMatchObject({ ok: false, error: 'not_found' });
  });
});
