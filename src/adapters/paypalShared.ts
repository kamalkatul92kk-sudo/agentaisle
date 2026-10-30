import { toValue } from '../domain/money';
import type { CreateOrderInput } from '../ports';

/** Orders v2 purchase_units payload with an itemised breakdown PayPal will validate. */
export function purchaseUnit(i: CreateOrderInput) {
  return {
    reference_id: i.referenceId,
    custom_id: i.referenceId,
    description: i.description.slice(0, 127),
    amount: {
      currency_code: 'USD',
      value: toValue(i.totalCents),
      breakdown: {
        item_total: { currency_code: 'USD', value: toValue(i.itemTotalCents) },
        shipping: { currency_code: 'USD', value: toValue(i.shippingCents) },
        discount: { currency_code: 'USD', value: toValue(i.discountCents) },
      },
    },
    items: i.lines.map((l) => ({ name: l.name.slice(0, 127), sku: l.sku, quantity: String(l.qty), unit_amount: { currency_code: 'USD', value: toValue(l.unitCents) }, category: 'PHYSICAL_GOODS' })),
  };
}

export function linkOf(links: { rel: string; href: string }[] | undefined, ...rels: string[]) {
  for (const r of rels) { const l = links?.find((x) => x.rel === r); if (l) return l.href; }
  return null;
}
