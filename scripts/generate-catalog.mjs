#!/usr/bin/env node
/**
 * Expands data/catalog-source.mjs into data/catalog.json (deterministic):
 *   { categories[], products[], prices[], inventory[] }
 * Usage: node scripts/generate-catalog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES, PRODUCTS, OPTION_SETS,
} from '../data/catalog-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// mulberry32 — deterministic pseudo-random
let seed = 20261117;
function rand() {
  seed += 0x6D2B79F5;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const CAT_CODES = {
  'apparel/jackets': 'JKT',
  'apparel/base-layers': 'BSE',
  'apparel/pants': 'PNT',
  'apparel/tees': 'TEE',
  'apparel/headwear': 'HDW',
  'apparel/gloves': 'GLV',
  'apparel/socks': 'SCK',
  'accessories/packs': 'PCK',
  'accessories/duffels': 'DFL',
  'accessories/packing': 'ORG',
  'accessories/hydration': 'HYD',
  'accessories/lighting': 'LGT',
  'accessories/travel-tech': 'TRV',
};
const SIZE_PREMIUM = { capacity: { '40l': 0, '70l': 40, '100l': 80 } };

function description(name, attrs, features) {
  const lead = `The ${name} is WKND-designed ${attrs.activity ? attrs.activity.toLowerCase() : 'adventure'} gear, tested by our guides on real expeditions.`;
  const list = features.map((f) => `<li>${f}</li>`).join('');
  const specs = [
    attrs.material && `<strong>Material:</strong> ${attrs.material}`,
    attrs.weight_g && `<strong>Weight:</strong> ${attrs.weight_g} g`,
    attrs.capacity_l && `<strong>Capacity:</strong> ${attrs.capacity_l} L`,
    attrs.waterproof_rating && `<strong>Waterproofing:</strong> ${attrs.waterproof_rating}`,
  ].filter(Boolean).join('<br>');
  return `<p>${lead}</p><ul>${list}</ul>${specs ? `<p>${specs}</p>` : ''}<p>Every WKND product carries our 3-year Trail Promise warranty.</p>`;
}

function cartesian(options) {
  return options.reduce((acc, opt) => acc.flatMap((sel) => opt.values.map((v) => ({ ...sel, [opt.id]: v.id }))), [{}]);
}

const counters = {};
const created = new Date('2026-09-01T00:00:00Z').getTime();
const products = [];
const prices = [];
const inventory = [];

PRODUCTS.forEach(([name, category, price, tags, attrs, optionsKey, extra = {}], index) => {
  const code = CAT_CODES[category];
  counters[code] = (counters[code] || 0) + 1;
  const sku = `WKND-${code}-${String(counters[code]).padStart(3, '0')}`;
  const options = optionsKey ? structuredClone(OPTION_SETS[optionsKey]) : [];
  const urlKey = slug(name);
  const features = extra.features || [];
  const attributes = { brand: 'WKND', ...attrs, warranty: '3-year Trail Promise' };
  const product = {
    sku,
    type: options.length ? 'configurable' : 'simple',
    name,
    urlKey,
    status: 'enabled',
    visibility: 'Catalog, Search',
    position: index + 1,
    featured: Boolean(extra.featured),
    categories: [category],
    tags,
    attributes,
    shortDescription: features[0] ? `${features[0]}.` : '',
    description: description(name, attrs, features),
    metaTitle: `${name} | WKND Adventures Shop`,
    metaDescription: `${name} — ${features.slice(0, 2).join('. ')}. Free standard shipping in Australia over $150.`,
    metaKeyword: [...tags.slice(0, 4), attrs.activity].filter(Boolean).join(', '),
    options,
    variants: [],
    createdAt: new Date(created + index * 3600_000 * 7).toISOString(),
    updatedAt: new Date(created + index * 3600_000 * 7).toISOString(),
  };

  if (options.length) {
    cartesian(options).forEach((selections) => {
      const suffix = options.map((o) => selections[o.id].toUpperCase().slice(0, 4)).join('-');
      const vsku = `${sku}-${suffix}`;
      product.variants.push({ sku: vsku, selections });
      const premium = selections.capacity ? SIZE_PREMIUM.capacity[selections.capacity] || 0 : 0;
      prices.push({ sku: vsku, regular: price + premium, currency: 'AUD' });
      const r = rand();
      inventory.push({ sku: vsku, qty: r < 0.06 ? 0 : (r < 0.15 ? 2 : Math.round(5 + rand() * 40)), lowStockThreshold: 3 });
    });
  } else {
    inventory.push({ sku, qty: Math.round(10 + rand() * 80), lowStockThreshold: 5 });
  }
  const parentPrice = { sku, regular: price, currency: 'AUD' };
  // ~15% of products on sale for the demo
  if (rand() < 0.15) {
    parentPrice.special = Math.round(price * 0.8) - 0.05;
    parentPrice.specialFrom = '2026-11-01T00:00:00Z';
    parentPrice.specialTo = '2027-01-31T23:59:59Z';
    prices.filter((p) => p.sku.startsWith(`${sku}-`)).forEach((p) => {
      p.special = Math.round(p.regular * 0.8) - 0.05;
      p.specialFrom = parentPrice.specialFrom;
      p.specialTo = parentPrice.specialTo;
    });
  }
  prices.push(parentPrice);
  products.push(product);
});

const out = {
  generatedAt: new Date().toISOString(), categories: CATEGORIES, products, prices, inventory,
};
fs.writeFileSync(path.join(root, 'data/catalog.json'), `${JSON.stringify(out, null, 1)}\n`);
const variants = products.reduce((n, p) => n + p.variants.length, 0);
console.log(`catalog.json: ${products.length} products, ${variants} variants, ${prices.length} prices, ${inventory.length} stock records`);
