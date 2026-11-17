#!/usr/bin/env node
/**
 * Generates mesh.json for the current workspace (.env namespace) — the API Mesh that fronts
 * the mock Commerce backend exactly like an Adobe Commerce storefront mesh would:
 * one merged Core + Catalog Service schema, header forwarding for customer tokens and store
 * context, CORS for the storefront origins and response caching driven by the source's
 * Cache-Control (catalog reads are cacheable, cart/checkout/customer are no-store).
 *
 *   node scripts/build-mesh.mjs && aio api-mesh create mesh.json   (or: update)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Za-z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const namespace = env.AIO_runtime_namespace || env.AIO_RUNTIME_NAMESPACE;
const origins = (env.WKND_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const forwarded = ['authorization', 'store', 'magento-store-code', 'magento-store-view-code', 'magento-website-code', 'magento-environment-id', 'magento-customer-group', 'x-api-key'];

const mesh = {
  meshConfig: {
    sources: [
      {
        name: 'WkndCommerce',
        handler: {
          graphql: {
            endpoint: `https://${namespace}.adobeioruntime.net/api/v1/web/commerce/storefront-graphql`,
            // Static SDL: the merged schema's introspection exceeds I/O Runtime's 1 MB response limit.
            source: './storefront.graphql',
            operationHeaders: Object.fromEntries(forwarded.map((h) => [h, `{context.headers['${h}']}`])),
          },
        },
      },
    ],
    files: [
      { path: './storefront.graphql', content: fs.readFileSync(path.join(root, 'schema/storefront.graphql'), 'utf8') },
    ],
    responseConfig: {
      CORS: {
        origin: origins,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', ...forwarded.map((h) => h.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase()))],
        credentials: false,
        maxAge: 600,
      },
      cache: true,
      includeHTTPDetails: false,
    },
  },
};

fs.writeFileSync(path.join(root, 'mesh.json'), `${JSON.stringify(mesh, null, 2)}\n`);
console.log(`mesh.json → source ${mesh.meshConfig.sources[0].handler.graphql.endpoint}`);
