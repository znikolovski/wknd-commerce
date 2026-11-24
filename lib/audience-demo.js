const audiences = require('./promotion-authoring-audiences');
const { createStageLiveAudienceProvider } = require('./stage-live-audience');
const { stagePlannerParams, PRODUCTION_NAMESPACE } = require('./stage-planner-release');
const { authoringEnvironment } = require('./promotion-authoring-environment');

function canonicalRestriction(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'environment,key,version'
    && audiences.some((a) => a.env === value.environment && a.key === value.key && a.version === value.version);
}

function demoProvider({ params = {}, store, namespace = process.env.__OW_NAMESPACE, fetchImpl, now } = {}) {
  return createStageLiveAudienceProvider({
    params: stagePlannerParams(params, namespace), store, namespace, fetchImpl, now,
    productionDemo: namespace === PRODUCTION_NAMESPACE,
  });
}

function demoCapability(options) {
  const provider = demoProvider(options);
  const available = provider.configured && provider.environment === authoringEnvironment(options.namespace);
  if (!available) return { blocked: true, reason: 'PROVIDER_NOT_VERIFIED' };
  return {
    blocked: false, reason: null,
    mode: 'target-backed-demo', evidence: false, financialAuthorization: false,
  };
}

module.exports = { canonicalRestriction, demoProvider, demoCapability };
