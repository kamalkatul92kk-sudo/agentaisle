// MCP server for buyer agents (Streamable HTTP, stateless JSON mode — safe on Workers).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { AgentCtx, Deps } from '../domain/deps';
import { agentSearch, publicProduct } from '../domain/catalogService';
import { agentView, cancelCheckout, completeCheckout, createCheckout, getOwnSession, negotiate, updateCheckout } from '../domain/checkout';
import { DomainError } from '../domain/types';
import { MERCHANT } from '../domain/catalog';
import { LIMITS } from '../domain/pricing';

const items = z.array(z.object({ sku: z.string().min(3).max(40), qty: z.number().int().min(1).max(LIMITS.maxQtyPerLine) })).min(1).max(LIMITS.maxLines);

function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> }; }
function fail(e: unknown) {
  const err = e instanceof DomainError ? { error: e.code, message: e.message } : { error: 'internal_error', message: 'Unexpected error' };
  if (!(e instanceof DomainError)) console.error('mcp tool error', e);
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(err) }] };
}
const wrap = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => { try { return ok(await fn(a)); } catch (e) { return fail(e); } };

export const MCP_TOOL_NAMES = ['search_catalog', 'get_product', 'create_checkout', 'update_checkout', 'negotiate', 'complete_checkout', 'get_checkout', 'cancel_checkout', 'store_policies'] as const;

export function buildMcpServer(d: Deps, ctx: AgentCtx) {
  const server = new McpServer({ name: 'agentaisle-prickly-pear', version: '0.1.0' }, {
    instructions: `You are shopping at ${MERCHANT.name}, a fictional demo coffee roaster. Prices are USD cents. Flow: search_catalog -> create_checkout -> (optional) negotiate up to 3 rounds -> complete_checkout. Use payment_mode "mandate" only with a mandate_token your user gave you; otherwise use "approval_link" and send the returned approve_url to your user.`,
  });

  server.registerTool('store_policies', { title: 'Store policies', description: 'Shipping, bundle discounts, negotiation and limits.', inputSchema: {}, annotations: { readOnlyHint: true } },
    wrap(async () => ({ merchant: MERCHANT.name, fictional_demo: true, currency: 'USD', shipping: { flat_cents: MERCHANT.flatShippingCents, free_over_cents: MERCHANT.freeShippingThresholdCents },
      bundle_discounts: [{ min_bags: 3, percent: 5 }, { min_bags: 5, percent: 8 }], negotiation: { max_rounds: LIMITS.maxRounds, note: 'Reserve lots and gear are fixed price. Offers are for the goods total before shipping, in cents.' },
      limits: { max_qty_per_line: LIMITS.maxQtyPerLine, max_bags_per_order: LIMITS.maxBagsPerOrder }, payment: ['mandate (pre-authorised, capped)', 'approval_link (buyer approves each order on PayPal)'] })));

  server.registerTool('search_catalog', {
    title: 'Search catalog', description: 'Search coffees and gear. Empty query browses everything.',
    inputSchema: { query: z.string().max(200).default(''), roast: z.enum(['light', 'medium', 'medium_dark', 'dark']).optional(), category: z.enum(['single_origin', 'blend', 'reserve', 'gear']).optional(), max_price_cents: z.number().int().positive().optional(), origin: z.string().max(40).optional() },
    annotations: { readOnlyHint: true },
  }, wrap(async (a: { query: string; roast?: any; category?: any; max_price_cents?: number; origin?: string }) => ({ results: await agentSearch(d, ctx, a.query ?? '', { roast: a.roast, category: a.category, maxPriceCents: a.max_price_cents, origin: a.origin }) })));

  server.registerTool('get_product', { title: 'Get product', description: 'Product details by SKU.', inputSchema: { sku: z.string().min(3).max(40) }, annotations: { readOnlyHint: true } },
    wrap(async (a: { sku: string }) => { const p = await d.store.getProduct(a.sku); if (!p || !p.active) throw new DomainError('not_found', 'Unknown SKU', 404); return publicProduct(p); }));

  server.registerTool('create_checkout', { title: 'Create checkout', description: 'Start a checkout with a cart. Returns totals incl. bundle discount and shipping.', inputSchema: { items, buyer_note: z.string().max(500).optional() } },
    wrap(async (a: { items: { sku: string; qty: number }[]; buyer_note?: string }) => agentView(await createCheckout(d, ctx, a))));

  server.registerTool('update_checkout', { title: 'Update checkout', description: 'Replace the cart of an open checkout. Voids any agreed negotiated price.', inputSchema: { checkout_id: z.string(), items, buyer_note: z.string().max(500).optional() } },
    wrap(async (a: { checkout_id: string; items: { sku: string; qty: number }[]; buyer_note?: string }) => agentView(await updateCheckout(d, ctx, a.checkout_id, a))));

  server.registerTool('negotiate', { title: 'Negotiate', description: 'Offer a goods total (cents, before shipping). Up to 3 rounds; the merchant accepts, counters, or declines.', inputSchema: { checkout_id: z.string(), offer_cents: z.number().int().positive() } },
    wrap(async (a: { checkout_id: string; offer_cents: number }) => { const r = await negotiate(d, ctx, a.checkout_id, a.offer_cents); return { decision: r.decision, merchant_price_cents: r.merchant_price_cents, message: r.message, final: r.final, checkout: agentView(r.session) }; }));

  server.registerTool('complete_checkout', {
    title: 'Complete checkout', description: 'Pay. mandate: charges the buyer\'s saved PayPal within their caps (may be held for merchant review). approval_link: returns a PayPal link the buyer must approve.',
    inputSchema: { checkout_id: z.string(), payment_mode: z.enum(['mandate', 'approval_link']), mandate_token: z.string().max(200).optional(), idempotency_key: z.string().min(8).max(100) },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, wrap(async (a: { checkout_id: string; payment_mode: 'mandate' | 'approval_link'; mandate_token?: string; idempotency_key: string }) => agentView(await completeCheckout(d, ctx, a.checkout_id, a))));

  server.registerTool('get_checkout', { title: 'Get checkout', description: 'Current status of one of your checkouts.', inputSchema: { checkout_id: z.string() }, annotations: { readOnlyHint: true } },
    wrap(async (a: { checkout_id: string }) => agentView(await getOwnSession(d, ctx, a.checkout_id))));

  server.registerTool('cancel_checkout', { title: 'Cancel checkout', description: 'Cancel an open checkout.', inputSchema: { checkout_id: z.string() } },
    wrap(async (a: { checkout_id: string }) => agentView(await cancelCheckout(d, ctx, a.checkout_id))));

  return server;
}

export async function handleMcpRequest(d: Deps, ctx: AgentCtx, req: Request): Promise<Response> {
  const server = buildMcpServer(d, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(req); }
  finally { /* stateless: server/transport are per-request */ }
}
