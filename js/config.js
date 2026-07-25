window.PAVIA_CONFIG = {
  version: '0.7.7', // bump +0.0.1 each release; after x.x.9 roll to x.(x+1).0 (e.g. 0.0.9 -> 0.1.0)
  siteName: 'Pavia',
  siteTitle: 'Pavia Lebanon',
  location: 'Beirut',
  deliveryArea: 'Lebanon',
  tagline: 'Modern elegant fashion',
  description: "Pavia is modern, elegant fashion from Beirut — soft, easy-to-wear pieces for women, delivered to your door anywhere in Lebanon.",
  // Single contact number. Phone == WhatsApp; the storefront derives the tel:
  // link, the wa.me digits, and the display string from this one value.
  phone: '03 017 725',
  // Store the Instagram handle only; the profile URL is derived from it.
  instagramHandle: '@pavia.leb',
  // Flat universal delivery fee (USD); editable in the admin Settings tab.
  deliveryFee: 3,
  // Optional storefront content (all editable in the admin Settings tab). Blank
  // values keep the built-in defaults, so the storefront is unchanged until set.
  heroHeadline: '',          // blank keeps the styled built-in headline
  announcementText: '',
  announcementEnabled: false,
  addressLine: '',
  businessHours: '',
  // Default "Get directions" target — the real Beirut store location.
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=33.8787650,35.4968680'
};
