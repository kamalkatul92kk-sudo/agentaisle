import { seedProducts } from './catalog';
import type { Deps, AgentCtx } from './deps';
import { emit } from './deps';
import type { Category, Product, Roast } from './types';
import { touchAgent } from './agents';

export interface SearchFilters { roast?: Roast; category?: Category; maxPriceCents?: number; origin?: string; inStockOnly?: boolean }

const STOP = new Set(['a', 'an', 'the', 'for', 'of', 'and', 'with', 'coffee', 'beans', 'bean', 'bag', 'bags', 'some', 'me', 'i', 'want', 'need', 'find', 'roasted', 'whole', 'ground', 'lb', 'oz', '12oz', 'please']);
export function normalizeQuery(q: string) {
  return q.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t)).sort().join(' ');
}
const SYN: Record<string, string[]> = { decaf: ['decaf'], espresso: ['espresso'], 'pour-over': ['pour-over', 'pour', 'dripper'], 'cold': ['cold brew', 'brazil', 'low-acid'], fruity: ['blueberry', 'blackcurrant', 'fruit', 'peach'], chocolate: ['chocolate', 'cocoa'] };

export function productText(p: Product) {
  return [p.name, p.category.replace('_', ' '), p.roast?.replace('_', ' '), p.origin, p.process, p.tastingNotes, p.description].filter(Boolean).join(' ').toLowerCase();
}

export function searchProducts(products: Product[], query: string, f: SearchFilters = {}) {
  const terms = normalizeQuery(query).split(' ').filter(Boolean);
  const scored = products.filter((p) => p.active)
    .filter((p) => (f.roast ? p.roast === f.roast : true))
    .filter((p) => (f.category ? p.category === f.category : true))
    .filter((p) => (f.maxPriceCents ? p.priceCents <= f.maxPriceCents : true))
    .filter((p) => (f.origin ? (p.origin ?? '').toLowerCase().includes(f.origin.toLowerCase()) : true))
    .filter((p) => (f.inStockOnly === false ? true : p.stock > 0))
    .map((p) => {
      const text = productText(p);
      let score = 0;
      for (const t of terms) {
        const alts = [t, ...(SYN[t] ?? [])];
        if (alts.some((a) => text.includes(a))) score += 1;
      }
      return { p, score };
    })
    .filter((x) => terms.length === 0 || x.score === terms.length) // all terms must match
    .sort((a, b) => b.score - a.score || a.p.priceCents - b.p.priceCents);
  return scored.map((x) => x.p);
}

export function publicProduct(p: Product) {
  return { sku: p.sku, name: p.name, category: p.category, roast: p.roast, origin: p.origin, process: p.process, tasting_notes: p.tastingNotes,
    description: p.description, weight_oz: p.weightOz, price_cents: p.priceCents, price: `$${(p.priceCents / 100).toFixed(2)}`, in_stock: p.stock > 0,
    stock: Math.min(p.stock, 25), negotiable: p.negotiable };
}

export async function agentSearch(d: Deps, ctx: AgentCtx, query: string, f: SearchFilters = {}) {
  await touchAgent(d, ctx);
  const products = await d.store.listProducts();
  const results = searchProducts(products, query, f);
  const normalized = [normalizeQuery(query), f.roast, f.category, f.origin].filter(Boolean).join(' | ') || '(browse)';
  await d.store.recordSearch({ ts: d.clock.now().toISOString(), agentId: ctx.agentId, query, normalized, resultCount: results.length });
  await emit(d, 'agent.search', { agentId: ctx.agentId, data: { query, filters: f, results: results.length } });
  return results.slice(0, 10).map(publicProduct);
}

export async function seedCatalogIfEmpty(d: Deps) {
  const existing = await d.store.listProducts({ includeInactive: true });
  if (existing.length) return false;
  for (const p of seedProducts(d.clock.now().toISOString())) await d.store.upsertProduct(p);
  return true;
}
