/**
 * Explicit mock-Commerce Stage candidate, independent of disabled authoring draft storage.
 * Catalog tags choose eligible merchandise only; canonical Target decides the audience.
 */
const { validateDefinition } = require('./promotion-schema');

const PLANNER_ID = 'stage-demo-climbing-planner-v1';
const PLANNER_LABEL = 'Climbing planner gear benefit';

async function plannerCandidate({ provider, customer, catalog }) {
  if (!provider?.configured || !customer?.sub) return null;
  const decision = await provider.resolve({ customer, registryKey: 'climbing-planner' });
  if (decision.status !== 'member') return null;
  const skus = (catalog?.products || []).filter((p) => p.tags?.includes('climbing')).map((p) => p.sku);
  if (!skus.length || skus.length > 100) return null;
  const normalized = validateDefinition({
    name: PLANNER_LABEL, enabled: false, mode: 'automatic',
    discount: { kind: 'percentage', basisPoints: 1000 }, maxDiscountMinor: 2500,
    target: { kind: 'skus', values: skus },
    audienceRestriction: null,
  }, 'create');
  if (normalized.fields.length) return null;
  // Only the explicit release-gated mock runtime enables these ordinary normalized terms.
  // No restricted draft is loaded or activated; Target is not financial AAM evidence.
  return {
    ...normalized.definition,
    id: provider.environment === 'production' ? 'production-demo-climbing-planner-v1' : PLANNER_ID,
    enabled: true, audienceRestriction: null,
    managementClass: provider.environment === 'production' ? 'production-demo' : 'stage-demo',
  };
}

module.exports = { PLANNER_ID, PLANNER_LABEL, plannerCandidate };
