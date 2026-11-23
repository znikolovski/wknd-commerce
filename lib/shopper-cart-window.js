const { createServerCartFacts, CartFactsError } = require('./server-cart-facts');
const { canonicalJson, sha256 } = require('./promotion-schema');

const HOUR_MS = 60 * 60 * 1000;
const MAX_IDLE_MS = 7 * 24 * HOUR_MS;
const SCHEMA = 'wknd.shopper-cart-window/v1';

/**
 * Audience-source time-window facts only; does not import the 24-hour financial recovery policy.
 * The complete owner cart set and each cart's complete owner order read are rechecked.
 */
function createShopperCartWindow({ store, claims, clock = Date.now }) {
  const facts = createServerCartFacts({ store, claims, environment: 'stage', clock });
  const cartsFor = () => store.collection('carts').find({ customerSub: claims.sub });
  const snapshot = (carts) => canonicalJson(carts.map((cart) => ({
    id: cart.id, state: cart.status, revision: cart.revision, activityAt: cart.activityAt,
    updatedAt: cart.updatedAt, createdAt: cart.createdAt, items: cart.items,
  })).sort((a, b) => a.id.localeCompare(b.id)));
  return {
    async read() {
      const start = await cartsFor();
      const orderSignature = sha256(canonicalJson(await store.collection('orders').find({ customerSub: claims.sub })));
      const now = clock();
      let candidates = 0;
      let unknown = false;
      const episodes = [];
      /* eslint-disable no-await-in-loop */
      for (const cart of start) {
        if (['merged', 'ordered'].includes(cart.status)) continue;
        if (cart.status !== 'active') { unknown = true; continue; }
        let packet;
        try { packet = await facts.read(cart.id); } catch { unknown = true; continue; }
        if (packet.cart.itemCount === 0) continue;
        if (!Number.isInteger(packet.cart.itemCount) || packet.cart.itemCount < 1
          || !Number.isInteger(packet.cart.totalQuantity) || packet.cart.totalQuantity < 1) {
          unknown = true;
          continue;
        }
        const activity = Date.parse(packet.cart.lastActivityAt);
        if (!Number.isFinite(activity) || activity > now) { unknown = true; continue; }
        const idle = now - activity;
        if (idle < HOUR_MS || idle > MAX_IDLE_MS) continue;
        if (packet.purchase.sinceLastActivity === 'unknown') { unknown = true; continue; }
        if (packet.purchase.sinceLastActivity === 'recorded') continue;
        if (packet.purchase.sinceLastActivity !== 'not-recorded') { unknown = true; continue; }
        candidates += 1;
        episodes.push(packet.episode.key);
      }
      /* eslint-enable no-await-in-loop */
      if (snapshot(await cartsFor()) !== snapshot(start)) {
        throw new CartFactsError('CART_CHANGED', 'Shopper cart set changed during observation.');
      }
      // A stable second read is a freshness check, not a transaction/completeness watermark.
      if (sha256(canonicalJson(await store.collection('orders').find({ customerSub: claims.sub }))) !== orderSignature) {
        throw new CartFactsError('FACT_CHANGED', 'Shopper orders changed during observation.');
      }
      return Object.freeze({
        schema: SCHEMA, environment: 'stage', observedAt: new Date(now).toISOString(),
        window: candidates ? 'within-window' : unknown ? 'unknown' : 'outside-window',
        candidateCartCount: unknown && !candidates ? null : candidates,
        episodeSet: sha256(canonicalJson(episodes.sort())),
      });
    },
  };
}

function mapShopperCartWindow(packet) {
  if (packet?.schema !== SCHEMA || packet.environment !== 'stage') {
    throw new CartFactsError('FACT_SCOPE', 'Shopper fact scope is unavailable.');
  }
  return {
    c_wknd_stage_shopper_cart_window: packet.window,
    c_wknd_stage_shopper_cart_observed_at: packet.observedAt,
    ...(packet.candidateCartCount === null ? {} : { c_wknd_stage_shopper_cart_count: String(packet.candidateCartCount) }),
    c_wknd_stage_shopper_cart_episode_set: packet.episodeSet,
  };
}

module.exports = { createShopperCartWindow, mapShopperCartWindow, HOUR_MS, MAX_IDLE_MS };
