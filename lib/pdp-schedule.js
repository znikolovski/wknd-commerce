/**
 * Time-based PDP changes that no write event announces: special prices (discounts) that start
 * or end on a schedule. The pdp-scheduler action re-renders those PDPs as their windows change.
 */

/**
 * Parent SKUs whose special-price window opened or closed in (since, now].
 * @param {object} cat catalog snapshot
 * @param {number} since epoch ms (exclusive)
 * @param {number} now epoch ms (inclusive)
 * @returns {string[]}
 */
function priceWindowChanges(cat, since, now) {
  const parents = new Set();
  cat.priceBySku.forEach((price, sku) => {
    if (price?.special == null) return;
    const edges = [price.specialFrom, price.specialTo].filter(Boolean).map((d) => Date.parse(d));
    if (!edges.some((t) => t > since && t <= now)) return;
    const parent = cat.bySku.get(sku) || cat.byVariantSku.get(sku)?.parent;
    if (parent) parents.add(parent.sku);
  });
  return [...parents];
}

module.exports = { priceWindowChanges };
