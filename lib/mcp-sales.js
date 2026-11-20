const { bumpCatalogVersion, sellableSkus } = require('./catalog');
const { McpToolError, inCategory } = require('./mcp-reads');

async function prepareSale(store, args) {
  const products = store.collection('products');
  const [all, count] = await Promise.all([products.find({}, { batchSize: 1000 }), products.countDocuments({})]);
  if (all.length !== count) throw new McpToolError('INCOMPLETE_CATALOG', 'A complete catalog is required for sale changes.');
  const requested = args.sku ? [args.sku] : args.selection.skus;
  const category = args.selection?.category;
  const selected = all.filter((p) => (requested
    ? requested.some((sku) => p.sku === sku || sellableSkus(p).includes(sku))
    : inCategory(p, category)));
  if (category) {
    const categories = await store.collection('categories').find({ urlPath: category });
    if (categories.length !== 1) throw new McpToolError('CATEGORY_NOT_FOUND', 'Category not found.');
  }
  if (!selected.length || (requested && requested.some((s) => !selected.some((p) => p.sku === s || sellableSkus(p).includes(s))))) {
    throw new McpToolError('PRODUCT_NOT_FOUND', 'One or more selected products were not found.');
  }
  if (selected.length > 100) throw new McpToolError('SELECTION_TOO_LARGE', 'Select at most 100 parent products.');
  const targets = new Map();
  for (const p of selected) {
    const skus = [p.sku, ...sellableSkus(p).filter((s) => s !== p.sku)];
    for (const sku of skus) {
      if (typeof sku !== 'string' || !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(sku)) {
        throw new McpToolError('INVALID_CATALOG_SKU', 'A selected catalog SKU is invalid.');
      }
      if (!requested || requested.includes(p.sku) || requested.includes(sku)) targets.set(sku, p.sku);
    }
  }
  if (targets.size > 1000) throw new McpToolError('SELECTION_TOO_LARGE', 'Select at most 1000 price records.');
  const prices = await store.collection('prices').find({ sku: { $in: [...targets.keys()] } }, { batchSize: 1000 });
  if (prices.length !== targets.size || new Set(prices.map((p) => p.sku)).size !== targets.size) {
    throw new McpToolError('PRICE_NOT_FOUND', 'Each selected SKU must have exactly one existing price.');
  }
  return prices.sort((a, b) => a.sku.localeCompare(b.sku)).map((p) => {
    const regularMinor = Math.round(p.regular * 100);
    if (typeof p.regular !== 'number' || p.currency !== 'AUD' || !Number.isSafeInteger(regularMinor) || regularMinor < 0
      || regularMinor > 100000000 || Math.abs(p.regular * 100 - regularMinor) > 0.000001) {
      throw new McpToolError('INVALID_CATALOG_PRICE', 'An existing AUD price is invalid.');
    }
    const specialMinor = args.clear ? null : (args.amountMinor ?? Math.round(regularMinor * (100 - args.percent) / 100));
    if (specialMinor !== null && specialMinor > regularMinor) {
      throw new McpToolError('INVALID_SALE_PRICE', 'Sale prices cannot exceed regular prices.');
    }
    return {
      sku: p.sku, parentSku: targets.get(p.sku), regular: p.regular,
      currency: p.currency, specialMinor,
      startsAt: args.startsAt ?? null, endsAt: args.endsAt ?? null,
    };
  });
}

async function changeSale(store, args, { actor, correlationId, prerender, logger }) {
  const changes = await prepareSale(store, args);
  const items = changes.map((c) => ({ sku: c.sku, status: 'not-attempted' }));
  const affected = new Set();
  const warnings = [];
  for (let i = 0; i < changes.length; i += 1) {
    const c = changes[i];
    try {
      const update = c.specialMinor === null
        ? { $unset: { special: '', specialFrom: '', specialTo: '' } }
        : { $set: { special: c.specialMinor / 100, specialFrom: c.startsAt, specialTo: c.endsAt } };
      // Price predicates prevent overwriting a concurrently changed regular price.
      // eslint-disable-next-line no-await-in-loop
      const result = await store.collection('prices').updateOne({ sku: c.sku, regular: c.regular, currency: c.currency }, update);
      if (result?.matchedCount === 0) {
        items[i].status = 'conflict';
        break;
      }
      if (result?.matchedCount !== 1) {
        items[i].status = 'unknown';
        affected.add(c.parentSku);
        logger.error('mcp.sale.write-outcome-unknown', { correlationId });
        break;
      }
      items[i].status = 'updated';
      affected.add(c.parentSku);
    } catch {
      items[i].status = 'unknown';
      affected.add(c.parentSku);
      logger.error('mcp.sale.write-outcome-unknown', { correlationId });
      break;
    }
  }
  if (affected.size) {
    try {
      await bumpCatalogVersion(store);
    } catch {
      warnings.push({ code: 'CATALOG_INVALIDATION_FAILED', message: 'Catalog invalidation needs operator repair.' });
      logger.error('mcp.sale.catalog-invalidation-failed', { correlationId });
    }
    try {
      const result = await prerender([...affected].sort());
      if (result?.skipped) {
        warnings.push({ code: 'PRERENDER_SKIPPED', message: 'PDP rendering was not submitted; operator follow-up is required.' });
        logger.warn('mcp.sale.prerender-skipped', { correlationId });
      }
    } catch {
      warnings.push({ code: 'PRERENDER_FAILED', message: 'PDP rendering needs operator repair.' });
      logger.error('mcp.sale.prerender-failed', { correlationId });
    }
  }
  const ok = items.every((i) => i.status === 'updated');
  const committed = items.some((i) => i.status === 'unknown') ? null : items.some((i) => i.status === 'updated');
  try {
    await store.collection('events').insertOne({
      type: 'mcp.sale-price', createdAt: new Date().toISOString(),
      actor, correlationId, committed,
      changes: changes.map((c, i) => ({
        sku: c.sku, specialMinor: c.specialMinor, startsAt: c.startsAt, endsAt: c.endsAt, status: items[i].status,
      })),
    });
  } catch {
    warnings.push({ code: 'SALE_AUDIT_FAILED', message: 'Sale-change audit needs operator repair.' });
    logger.error('mcp.sale.audit-failed', { correlationId });
  }
  return {
    ok, committed, correlationId, items, affected: [...affected].sort(), warnings,
    ...(!ok ? {
      error: {
        code: committed === null ? 'SALE_OUTCOME_UNKNOWN' : 'SALE_WRITE_CONFLICT',
        message: 'Inspect the listed price records before issuing another sale change.',
        retryable: false,
      },
    } : {}),
  };
}

module.exports = { changeSale };
