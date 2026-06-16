// Pavia product catalog
// Each product has color objects with hex values for proper swatches.
const PAVIA_PRESET_IMAGE = (id) => window.PaviaImages?.resolve(id) || `assets/placeholders/${id}.svg`;

window.PAVIA_DEFAULT_PRODUCTS = [
  {
    id: 'blue-pearl-blouse',
    name: 'Blue Pearl Ruffle Blouse',
    category: 'Tops',
    price: 42,
    compareAt: 52,
    badge: 'New',
    imageId: 'pavia-look-01',
    image: PAVIA_PRESET_IMAGE('pavia-look-01'),
    description: 'Airy ruffle blouse with a polished feminine silhouette. Perfect with denim or tailored pants.',
    sizes: ['S', 'M', 'L', 'XL'],
    colors: [
      { name: 'Sky Blue', hex: '#9ec1de' },
      { name: 'White', hex: '#fafafa' }
    ],
    stock: 9,
    featured: true,
    createdAt: 12
  },
  {
    id: 'denim-maxi-skirt',
    name: 'Button Front Denim Maxi Skirt',
    category: 'Skirts',
    price: 48,
    compareAt: 0,
    badge: 'Best Seller',
    imageId: 'pavia-look-02',
    image: PAVIA_PRESET_IMAGE('pavia-look-02'),
    description: 'High-waist denim maxi skirt with front buttons and an elegant everyday drape.',
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    colors: [
      { name: 'Medium Blue', hex: '#5a7da3' }
    ],
    stock: 14,
    featured: true,
    createdAt: 11
  },
  {
    id: 'azure-coord-set',
    name: 'Azure Modest Co-ord Set',
    category: 'Sets',
    price: 68,
    compareAt: 79,
    badge: 'Limited',
    imageId: 'pavia-look-03',
    image: PAVIA_PRESET_IMAGE('pavia-look-03'),
    description: 'An effortless matching set designed for modern elegance and breathable comfort.',
    sizes: ['S', 'M', 'L'],
    colors: [
      { name: 'Azure', hex: '#7fa8d6' }
    ],
    stock: 6,
    featured: true,
    createdAt: 10
  },
  {
    id: 'cocoa-pleated-pants',
    name: 'Cocoa Pleated Wide Pants',
    category: 'Pants',
    price: 46,
    compareAt: 0,
    badge: 'Low Stock',
    imageId: 'pavia-look-04',
    image: PAVIA_PRESET_IMAGE('pavia-look-04'),
    description: 'Soft pleated pants in a rich cocoa tone with a wide-leg fit and clean movement.',
    sizes: ['S', 'M', 'L', 'XL'],
    colors: [
      { name: 'Cocoa', hex: '#5c4034' },
      { name: 'Mocha', hex: '#7a5443' }
    ],
    stock: 4,
    featured: false,
    createdAt: 9
  },
  {
    id: 'ivory-oversized-shirt',
    name: 'Ivory Oversized Shirt',
    category: 'Tops',
    price: 39,
    compareAt: 46,
    badge: 'Essential',
    imageId: 'pavia-look-05',
    image: PAVIA_PRESET_IMAGE('pavia-look-05'),
    description: 'Crisp ivory oversized shirt that works tucked, layered, or styled open.',
    sizes: ['S', 'M', 'L', 'XL'],
    colors: [
      { name: 'Ivory', hex: '#f3ead8' },
      { name: 'Cream', hex: '#ede2cf' }
    ],
    stock: 12,
    featured: false,
    createdAt: 8
  },
  {
    id: 'cream-wide-leg-pants',
    name: 'Cream Tailored Wide Leg Pants',
    category: 'Pants',
    price: 49,
    compareAt: 0,
    badge: 'Chic',
    imageId: 'pavia-look-06',
    image: PAVIA_PRESET_IMAGE('pavia-look-06'),
    description: 'A soft neutral trouser with clean tailoring and a graceful wide-leg profile.',
    sizes: ['XS', 'S', 'M', 'L'],
    colors: [
      { name: 'Cream', hex: '#ede2cf' }
    ],
    stock: 8,
    featured: false,
    createdAt: 7
  },
  {
    id: 'chocolate-mini-dress',
    name: 'Chocolate Button Mini Dress',
    category: 'Dresses',
    price: 55,
    compareAt: 65,
    badge: 'Studio Pick',
    imageId: 'pavia-look-07',
    image: PAVIA_PRESET_IMAGE('pavia-look-07'),
    description: 'Structured mini dress with a button front, polished collar, and modern chocolate tone.',
    sizes: ['XS', 'S', 'M', 'L'],
    colors: [
      { name: 'Chocolate', hex: '#4b322a' }
    ],
    stock: 10,
    featured: true,
    createdAt: 6
  },
  {
    id: 'beige-trench-coat',
    name: 'Beige Classic Trench Coat',
    category: 'Outerwear',
    price: 89,
    compareAt: 110,
    badge: 'Premium',
    imageId: 'pavia-look-08',
    image: PAVIA_PRESET_IMAGE('pavia-look-08'),
    description: 'A timeless trench silhouette with an elegant belt and soft structured finish.',
    sizes: ['S', 'M', 'L'],
    colors: [
      { name: 'Beige', hex: '#c9a779' }
    ],
    stock: 5,
    featured: true,
    createdAt: 5
  },
  {
    id: 'black-satin-skirt',
    name: 'Black Satin Pleated Skirt',
    category: 'Skirts',
    price: 44,
    compareAt: 0,
    badge: 'Elegant',
    imageId: 'pavia-look-09',
    image: PAVIA_PRESET_IMAGE('pavia-look-09'),
    description: 'Light-catching black satin skirt that moves beautifully from day to evening.',
    sizes: ['S', 'M', 'L', 'XL'],
    colors: [
      { name: 'Black', hex: '#1a1612' }
    ],
    stock: 13,
    featured: false,
    createdAt: 4
  },
  {
    id: 'olive-longline-coat',
    name: 'Olive Longline Coat',
    category: 'Outerwear',
    price: 82,
    compareAt: 0,
    badge: 'New Season',
    imageId: 'pavia-look-10',
    image: PAVIA_PRESET_IMAGE('pavia-look-10'),
    description: 'Longline outerwear in an olive neutral shade with a refined relaxed fit.',
    sizes: ['S', 'M', 'L', 'XL'],
    colors: [
      { name: 'Olive', hex: '#7a7d56' }
    ],
    stock: 7,
    featured: false,
    createdAt: 3
  },
  {
    id: 'mocha-knit-set',
    name: 'Mocha Knit Lounge Set',
    category: 'Sets',
    price: 64,
    compareAt: 72,
    badge: 'Soft Touch',
    imageId: 'pavia-look-01',
    image: PAVIA_PRESET_IMAGE('pavia-look-01'),
    description: 'A cozy polished knit set for errands, travel, and elevated everyday comfort.',
    sizes: ['S', 'M', 'L'],
    colors: [
      { name: 'Mocha', hex: '#7a5443' },
      { name: 'Taupe', hex: '#a78970' }
    ],
    stock: 11,
    featured: false,
    createdAt: 2
  },
  {
    id: 'leather-belted-coat',
    name: 'Black Leather Belted Coat',
    category: 'Outerwear',
    price: 105,
    compareAt: 128,
    badge: 'Statement',
    imageId: 'pavia-look-02',
    image: PAVIA_PRESET_IMAGE('pavia-look-02'),
    description: 'A statement belted coat with a sleek finish and boutique-ready attitude.',
    sizes: ['S', 'M', 'L'],
    colors: [
      { name: 'Black', hex: '#1a1612' }
    ],
    stock: 3,
    featured: true,
    createdAt: 1
  }
];

// Promo codes - these are public so users can find them in source.
// For real promos, validate server-side.
window.PAVIA_PROMO_CODES = {
  'PAVIA10': { type: 'percent', value: 10, label: '10% off' },
  'WELCOME15': { type: 'percent', value: 15, label: '15% off your first order' },
  'FREESHIP': { type: 'freeship', value: 0, label: 'Free delivery' }
};
