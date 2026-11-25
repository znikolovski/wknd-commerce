const { quoteFields } = require('./bundles');
const { computeTotals, cartVersion } = require('./cart');
const { money } = require('./config');

/** Read-only projections; the same cart evaluator must select this kit after completion. */
function bundleOffers(cat, cart, runtime) {
  const offers = [];
  for (const p of runtime.definitions) {
    if (!p.enabled || p.mode !== 'automatic' || p.target.kind !== 'bundle'
      || !runtime.trust(p).ok || quoteFields(cat, p.target, runtime.nowMs).length) continue;
    const projected = { ...cart, items: cart.items.map((i) => ({ ...i })) };
    const components = p.target.components.map((c, index) => {
      const cartQuantity = cart.items.filter((i) => i.sku === c.sku).reduce((n, i) => n + i.quantity, 0);
      const missing = Math.max(0, c.quantity - cartQuantity);
      const hit = cat.byVariantSku.get(c.sku);
      const parent = hit?.parent || cat.bySku.get(c.sku);
      if (missing) projected.items.push({
        uid: `bundle-completion-${index}`, sku: c.sku, parentSku: parent.sku, quantity: missing,
      });
      return {
        sku: c.sku, name: parent.name, required_quantity: c.quantity, cart_quantity: cartQuantity,
        missing_quantity: missing, unit_price: money(c.unitPriceMinor / 100),
      };
    });
    if (!components.some((c) => c.cart_quantity > 0) || !components.some((c) => c.missing_quantity > 0)) continue;
    const totals = computeTotals(cat, projected, runtime);
    if (totals.promotion.error || totals.promotion.selected?.id !== p.id || totals.discountTotal <= 0) continue;
    offers.push({
      promotion_id: p.id, bundle_id: p.target.bundleId, cart_version: cartVersion(cart), name: p.name,
      quote_expires_at: p.target.quoteExpiresAt, saving: money(totals.discountTotal), components,
    });
  }
  return offers;
}

module.exports = { bundleOffers };
