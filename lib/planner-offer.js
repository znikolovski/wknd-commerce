/**
 * Explicit mock-Commerce Stage candidate, independent of disabled authoring draft storage.
 * Catalog tags choose eligible merchandise only; canonical Target decides the audience.
 */
const { validateDraftDefinition } = require('./promotion-drafts');

const PLANNER_ID = 'stage-demo-climbing-planner-v1';
const PLANNER_LABEL = 'Climbing planner gear benefit';

async function plannerCandidate({ provider, customer, catalog }) {
  if (!provider?.configured || !customer?.sub) return null;
  const decision = await provider.resolve({ customer, registryKey: 'climbing-planner' });
  if (decision.status !== 'member') return null;
  const skus = (catalog?.products || []).filter((p) => p.tags?.includes('climbing')).map((p) => p.sku);
  if (!skus.length || skus.length > 100) return null;
  const normalized = validateDraftDefinition({
    name: PLANNER_LABEL, enabled: false, mode: 'automatic',
    discount: { kind: 'percentage', basisPoints: 1000 }, maxDiscountMinor: 2500,
    target: { kind: 'skus', values: skus },
    audienceRestriction: { environment: 'stage', key: 'climbing-planner', version: 1 },
  });
  if (!normalized.ok) return null;
  // Only this Stage-gated runtime conversion enables the normalized terms. No draft is loaded,
  // activated or copied into promotions; the internal decision is not financial AAM evidence.
  return {
    ...normalized.promotion, id: PLANNER_ID, enabled: true,
    audienceRestriction: null, managementClass: 'stage-demo',
  };
}

module.exports = { PLANNER_ID, PLANNER_LABEL, plannerCandidate };
