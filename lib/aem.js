/**
 * Minimal AEM as a Cloud Service client for the linking actions (S2S OAuth via
 * include-ims-credentials; the credential must be allowlisted in the program's api.yaml).
 */
const DEFAULT_PRODUCTS_ROOT = '/content/dam/wknd-adventures/products';

let tokenCache = { value: null, exp: 0 };

async function aemHeaders(params) {
  if (params.AEM_ACCESS_TOKEN) {
    return { Authorization: `Bearer ${params.AEM_ACCESS_TOKEN}`, ...(params.AEM_API_KEY ? { 'x-api-key': params.AEM_API_KEY } : {}) };
  }
  if (!tokenCache.value || Date.now() > tokenCache.exp) {
    // eslint-disable-next-line global-require
    const { generateAccessToken } = require('@adobe/aio-lib-core-auth');
    const t = await generateAccessToken(params);
    tokenCache = { value: t.access_token, exp: Date.now() + 20 * 60 * 1000 };
  }
  const clientId = params.__ims_oauth_s2s?.client_id || params.AEM_API_KEY;
  return { Authorization: `Bearer ${tokenCache.value}`, ...(clientId ? { 'x-api-key': clientId } : {}) };
}

const authorUrl = (params) => String(params.AEM_AUTHOR_URL || '').replace(/\/$/, '');
const deliveryUrl = (params) => authorUrl(params).replace('://author-', '://delivery-');

async function aemFetch(params, path, init = {}) {
  const res = await fetch(`${authorUrl(params)}${path}`, {
    ...init,
    headers: { ...(await aemHeaders(params)), ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeout || 15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`AEM ${init.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const urnFromUuid = (uuid) => (uuid && !String(uuid).startsWith('urn:') ? `urn:aaid:aem:${uuid}` : uuid);

function findUrn(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node.match(/urn:aaid:aem:[0-9a-f-]{36}/i)?.[0] || null;
  if (typeof node !== 'object') return null;
  if (node['repo:assetId']) return node['repo:assetId'];
  for (const v of Object.values(node)) {
    const hit = findUrn(v);
    if (hit) return hit;
  }
  return null;
}

/** @returns {{ assetMetadata: object, repositoryMetadata: object }} */
async function getAssetMetadata(params, assetId) {
  const res = await aemFetch(params, `/adobe/assets/${encodeURIComponent(assetId)}/metadata`);
  const body = await res.json();
  return {
    assetMetadata: body.assetMetadata || {},
    repositoryMetadata: body.repositoryMetadata || {},
    etag: res.headers.get('etag'),
  };
}

/** JSON-Patch commerce metadata (used by the Assets View panel and the upload script). */
async function patchAssetMetadata(params, assetId, values) {
  const { etag } = await getAssetMetadata(params, assetId);
  const patch = Object.entries(values).map(([k, v]) => (v == null
    ? { op: 'remove', path: `/${k}` }
    : { op: 'add', path: `/${k}`, value: v }));
  await aemFetch(params, `/adobe/assets/${encodeURIComponent(assetId)}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json', ...(etag ? { 'If-Match': etag } : {}) },
    body: JSON.stringify(patch),
  });
}

/**
 * QueryBuilder search for commerce-eligible product assets.
 * @param {{ sku?: string, root?: string, limit?: number }} q
 */
async function queryProductAssets(params, { sku, root, limit = 500 } = {}) {
  const qs = new URLSearchParams({
    path: root || params.AEM_PRODUCTS_ROOT || DEFAULT_PRODUCTS_ROOT,
    type: 'dam:Asset',
    'p.limit': String(limit),
    'p.hits': 'full',
    'p.nodedepth': '2',
    orderby: 'path',
  });
  if (sku) {
    qs.set('group.p.or', 'true');
    qs.set('group.1_property', 'jcr:content/metadata/commerce:skus');
    qs.set('group.1_property.value', sku);
    qs.set('group.2_path', `${root || params.AEM_PRODUCTS_ROOT || DEFAULT_PRODUCTS_ROOT}`);
    qs.set('group.2_nodename', `${sku}*`);
  }
  const res = await aemFetch(params, `/bin/querybuilder.json?${qs}`, { timeout: 25000 });
  const body = await res.json();
  return (body.hits || []).map((hit) => {
    const meta = hit['jcr:content']?.metadata || {};
    return {
      assetId: urnFromUuid(hit['jcr:uuid']),
      path: hit['jcr:path'],
      name: hit['jcr:path']?.split('/').pop(),
      assetMetadata: meta,
      repositoryMetadata: { 'repo:path': hit['jcr:path'], 'repo:name': hit['jcr:path']?.split('/').pop(), 'dc:format': meta['dc:format'] },
      status: meta['dam:status'] || hit['jcr:content']?.['dam:status'],
    };
  });
}

function imageFormat(name = '', format = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'webp', 'gif'].includes(ext)) return ext;
  if (/png/.test(format)) return 'png';
  return 'jpg';
}

const seoAlias = (name) => String(name || 'product').replace(/\.[^.]+$/, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'product';

/**
 * Dynamic Media with OpenAPI asset base (`https://delivery-…/adobe/assets/{urn}`).
 * This is what Commerce exposes for AEM Assets images: the storefront drop-ins (with
 * `commerce-assets-enabled`) append `/as/{alias}.{format}?width=…&quality=…` per slot.
 */
function deliveryBaseFor(params, assetId) {
  return `${deliveryUrl(params)}/adobe/assets/${assetId}`;
}

/** A concrete optimised DM OpenAPI rendition (for JSON-LD, og:image, admin thumbnails). */
function renditionUrl(base, alias, { width = 1200, quality = 80, format = 'jpg' } = {}) {
  if (!/\/adobe\/assets\/urn:aaid:aem:/.test(base || '')) return base;
  const root = base.replace(/\/as\/.*$/, '').replace(/[?#].*$/, '');
  return `${root}/as/${encodeURIComponent(alias || 'product')}.${format}?${new URLSearchParams({ width, quality })}`;
}

module.exports = {
  DEFAULT_PRODUCTS_ROOT,
  aemHeaders,
  aemFetch,
  findUrn,
  urnFromUuid,
  getAssetMetadata,
  patchAssetMetadata,
  queryProductAssets,
  deliveryBaseFor,
  renditionUrl,
  seoAlias,
  imageFormat,
};
