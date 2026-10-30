// Message phrasing for negotiation. Numbers come from pricing.ts; the LLM (if any) may only rephrase,
// and its output is discarded if it mentions a different dollar amount or contains links/markup.
import type { Deps } from './deps';
import type { NegotiationDecision } from './pricing';
import { fmt } from './money';

export function templateMessage(dec: NegotiationDecision, offerCents: number) {
  if (dec.decision === 'accept') return `Deal. ${fmt(dec.merchantPriceCents)} for the goods is locked in for this checkout.`;
  if (dec.decision === 'counter') return `Thanks for the offer of ${fmt(offerCents)}. The best I can do right now is ${fmt(dec.merchantPriceCents)} (round ${dec.round} of 3).`;
  return `Sorry, I can't go that low. The price stays at ${fmt(dec.merchantPriceCents)}.`;
}

export async function phraseNegotiation(d: Deps, dec: NegotiationDecision, offerCents: number): Promise<string> {
  const base = templateMessage(dec, offerCents);
  try {
    const out = (await d.llm.complete({
      purpose: 'negotiation_message', maxTokens: 80,
      messages: [
        { role: 'system', content: `You are the friendly shop assistant for ${d.config.merchantName}. Rephrase the message in one or two sentences. Keep every dollar amount exactly as given. No links.` },
        { role: 'user', content: base },
      ],
    })).trim();
    if (!out) return base;
    const amounts = (s: string) => (s.match(/\$\d+(?:\.\d{2})?/g) ?? []).sort().join(',');
    if (amounts(out) !== amounts(base) || /https?:|<|\]\(/i.test(out) || out.length > 300) return base;
    return out;
  } catch { return base; }
}
