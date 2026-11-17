/**
 * AEM Assets ⇄ commerce product image linking.
 *
 * Implements the Adobe Commerce "AEM Assets Integration" custom-matcher contract:
 *   asset-to-product: { assetId, eventData.assetMetadata } → { asset_id, product_matches[], skip }
 *   product-to-asset: { productSku }                       → { product_sku, asset_matches[], skip }
 * using the standard metadata (commerce:isCommerce / commerce:skus / commerce:roles /
 * commerce:positions) plus WKND custom rules for assets missing explicit SKUs:
 *   - folder rule: …/products/<category>/<SKU>/<file> links to <SKU>
 *   - colour rule: <SKU>__<colour>__<n>.<ext> links to the colour's variants (+ swatch role)
 * The mock backend then applies the matches to its `asset_links` collection, the way Commerce
 * would populate the product media gallery.
 */
const aem = require('./aem');
const { loadCatalog, bumpCatalogVersion } = require('./catalog');

const DEFAULT_ROLES = ['image', 'small_image', 'thumbnail'];
const KNOWN_ROLES = new Set(['image', 'small_image', 'thumbnail', 'swatch_image', 'hero']);

const truthy = (v) => v === true || ['yes', 'true', 'on', '1'].includes(String(v).toLowerCase());
function asArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(asArray);
  return String(v).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function pathRule(cat, path = '', root = aem.DEFAULT_PRODUCTS_ROOT) {
  if (!path.startsWith(`${root}/`)) return null;
  const segments = path.slice(root.length + 1).split('/');
  const folderSku = segments.slice(0, -1).reverse().map((s) => s.toUpperCase()).find((s) => cat.bySku.has(s));
  const file = segments[segments.length - 1] || '';
  const m = /^([A-Z0-9-]+?)__([a-z0-9-]+)__(\d+)\./i.exec(file);
  const sku = folderSku || (m && cat.bySku.has(m[1].toUpperCase()) ? m[1].toUpperCase() : null);
  if (!sku) return null;
  const product = cat.bySku.get(sku);
  const colour = m ? m[2].toLowerCase() : null;
  const position = m ? Number(m[3]) : null;
  if (colour && (product.options || []).some((o) => o.id === 'color' && o.values.some((v) => v.id === colour))) {
    return {
      skus: product.variants.filter((v) => v.selections.color === colour).map((v) => v.sku),
      parent: sku,
      colour,
      position,
    };
  }
  return { skus: [sku], parent: sku, colour: null, position };
}

/**
 * Pure matcher (no I/O). `asset` = { assetId, assetMetadata, repositoryMetadata }.
 * @returns {{ asset_id: string, product_matches: object[], skip: boolean, unmatched: string[], rule: string }}
 */
function matchAssetToProducts(cat, asset, { root } = {}) {
  const meta = asset.assetMetadata || {};
  const repo = asset.repositoryMetadata || {};
  const base = { asset_id: asset.assetId, product_matches: [], skip: false, unmatched: [] };
  if (!truthy(meta['commerce:isCommerce'])) return { ...base, rule: 'not-eligible' };
  const status = meta['dam:status'] || asset.status;
  if (status && status !== 'approved') return { ...base, rule: 'not-approved' };

  const explicit = asArray(meta['commerce:skus']).map((s) => s.toUpperCase());
  const positions = asArray(meta['commerce:positions']).map(Number);
  const roles = asArray(meta['commerce:roles']).filter((r) => KNOWN_ROLES.has(r) || /^custom_/.test(r));
  let skus = explicit;
  let rule = 'metadata';
  let inferred = null;
  if (!skus.length) {
    inferred = pathRule(cat, repo['repo:path'] || asset.path, root);
    if (!inferred) return { ...base, rule: 'no-sku' };
    skus = inferred.skus;
    rule = inferred.colour ? 'filename-colour' : 'folder';
  }
  const known = skus.filter((s) => cat.bySku.has(s) || cat.byVariantSku.has(s));
  const unmatched = skus.filter((s) => !known.includes(s));
  const product_matches = known.map((sku, i) => {
    const position = Number.isFinite(positions[i]) ? positions[i]
      : (Number.isFinite(positions[0]) ? positions[0] : (inferred?.position || 1));
    let assetRoles = roles.length ? roles : (position <= 1 ? [...DEFAULT_ROLES] : []);
    if (inferred?.colour && position <= 1 && !assetRoles.includes('swatch_image')) assetRoles = [...assetRoles, 'swatch_image'];
    return { product_sku: sku, asset_roles: assetRoles, asset_position: position };
  });
  return {
    ...base, product_matches, unmatched, rule,
  };
}

function isVideo(asset) {
  return /^video\//.test(asset.repositoryMetadata?.['dc:format'] || asset.assetMetadata?.['dc:format'] || '');
}

/** product-to-asset over a candidate asset list (pure). */
function matchProductToAssets(cat, productSku, assets, opts) {
  const sku = String(productSku).toUpperCase();
  const product = cat.bySku.get(sku) || cat.byVariantSku.get(sku)?.parent;
  const family = new Set(product ? [product.sku, ...(product.variants || []).map((v) => v.sku)] : [sku]);
  const asset_matches = [];
  assets.forEach((asset) => {
    const res = matchAssetToProducts(cat, asset, opts);
    const hit = res.product_matches.find((m) => m.product_sku === sku)
      || (sku === product?.sku && res.product_matches.find((m) => family.has(m.product_sku)));
    if (hit) {
      asset_matches.push({
        asset_id: asset.assetId,
        asset_roles: hit.asset_roles,
        asset_format: isVideo(asset) ? 'video' : 'image',
        asset_position: hit.asset_position,
      });
    }
  });
  asset_matches.sort((a, b) => a.asset_position - b.asset_position);
  return { product_sku: sku, asset_matches, skip: false };
}

/* ---------------- applying matches to the mock commerce backend ---------------- */

function linkDoc(params, asset, match, source) {
  const meta = asset.assetMetadata || {};
  const repo = asset.repositoryMetadata || {};
  const name = repo['repo:name'] || asset.name || (asset.path || '').split('/').pop();
  return {
    sku: match.product_sku,
    assetId: asset.assetId,
    path: repo['repo:path'] || asset.path || null,
    name,
    // DM OpenAPI asset base; renditions are derived per use (see catalog.imagesFor / pdp.js)
    url: aem.deliveryBaseFor(params, asset.assetId),
    alias: aem.seoAlias(name),
    roles: match.asset_roles,
    position: match.asset_position,
    label: meta['dc:description'] || meta['dc:title'] || '',
    format: isVideo(asset) ? 'video' : 'image',
    status: 'linked',
    source,
    updatedAt: new Date().toISOString(),
  };
}

async function parentSkus(store, skus) {
  const cat = await loadCatalog(store);
  return [...new Set(skus.map((s) => (cat.bySku.has(s) ? s : cat.byVariantSku.get(s)?.parent.sku)).filter(Boolean))];
}

/** Replace all links for an asset with the matcher result. */
async function applyAssetMatches(store, params, asset, result, source = 'event') {
  const coll = store.collection('asset_links');
  const existing = await coll.find({ assetId: asset.assetId });
  const wanted = new Set(result.product_matches.map((m) => m.product_sku));
  const removed = existing.filter((l) => !wanted.has(l.sku));
  await Promise.all(removed.map((l) => coll.deleteOne({ sku: l.sku, assetId: l.assetId })));
  for (let i = 0; i < result.product_matches.length; i += 1) {
    const m = result.product_matches[i];
    // eslint-disable-next-line no-await-in-loop
    await coll.replaceOne({ sku: m.product_sku, assetId: asset.assetId }, linkDoc(params, asset, m, source), { upsert: true });
  }
  if (removed.length || result.product_matches.length) await bumpCatalogVersion(store);
  return {
    linked: result.product_matches.length,
    removed: removed.length,
    affected: await parentSkus(store, [...wanted, ...removed.map((l) => l.sku)]),
  };
}

async function removeAsset(store, assetId) {
  const coll = store.collection('asset_links');
  const existing = await coll.find({ assetId });
  await coll.deleteMany({ assetId });
  if (existing.length) await bumpCatalogVersion(store);
  return { removed: existing.length, affected: await parentSkus(store, existing.map((l) => l.sku)) };
}

/** Admin "re-run matching": product-to-asset for each SKU against AEM, then apply. */
async function productToAsset(store, params, { skus = [] } = {}) {
  const cat = await loadCatalog(store);
  const results = [];
  const affected = new Set();
  for (let i = 0; i < skus.length; i += 1) {
    const sku = String(skus[i]).toUpperCase();
    // eslint-disable-next-line no-await-in-loop
    const assets = await aem.queryProductAssets(params, { sku });
    const result = matchProductToAssets(cat, sku, assets);
    const matchedIds = new Set(result.asset_matches.map((m) => m.asset_id));
    for (let j = 0; j < assets.length; j += 1) {
      if (matchedIds.has(assets[j].assetId)) {
        // eslint-disable-next-line no-await-in-loop
        const applied = await applyAssetMatches(store, params, assets[j], matchAssetToProducts(cat, assets[j]), 'rematch');
        applied.affected.forEach((s) => affected.add(s));
      }
    }
    results.push({ sku, matched: result.asset_matches.length });
  }
  return { results, affected: [...affected] };
}

/** Nightly drift repair: recompute every product asset under the root. */
async function reconcile(store, params) {
  const cat = await loadCatalog(store);
  const assets = await aem.queryProductAssets(params, { limit: 2000 });
  const seen = new Set();
  const affected = new Set();
  let linked = 0;
  for (let i = 0; i < assets.length; i += 1) {
    seen.add(assets[i].assetId);
    // eslint-disable-next-line no-await-in-loop
    const applied = await applyAssetMatches(store, params, assets[i], matchAssetToProducts(cat, assets[i]), 'reconcile');
    linked += applied.linked;
    applied.affected.forEach((s) => affected.add(s));
  }
  const orphans = (await store.collection('asset_links').find({})).filter((l) => !seen.has(l.assetId));
  for (let i = 0; i < orphans.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await removeAsset(store, orphans[i].assetId);
    res.affected.forEach((s) => affected.add(s));
  }
  return {
    scanned: assets.length, linked, orphansRemoved: orphans.length, affected: [...affected],
  };
}

/* ---------------- admin gallery ---------------- */

async function listLinks(store, { sku } = {}) {
  const filter = sku ? { sku: { $in: await familySkus(store, sku) } } : {};
  const items = await store.collection('asset_links').find(filter);
  return { items: items.sort((a, b) => (a.sku.localeCompare(b.sku)) || ((a.position ?? 99) - (b.position ?? 99))) };
}

async function familySkus(store, sku) {
  const cat = await loadCatalog(store);
  const s = String(sku).toUpperCase();
  const p = cat.bySku.get(s) || cat.allProducts.find((x) => x.sku === s);
  return p ? [p.sku, ...(p.variants || []).map((v) => v.sku)] : [s];
}

async function unlink(store, { sku, assetId }) {
  await store.collection('asset_links').deleteOne({ sku, assetId });
  await bumpCatalogVersion(store);
  return { unlinked: true, note: 'Local override only — update commerce:skus in AEM to make it permanent.', affected: await parentSkus(store, [sku]) };
}

async function reorder(store, { sku, assetIds = [] }) {
  for (let i = 0; i < assetIds.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await store.collection('asset_links').updateOne({ sku, assetId: assetIds[i] }, { $set: { position: i + 1 } });
  }
  await bumpCatalogVersion(store);
  return { reordered: assetIds.length, affected: await parentSkus(store, [sku]) };
}

module.exports = {
  matchAssetToProducts,
  matchProductToAssets,
  applyAssetMatches,
  removeAsset,
  productToAsset,
  reconcile,
  listLinks,
  unlink,
  reorder,
  asArray,
  truthy,
};
