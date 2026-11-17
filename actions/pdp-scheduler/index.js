/**
 * pdp-scheduler — runs on an alarm (every 15 minutes) and keeps server-rendered PDPs current
 * without manual prerender runs:
 *   - re-renders products whose special price started or ended since the last run;
 *   - once a day, and whenever PDP_PUBLISH changes (e.g. switched on after go-live), re-renders
 *     every PDP (recommendation snapshots, missed events, first publish).
 * Write-driven changes (admin edits, stock, prices, images, orders that sell out) are rendered
 * immediately by the actions that make them.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const { priceWindowChanges } = require('../../lib/pdp-schedule');
const { triggerPrerender } = require('../../lib/invoke');

const STATE_KEY = 'pdp_scheduler';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

async function main(params) {
  const logger = logging('pdp-scheduler', { level: params.LOG_LEVEL || 'info' });
  const fullEveryMs = Number(params.FULL_REFRESH_HOURS || 24) * 3600 * 1000;
  let store;
  try {
    store = await getStore(params);
    const counters = store.collection('counters');
    const state = (await counters.findOne({ key: STATE_KEY }))?.value || {};
    const now = Date.now();
    const since = state.lastRun || now - DEFAULT_INTERVAL_MS;
    const mode = String(params.PDP_PUBLISH ?? 'true') !== 'false' ? 'publish' : 'preview';
    const full = now - (state.lastFull || 0) >= fullEveryMs || state.mode !== mode;
    const cat = await loadCatalog(store);
    const skus = full ? [] : priceWindowChanges(cat, since, now);
    if (full || skus.length) await triggerPrerender(params, skus, { all: full });
    await counters.updateOne(
      { key: STATE_KEY },
      { $set: { value: { lastRun: now, lastFull: full ? now : state.lastFull || 0, mode } } },
      { upsert: true },
    );
    const result = { full, mode, rerendered: full ? 'all' : skus };
    logger.info(JSON.stringify(result));
    return result;
  } catch (e) {
    logger.error(e);
    return { error: e.message };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
