export const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** PayPal amount strings: "12.34" */
export const toValue = (cents: number) => {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`invalid cents ${cents}`);
  return (cents / 100).toFixed(2);
};
export const fromValue = (value: string) => {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`invalid amount ${value}`);
  const [whole, frac = ''] = value.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
};
export const bps = (cents: number, basisPoints: number) => Math.round((cents * basisPoints) / 10000);
