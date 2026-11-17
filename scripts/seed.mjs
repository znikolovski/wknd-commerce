#!/usr/bin/env node
/**
 * Seeds the deployed catalog through the IMS-protected admin action.
 * Uses the Adobe I/O CLI user token (`aio login`) and the workspace in .aio.
 *
 *   node scripts/seed.mjs [--replace] [--keep-inventory] [--url=<admin action url>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Za-z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const namespace = env.AIO_runtime_namespace || env.AIO_RUNTIME_NAMESPACE;
const url = args.url || `https://${namespace}.adobeioruntime.net/api/v1/web/commerce-admin/admin`;
const token = execSync('aio config get ims.contexts.cli.access_token.token', { encoding: 'utf8' }).trim();
if (!token) throw new Error('Run `aio login` first');

async function call(op, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'x-gw-ims-org-id': env.WKND_ADMIN_IMS_ORG, 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${op} → ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8'));
const CHUNK = 20;
const skusOf = (p) => [p.sku, ...p.variants.map((v) => v.sku)];
for (let i = 0; i < catalog.products.length; i += CHUNK) {
  const products = catalog.products.slice(i, i + CHUNK);
  const skus = new Set(products.flatMap(skusOf));
  const part = {
    categories: i === 0 ? catalog.categories : [],
    products,
    prices: catalog.prices.filter((p) => skus.has(p.sku)),
    inventory: catalog.inventory.filter((p) => skus.has(p.sku)),
  };
  // eslint-disable-next-line no-await-in-loop
  const res = await call('catalog.import', { catalog: part, replace: Boolean(args.replace) && i === 0, keepInventory: Boolean(args['keep-inventory']) });
  console.log(`chunk ${i / CHUNK + 1}:`, res);
}
console.log('stats:', await call('stats.get', {}));
