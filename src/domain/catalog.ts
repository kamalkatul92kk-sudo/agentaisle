// Seed catalog for the FICTIONAL demo merchant "Pecan Plume Coffee Co." (Texas). Public copy names the state only.
// Every name, price and story here is invented for the hackathon demo; no real business is depicted.
import type { Product } from './types';

export const MERCHANT = {
  name: 'Pecan Plume Coffee Co.',
  tagline: 'Small-batch coffee roasted in Texas (fictional demo merchant)',
  city: 'Texas',
  currency: 'USD' as const,
  flatShippingCents: 699,
  freeShippingThresholdCents: 5000,
};

type Seed = Omit<Product, 'paypalProductId' | 'active' | 'createdAt'>;

const seeds: Seed[] = [
  { sku: 'PP-SO-ETH-12', name: 'Ethiopia Guji Natural', category: 'single_origin', roast: 'light', origin: 'Ethiopia', process: 'Natural', tastingNotes: 'blueberry, jasmine, cocoa nib', description: 'Bright, fruit-forward light roast. Great for pour-over.', weightOz: 12, priceCents: 1950, costCents: 980, stock: 60, negotiable: true, maxDiscountBps: 1000 },
  { sku: 'PP-SO-COL-12', name: 'Colombia Huila Washed', category: 'single_origin', roast: 'medium', origin: 'Colombia', process: 'Washed', tastingNotes: 'caramel, red apple, toffee', description: 'Balanced medium roast for drip, pour-over or AeroPress.', weightOz: 12, priceCents: 1750, costCents: 860, stock: 80, negotiable: true, maxDiscountBps: 1000 },
  { sku: 'PP-SO-GUA-12', name: 'Guatemala Huehuetenango', category: 'single_origin', roast: 'medium', origin: 'Guatemala', process: 'Washed', tastingNotes: 'milk chocolate, orange zest, almond', description: 'Sweet and clean medium roast. Pour-over friendly.', weightOz: 12, priceCents: 1800, costCents: 900, stock: 45, negotiable: true, maxDiscountBps: 1000 },
  { sku: 'PP-SO-KEN-12', name: 'Kenya Nyeri AA', category: 'single_origin', roast: 'light', origin: 'Kenya', process: 'Washed', tastingNotes: 'blackcurrant, grapefruit, brown sugar', description: 'Juicy and complex light roast.', weightOz: 12, priceCents: 2200, costCents: 1150, stock: 30, negotiable: true, maxDiscountBps: 800 },
  { sku: 'PP-SO-BRA-12', name: 'Brazil Cerrado Natural', category: 'single_origin', roast: 'medium_dark', origin: 'Brazil', process: 'Natural', tastingNotes: 'peanut butter, dark chocolate, low acidity', description: 'Nutty, low-acid medium-dark roast. Espresso and cold brew.', weightOz: 12, priceCents: 1550, costCents: 720, stock: 90, negotiable: true, maxDiscountBps: 1200 },
  { sku: 'PP-SO-SUM-12', name: 'Sumatra Gayo Wet-Hulled', category: 'single_origin', roast: 'dark', origin: 'Indonesia', process: 'Wet-hulled', tastingNotes: 'cedar, molasses, baker\'s chocolate', description: 'Earthy, full-bodied dark roast.', weightOz: 12, priceCents: 1700, costCents: 840, stock: 40, negotiable: true, maxDiscountBps: 1000 },
  { sku: 'PP-SO-HON-12', name: 'Honduras Marcala Honey', category: 'single_origin', roast: 'medium', origin: 'Honduras', process: 'Honey', tastingNotes: 'honey, stone fruit, vanilla', description: 'Round, sweet medium roast.', weightOz: 12, priceCents: 1800, costCents: 890, stock: 35, negotiable: true, maxDiscountBps: 1000 },
  { sku: 'PP-BL-HC-12', name: 'Lone Star Morning Blend', category: 'blend', roast: 'medium', origin: 'Colombia, Brazil', process: 'Blend', tastingNotes: 'graham cracker, cocoa, cherry', description: 'Everyday medium blend for drip machines.', weightOz: 12, priceCents: 1500, costCents: 680, stock: 120, negotiable: true, maxDiscountBps: 1200 },
  { sku: 'PP-BL-HC-32', name: 'Lone Star Morning Blend (2 lb)', category: 'blend', roast: 'medium', origin: 'Colombia, Brazil', process: 'Blend', tastingNotes: 'graham cracker, cocoa, cherry', description: 'Office-size bag of the everyday medium blend.', weightOz: 32, priceCents: 3400, costCents: 1600, stock: 40, negotiable: true, maxDiscountBps: 1200 },
  { sku: 'PP-BL-ESP-12', name: 'Pecan Street Espresso', category: 'blend', roast: 'medium_dark', origin: 'Brazil, Guatemala, Ethiopia', process: 'Blend', tastingNotes: 'toasted pecan, dark caramel, plum', description: 'Syrupy espresso blend that also loves milk.', weightOz: 12, priceCents: 1650, costCents: 760, stock: 70, negotiable: true, maxDiscountBps: 1200 },
  { sku: 'PP-BL-DCF-12', name: 'Night Owl Swiss Water Decaf', category: 'blend', roast: 'medium', origin: 'Colombia, Peru', process: 'Swiss Water decaf', tastingNotes: 'cocoa, walnut, soft citrus', description: 'Chemical-free decaf, medium roast.', weightOz: 12, priceCents: 1700, costCents: 820, stock: 50, negotiable: true, maxDiscountBps: 1000 },
  { sku: 'PP-RS-PAN-8', name: 'Panama Geisha Reserve', category: 'reserve', roast: 'light', origin: 'Panama', process: 'Washed', tastingNotes: 'bergamot, white peach, honeysuckle', description: 'Very limited reserve lot. Fixed price, not negotiable.', weightOz: 8, priceCents: 4800, costCents: 3100, stock: 8, negotiable: false, maxDiscountBps: 0 },
  { sku: 'PP-GR-DRIP-01', name: 'Ceramic Pour-Over Dripper', category: 'gear', roast: null, origin: null, process: null, tastingNotes: null, description: 'Size 02 ceramic dripper. Fixed price.', weightOz: null, priceCents: 2600, costCents: 1300, stock: 25, negotiable: false, maxDiscountBps: 0 },
  { sku: 'PP-GR-FILT-100', name: 'Paper Filters (100 pack)', category: 'gear', roast: null, origin: null, process: null, tastingNotes: null, description: 'Size 02 cone filters.', weightOz: null, priceCents: 700, costCents: 250, stock: 200, negotiable: false, maxDiscountBps: 0 },
];

export function seedProducts(nowIso: string): Product[] {
  return seeds.map((s) => ({ ...s, paypalProductId: null, active: true, createdAt: nowIso }));
}
