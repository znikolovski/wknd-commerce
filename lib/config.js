/**
 * Store configuration for the mock "WKND Adventures" Commerce store view.
 * Prices are authored GST-inclusive (Australian convention); GST is 1/11th of the gross.
 */

const CURRENCY = 'AUD';
const GST_RATE = 0.1;
const FREE_SHIPPING_THRESHOLD = 150;

const STORE = {
  id: 1,
  code: 'wknd_au',
  website_code: 'wknd',
  store_group_code: 'wknd_store',
  store_name: 'WKND Adventures Shop',
  locale: 'en_AU',
  timezone: 'Australia/Sydney',
  base_currency_code: CURRENCY,
  default_display_currency_code: CURRENCY,
  base_url: 'https://wknd-adventures.run.place/',
  secure_base_url: 'https://wknd-adventures.run.place/',
  default_country: 'AU',
  countries_with_required_region: 'AU,US,CA',
  optional_zip_countries: 'HK,IE,MO',
  display_state_if_optional: true,
  product_url_suffix: '',
  category_url_suffix: '',
  weight_unit: 'kgs',
};

const PAYMENT_METHOD = {
  code: 'wknd_demo_pay',
  title: 'WKND Demo Pay — demonstration only, no payment is taken',
  is_deferred: false,
  oope_payment_method_config: null,
};

const SHIPPING_METHODS = [
  {
    carrier_code: 'wknd', carrier_title: 'WKND Shipping', method_code: 'standard', method_title: 'Standard (3–6 business days)', price: 9.95, domestic: true,
  },
  {
    carrier_code: 'wknd', carrier_title: 'WKND Shipping', method_code: 'express', method_title: 'Express (1–2 business days)', price: 19.95, domestic: true,
  },
  {
    carrier_code: 'wknd', carrier_title: 'WKND Shipping', method_code: 'international', method_title: 'International tracked (7–14 business days)', price: 34.95, domestic: false,
  },
];

const COUPONS = {
  WKND10: { label: 'WKND10 — 10% off gear', percent: 10 },
  TRAILREADY: { label: 'TRAILREADY — $20 off orders over $200', amount: 20, minSubtotal: 200 },
};

const REGIONS = {
  AU: [
    ['ACT', 'Australian Capital Territory'], ['NSW', 'New South Wales'], ['NT', 'Northern Territory'],
    ['QLD', 'Queensland'], ['SA', 'South Australia'], ['TAS', 'Tasmania'], ['VIC', 'Victoria'],
    ['WA', 'Western Australia'],
  ],
  NZ: [['AUK', 'Auckland'], ['CAN', 'Canterbury'], ['OTA', 'Otago'], ['WGN', 'Wellington']],
  US: [['CA', 'California'], ['CO', 'Colorado'], ['NY', 'New York'], ['UT', 'Utah'], ['WA', 'Washington']],
  CA: [['AB', 'Alberta'], ['BC', 'British Columbia'], ['ON', 'Ontario'], ['QC', 'Quebec']],
};

const COUNTRIES = [
  ['AU', 'Australia'], ['NZ', 'New Zealand'], ['US', 'United States'], ['CA', 'Canada'],
  ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['JP', 'Japan'], ['SG', 'Singapore'],
];

let regionSeq = 0;
const REGION_IDS = {};
Object.entries(REGIONS).forEach(([country, list]) => {
  list.forEach(([code]) => {
    regionSeq += 1;
    REGION_IDS[`${country}:${code}`] = regionSeq;
  });
});

function getCountries() {
  return COUNTRIES.map(([id, name]) => ({
    id,
    two_letter_abbreviation: id,
    three_letter_abbreviation: id,
    full_name_locale: name,
    full_name_english: name,
    available_regions: (REGIONS[id] || []).map(([code, rname]) => ({
      id: REGION_IDS[`${id}:${code}`], code, name: rname,
    })),
  }));
}

function findRegion(countryCode, { regionId, regionCode, region } = {}) {
  const list = REGIONS[countryCode] || [];
  const match = list.find(([code, name]) => (regionId && REGION_IDS[`${countryCode}:${code}`] === Number(regionId))
    || (regionCode && code === regionCode) || (region && (name === region || code === region)));
  if (!match) return { region_id: null, code: regionCode || null, label: region || regionCode || null };
  return { region_id: REGION_IDS[`${countryCode}:${match[0]}`], code: match[0], label: match[1] };
}

const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (value) => ({ value: round(value || 0), currency: CURRENCY });
const gstPortion = (gross) => round(gross - gross / (1 + GST_RATE));

/** Matches reference Commerce attributesForm metadata, localised for Australia. */
function addressFormItems() {
  const text = (code, label, sortOrder, required, extra = {}) => ({
    code,
    label,
    sort_order: sortOrder,
    is_required: required,
    frontend_input: 'TEXT',
    entity_type: 'CUSTOMER_ADDRESS',
    multiline_count: 0,
    is_unique: false,
    default_value: null,
    frontend_class: null,
    options: [],
    validate_rules: required ? [{ name: 'MAX_TEXT_LENGTH', value: '255' }, { name: 'MIN_TEXT_LENGTH', value: '1' }] : [],
    ...extra,
  });
  return [
    text('firstname', 'First Name', 20, true),
    text('lastname', 'Last Name', 40, true),
    text('company', 'Company', 60, false),
    text('street', 'Street Address', 70, true, { frontend_input: 'MULTILINE', multiline_count: 2 }),
    text('country_id', 'Country', 80, true, { frontend_input: 'SELECT', default_value: 'AU', validate_rules: [] }),
    text('region', 'State/Territory', 90, false),
    text('region_id', 'State/Territory', 90, false, { frontend_input: 'HIDDEN' }),
    text('city', 'Suburb/City', 100, true),
    text('postcode', 'Postcode', 110, true, { validate_rules: [] }),
    text('telephone', 'Phone Number', 120, true),
  ].map((item) => ({ __typename: 'CustomerAttributeMetadata', ...item }));
}

function customerFormItems() {
  return [
    ['firstname', 'First Name', 40], ['lastname', 'Last Name', 60], ['email', 'Email', 80],
  ].map(([code, label, sortOrder]) => ({
    __typename: 'CustomerAttributeMetadata',
    code,
    label,
    sort_order: sortOrder,
    is_required: true,
    is_unique: false,
    frontend_input: 'TEXT',
    entity_type: 'CUSTOMER',
    multiline_count: 0,
    default_value: null,
    frontend_class: null,
    options: [],
    validate_rules: code === 'email'
      ? [{ name: 'INPUT_VALIDATION', value: 'email' }]
      : [{ name: 'MAX_TEXT_LENGTH', value: '255' }, { name: 'MIN_TEXT_LENGTH', value: '1' }],
  }));
}

function storeConfig() {
  return {
    ...STORE,
    store_code: STORE.code,
    store_group_name: STORE.store_name,
    website_name: 'WKND Adventures',
    base_link_url: STORE.base_url,
    secure_base_link_url: STORE.secure_base_url,
    minicart_display: true,
    minicart_max_items: 10,
    cart_expires_in_days: 30,
    cart_summary_display_quantity: 1,
    max_items_in_order_summary: 10,
    category_fixed_product_tax_display_setting: 'INCLUDE_FPT_WITHOUT_DETAILS',
    product_fixed_product_tax_display_setting: 'INCLUDE_FPT_WITHOUT_DETAILS',
    sales_fixed_product_tax_display_setting: 'INCLUDE_FPT_WITHOUT_DETAILS',
    shopping_cart_display_full_summary: true,
    shopping_cart_display_grand_total: true,
    shopping_cart_display_price: 2,
    shopping_cart_display_shipping: 2,
    shopping_cart_display_subtotal: 2,
    shopping_cart_display_tax_gift_wrapping: 'DISPLAY_INCLUDING_TAX',
    shopping_cart_display_zero_tax: false,
    configurable_thumbnail_source: 'itself',
    allow_gift_wrapping_on_order: '0',
    allow_gift_wrapping_on_order_items: '0',
    allow_order: '0',
    allow_items: '0',
    allow_gift_receipt: '0',
    allow_printed_card: '0',
    printed_card_priceV2: money(0),
    cart_gift_wrapping: 'DISPLAY_INCLUDING_TAX',
    cart_printed_card: 'DISPLAY_INCLUDING_TAX',
    is_checkout_agreements_enabled: false,
    is_guest_checkout_enabled: true,
    is_one_page_checkout_enabled: true,
    autocomplete_on_storefront: true,
    customer_access_token_lifetime: 1,
    create_account_confirmation: false,
    is_default_store: true,
    is_default_store_group: true,
    grid_per_page: 12,
    list_per_page: 12,
    order_cancellation_enabled: false,
    returns_enabled: 'no',
  };
}

module.exports = {
  CURRENCY,
  GST_RATE,
  FREE_SHIPPING_THRESHOLD,
  STORE,
  PAYMENT_METHOD,
  SHIPPING_METHODS,
  COUPONS,
  getCountries,
  findRegion,
  round,
  money,
  gstPortion,
  addressFormItems,
  customerFormItems,
  storeConfig,
};
