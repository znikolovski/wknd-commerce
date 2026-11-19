const { createHash } = require('node:crypto');
const aem = require('./aem');
const { AdminError } = require('./admin');
const { loadCatalog } = require('./catalog');
const linking = require('./linking');

const FIELDS = ['commerce:isCommerce', 'commerce:skus', 'commerce:roles', 'commerce:positions'];
const ROLES = ['image', 'small_image', 'thumbnail', 'swatch_image', 'hero'];
const encodedPath = (path) => path.split('/').map(encodeURIComponent).join('/');
const revision = (metadata) => createHash('sha256')
  .update(JSON.stringify(FIELDS.map((key) => metadata[key] ?? null))).digest('hex');

function assetPath(params, path) {
  const root = params.AEM_PRODUCTS_ROOT || aem.DEFAULT_PRODUCTS_ROOT;
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith(`${root}/`)
    || /[\\?#%;]/.test(path)
    || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || path.slice(1).split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new AdminError(`Select an asset beneath ${root}.`);
  }
  return path;
}

async function readAsset(params, path) {
  const safePath = assetPath(params, path);
  let data;
  try {
    const response = await aem.aemFetch(params, `${encodedPath(safePath)}.2.json`, { redirect: 'error' });
    data = await response.json();
  } catch (error) {
    const status = [401, 403, 404].includes(error.status) ? error.status : 502;
    throw new AdminError(`AEM could not read this asset (HTTP ${status}). Check your asset permissions.`, status);
  }
  const metadata = data?.['jcr:content']?.metadata;
  if (data?.['jcr:primaryType'] !== 'dam:Asset' || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data['jcr:uuid'] || '')) {
    throw new AdminError('AEM returned an asset without readable metadata or identity.', 502);
  }
  return {
    assetId: aem.urnFromUuid(data['jcr:uuid']),
    path: safePath,
    name: safePath.split('/').pop(),
    assetMetadata: metadata,
    repositoryMetadata: { 'repo:path': safePath, 'repo:name': safePath.split('/').pop() },
  };
}

async function getAsset(store, params, args) {
  const asset = await readAsset(params, args.assetPath);
  const metadata = asset.assetMetadata;
  const links = await store.collection('asset_links').find({ assetId: asset.assetId });
  return {
    assetId: asset.assetId, name: asset.name, path: asset.path,
    revision: revision(metadata),
    isCommerce: linking.truthy(metadata['commerce:isCommerce']),
    skus: linking.asArray(metadata['commerce:skus']),
    roles: linking.asArray(metadata['commerce:roles']),
    positions: linking.asArray(metadata['commerce:positions']),
    approval: metadata['dam:status'] || null,
    links: links.map(({ sku, position, roles }) => ({ sku, position, roles })),
  };
}

async function searchProducts(store, { q = '' } = {}) {
  if (typeof q !== 'string' || q.length > 200) throw new AdminError('Search must be at most 200 characters.');
  const cat = await loadCatalog(store);
  const needle = q.trim().toLowerCase();
  const items = cat.allProducts.flatMap((product) => [
    { sku: product.sku, name: product.name, type: product.type },
    ...(product.variants || []).map((variant) => ({
      sku: variant.sku, name: `${product.name} - ${Object.values(variant.selections || {}).join(' / ')}`,
      type: 'variant', parentSku: product.sku,
    })),
  ]).filter((product) => `${product.sku} ${product.name}`.toLowerCase().includes(needle));
  return { items: items.slice(0, 50), total: items.length };
}

function valuesFor(cat, input) {
  if (typeof input.isCommerce !== 'boolean') throw new AdminError('Commerce eligibility must be true or false.');
  if (!Array.isArray(input.skus) || input.skus.length > 100
    || input.skus.some((sku) => typeof sku !== 'string')) throw new AdminError('Select up to 100 product SKUs.');
  const skus = input.skus.map((sku) => sku.trim().toUpperCase());
  if (new Set(skus).size !== skus.length) throw new AdminError('Product SKUs must be unique.');
  const unknown = skus.filter((sku) => !cat.bySku.has(sku) && !cat.byVariantSku.has(sku));
  if (unknown.length) throw new AdminError(`Unknown product SKUs: ${unknown.join(', ')}.`);
  if (input.isCommerce && !skus.length) throw new AdminError('Select at least one product, or disable commerce use to unlink this asset.');
  if (!Array.isArray(input.roles) || input.roles.length > 20
    || new Set(input.roles).size !== input.roles.length
    || input.roles.some((role) => typeof role !== 'string' || (!ROLES.includes(role) && !/^custom_[a-z0-9_-]{1,60}$/i.test(role)))) {
    throw new AdminError('Select valid, unique image roles.');
  }
  if (!Array.isArray(input.positions) || input.positions.length !== skus.length
    || input.positions.some((position) => !Number.isInteger(position) || position < 1 || position > 9999)) {
    throw new AdminError('Provide a whole-number position from 1 to 9999 for each selected SKU.');
  }
  return {
    'commerce:isCommerce': input.isCommerce ? 'yes' : 'no',
    'commerce:skus': skus,
    'commerce:roles': input.roles,
    'commerce:positions': input.positions.map(String),
  };
}

function metadataForm(values) {
  const fields = ['_charset_=utf-8'];
  const append = (key, value) => fields.push(`${key}=${encodeURIComponent(String(value))}`);
  Object.entries(values).forEach(([key, value]) => {
    const property = `./jcr:content/metadata/${key}`;
    if (Array.isArray(value)) {
      append(`${property}@Delete`, '');
      if (value.length) {
        append(`${property}@TypeHint`, 'String[]');
        value.forEach((item) => append(property, item));
      }
    } else {
      append(`${property}@TypeHint`, 'String');
      append(property, value);
    }
  });
  return fields.join('&');
}

async function saveAsset(store, params, args) {
  const cat = await loadCatalog(store);
  const values = valuesFor(cat, args);
  const asset = await readAsset(params, args.assetPath);
  if (typeof args.revision !== 'string' || args.revision !== revision(asset.assetMetadata)) {
    throw new AdminError('Commerce metadata changed. Reload the asset before saving.', 409);
  }
  // This author does not expose metadata PATCH; use the same Sling POST contract as image ingestion.
  try {
    await aem.aemFetch(params, encodedPath(asset.path), {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: metadataForm(values),
    });
  } catch (error) {
    const status = [401, 403, 409].includes(error.status) ? error.status : 502;
    throw new AdminError(`AEM did not confirm the commerce metadata save (HTTP ${status}). Reload before retrying.`, status);
  }
  let saved;
  try {
    saved = await readAsset(params, asset.path);
    if (saved.assetId !== asset.assetId || FIELDS.some((key) => {
      const actual = saved.assetMetadata[key] ?? (Array.isArray(values[key]) ? [] : null);
      return JSON.stringify(actual) !== JSON.stringify(values[key]);
    })) {
      throw new Error('Metadata read-back differs from the requested values.');
    }
  } catch {
    throw new AdminError('AEM accepted the save but metadata could not be verified. Reload before retrying; commerce links were not updated.', 502);
  }
  let applied;
  try {
    applied = await linking.applyAssetMatches(store, params, saved,
      linking.matchAssetToProducts(cat, saved, { root: params.AEM_PRODUCTS_ROOT }), 'assets-panel', { catalog: cat });
  } catch {
    throw new AdminError('AEM metadata was saved, but commerce synchronisation failed. Reload and save again to retry.', 502);
  }
  return {
    ...(await getAsset(store, params, { assetPath: asset.path })),
    affected: applied.affected,
    warning: saved.assetMetadata['dam:status'] && saved.assetMetadata['dam:status'] !== 'approved'
      ? 'Metadata saved. The asset is not approved, so it is not linked for storefront delivery.' : null,
  };
}

module.exports = { getAsset, saveAsset, searchProducts, metadataForm, valuesFor };
