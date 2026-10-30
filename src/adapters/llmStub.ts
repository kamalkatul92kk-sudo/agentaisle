// Deterministic LLM stand-in: no network, no key, no spend. Real clients implement the same LlmClient port.
import type { LlmClient, LlmMessage } from '../ports';

export class StubLlm implements LlmClient {
  readonly name = 'stub';
  calls: { purpose: string; messages: LlmMessage[] }[] = [];
  async complete(input: { purpose: string; messages: LlmMessage[]; json?: boolean }): Promise<string> {
    this.calls.push({ purpose: input.purpose, messages: input.messages });
    const last = input.messages[input.messages.length - 1]?.content ?? '';
    if (input.purpose === 'negotiation_message') return '';        // empty => caller uses its template
    if (input.purpose === 'ops_plan') return JSON.stringify(stubOpsPlan(last));
    if (input.purpose === 'buyer_plan') return '{}';
    return '';
  }
}

/** Keyword planner that mimics what an LLM tool-planner would return for the ops agent. */
export function stubOpsPlan(text: string): { tool: string; args: Record<string, unknown> }[] {
  const t = text.toLowerCase();
  const plan: { tool: string; args: Record<string, unknown> }[] = [];
  if (/refund/.test(t)) {
    const all = /\ball\b|every|everything/.test(t);
    const m = t.match(/(cs_[a-z0-9]+)/);
    plan.push({ tool: 'propose_refund', args: all ? { scope: 'all' } : { sessionId: m?.[1] ?? null } });
  }
  if (/release|approve (the )?held|held orders?/.test(t)) plan.push({ tool: /release|approve/.test(t) ? 'propose_release' : 'list_held_orders', args: { scope: 'all' } });
  if (/gap|missing|searched|demand|didn.?t find|zero.?result/.test(t)) plan.push({ tool: 'list_demand_gaps', args: {} });
  if (/add|create|launch|list a new|new product/.test(t)) {
    const m = t.match(/(?:add|create|launch)\s+(?:a\s+)?(?:new\s+)?(?:product\s+)?(?:for\s+)?["']?([a-z0-9 \-]+?)["']?(?:\s+at\s+\$?(\d+(?:\.\d{1,2})?))?$/);
    plan.push({ tool: 'propose_product', args: { name: m?.[1]?.trim() ?? null, price: m?.[2] ? Number(m[2]) : null } });
  }
  if (plan.length === 0 || /kpi|how are|sales|revenue|summary|today/.test(t)) plan.push({ tool: 'get_kpis', args: {} });
  return plan;
}
