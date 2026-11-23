const {
  stagePlannerParams, STAGE_NAMESPACE, productionDemoEnabled, stageFactsEnabled, stageWindowEnabled,
} = require('../lib/stage-planner-release');
const { createStageLiveAudienceProvider } = require('../lib/stage-live-audience');
const { loadPromotionRuntime } = require('../lib/promotions');
const { createMemoryStore } = require('../lib/store');

const parameters = {
  TARGET_DIAG_ENVIRONMENT: 'stage', TARGET_DIAG_STAGE_NAMESPACE: STAGE_NAMESPACE,
  TARGET_DIAG_ENABLED: 'true', TARGET_DIAG_SHOPPER_KEYS: 'a'.repeat(64),
};
const release = { enabled: true, parameters };
const legacy = {
  RECOVERY_REDEMPTION_VERIFIED: 'untouched-original', PROMOTION_SELECTION: 'explicit-first',
  AUTH0_ISSUER: 'original-issuer', __ims_oauth_s2s: { client_secret: 'offline-original' },
};

test('ordinary builds stay OFF; request fields cannot supply the lexical release opt-in', () => {
  const request = { ...legacy, WKND_STAGE_PLANNER_RELEASE: release };
  expect(stagePlannerParams(request, STAGE_NAMESPACE)).toBe(request);
  expect(stagePlannerParams(legacy, STAGE_NAMESPACE, { enabled: false })).toBe(legacy);
});

test('Production requires a separate explicit approved release and exact platform namespace', () => {
  const production = { enabled: true, productionDemo: true, parameters: {
    TARGET_DIAG_ENVIRONMENT: 'production', TARGET_DIAG_PRODUCTION_NAMESPACE: '28538-wkndcommerce',
    TARGET_DIAG_TARGET_CONFIG_APPROVED: 'true',
  } };
  expect(productionDemoEnabled('28538-wkndcommerce', production)).toBe(true);
  expect(productionDemoEnabled('28538-wkndcommerce', release)).toBe(false);
  expect(productionDemoEnabled(STAGE_NAMESPACE, production)).toBe(false);
  expect(productionDemoEnabled('28538-wkndcommerce', { ...production, productionDemo: false })).toBe(false);
  expect(stagePlannerParams(legacy, '28538-wkndcommerce', production)).toMatchObject(legacy);
  expect(stagePlannerParams(legacy, '28538-wkndcommerce', production)).not.toHaveProperty('STAGE_AAM_GENERAL_OFFERS_ENABLED');
  expect(stageFactsEnabled('28538-wkndcommerce', production)).toBe(false);
  const facts = { ...production, factsOnly: true, cartWindow: true };
  expect(stageFactsEnabled('28538-wkndcommerce', facts)).toBe(true);
  expect(stageWindowEnabled('28538-wkndcommerce', facts)).toBe(false);
});

test.each(['28538-wkndcommerce', 'another-stage', undefined])('approved release cannot enable %s', (namespace) => {
  expect(stagePlannerParams(legacy, namespace, release)).toBe(legacy);
  const provider = createStageLiveAudienceProvider({
    params: { ...parameters, TARGET_DIAG_STAGE_NAMESPACE: namespace, STAGE_AAM_GENERAL_OFFERS_ENABLED: 'true' },
    namespace,
  });
  expect(provider.configured).toBe(false);
});

test('exact Stage release overlays Target settings only and preserves legacy inputs and credentials', () => {
  const enabled = stagePlannerParams(legacy, STAGE_NAMESPACE, {
    ...release, parameters: { ...parameters, PROMOTION_SELECTION: 'best-saving', RECOVERY_REDEMPTION_VERIFIED: 'true',
      AUTH0_ISSUER: 'replacement', __ims_oauth_s2s: { client_secret: 'replacement' } },
  });
  expect(enabled.STAGE_AAM_GENERAL_OFFERS_ENABLED).toBe('true');
  expect(enabled.TARGET_DIAG_SHOPPER_KEYS).toBe(parameters.TARGET_DIAG_SHOPPER_KEYS);
  Object.keys(legacy).forEach((key) => expect(enabled[key]).toBe(legacy[key]));
  expect(legacy).not.toHaveProperty('STAGE_AAM_GENERAL_OFFERS_ENABLED');
  expect(stagePlannerParams(legacy, STAGE_NAMESPACE, {
    ...release, parameters: { ...parameters, TARGET_DIAG_ENVIRONMENT: 'production' },
  })).toBe(legacy);
});

test('enabled provider without a planner candidate preserves legacy selection precedence', async () => {
  const runtime = await loadPromotionRuntime(createMemoryStore(), {
    params: legacy, plannerProvider: { configured: true, stageContext: true },
  });
  expect(runtime.planner).toBeNull();
  expect(runtime.selection).toBe('explicit-first');
});
