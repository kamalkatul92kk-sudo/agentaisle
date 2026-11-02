// Message phrasing for negotiation. Numbers come from pricing.ts; the model (if any) may only rephrase,
// and its output is discarded if it mentions a different dollar amount or contains links/markup.
import { z } from 'zod';
import type { Deps } from './deps';
import type { NegotiationDecision } from './pricing';
import { fmt } from './money';
import { aiStructured, logAi, textProblem } from '../ai/structured';

export function templateMessage(dec: NegotiationDecision, offerCents: number) {
  if (dec.decision === 'accept') return `Deal. ${fmt(dec.merchantPriceCents)} for the goods is locked in for this checkout.`;
  if (dec.decision === 'counter') return `Thanks for the offer of ${fmt(offerCents)}. The best I can do right now is ${fmt(dec.merchantPriceCents)} (round ${dec.round} of 3).`;
  return `Sorry, I can't go that low. The price stays at ${fmt(dec.merchantPriceCents)}.`;
}

const amounts = (s: string) => (s.match(/\$\d+(?:\.\d{2})?/g) ?? []).sort().join(',');
const Schema = z.object({ message: z.string().min(1) });
const JSON_SCHEMA = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };

export async function phraseNegotiation(d: Deps, dec: NegotiationDecision, offerCents: number, ctx: { sessionId?: string; agentId?: string } = {}): Promise<string> {
  const base = templateMessage(dec, offerCents);
  const o = await aiStructured(d, {
    purpose: 'negotiation_message', maxTokens: 120,
    system: `You are the friendly shop assistant for ${d.config.merchantName} (the seller), replying to a buyer's shopping agent that is haggling. ` +
      'The JSON gives the buyer\'s offer, your decision and your price. Rewrite the draft reply in one or two warm sentences, in the seller\'s voice. ' +
      'The buyer made the offer; the price is yours. Keep every dollar amount exactly as written and do not add any new amounts, discounts, promises or links. Reply as JSON {"message": "..."}.',
    user: JSON.stringify({ buyer_offer: fmt(offerCents), decision: dec.decision, your_price: fmt(dec.merchantPriceCents), round: dec.round, max_rounds: 3, draft_reply: base }),
    schema: Schema, jsonSchema: JSON_SCHEMA,
    fallback: () => ({ message: base }),
    guard: (v) => textProblem(v.message, 300) ?? (amounts(v.message) !== amounts(base) ? 'dollar amounts changed' : null) ?? (/\byour counter/i.test(v.message) ? 'wrong voice (gave the seller price to the buyer)' : null),
  });
  await logAi(d, o, { purpose: 'negotiation_message', sessionId: ctx.sessionId, agentId: ctx.agentId, note: o.value.message });
  return o.value.message.trim() || base;
}
