/**
 * Stage-only mock-Commerce audience decision adapter. Target markers are demo inputs, never
 * verified financial membership evidence. The caller supplies the server-owned registry mapping.
 */
const { serverConfig, baseGate, decideGate } = require('./target-diagnostic-action');
const { createBindingStore } = require('./target-binding-store');
const { createIdLinkageConsentSource } = require('./id-linkage-consent');
const {
  createIdServiceBindingProvider, DEFAULT_TIMEOUT_MS, DEFAULT_LEASE_MS,
} = require('./target-id-binding');
const { runTargetDiagnostic } = require('./target-diagnostic');
const { STAGE_NAMESPACE, PRODUCTION_NAMESPACE } = require('./stage-planner-release');

const MARKERS = ['climbing-planner', 'climbing-interest'];
const REGISTRY_KEYS = Object.freeze(Object.fromEntries(MARKERS.map((marker) => [marker, marker])));
const result = (fields) => ({
  source: 'target-aam-decision', evidence: false, financialAuthorization: false, ...fields,
});
const unknown = (reason, marker = null) => result({
  status: 'unknown', registryKey: null, marker, reason,
});
const configuredInt = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

function createStageLiveAudienceProvider({
  params = {}, store, registryKeysByMarker = REGISTRY_KEYS, fetchImpl = fetch, now = Date.now,
  namespace = process.env.__OW_NAMESPACE,
  productionDemo = false,
} = {}) {
  const config = serverConfig(params, namespace);
  const stageContext = namespace === STAGE_NAMESPACE || namespace === PRODUCTION_NAMESPACE;
  const stageEnabled = params.STAGE_AAM_GENERAL_OFFERS_ENABLED === 'true'
    && namespace === STAGE_NAMESPACE && config.TARGET_DIAG_ENVIRONMENT === 'stage'
    && config.TARGET_DIAG_STAGE_NAMESPACE === namespace;
  const productionEnabled = productionDemo === true && namespace === PRODUCTION_NAMESPACE
    && config.TARGET_DIAG_ENVIRONMENT === 'production'
    && config.TARGET_DIAG_PRODUCTION_NAMESPACE === namespace
    && config.TARGET_DIAG_TARGET_CONFIG_APPROVED === 'true';
  const configured = (stageEnabled || productionEnabled) && !baseGate(config) && !decideGate(config)
    && MARKERS.every((marker) => typeof registryKeysByMarker[marker] === 'string' && registryKeysByMarker[marker])
    && registryKeysByMarker[MARKERS[0]] !== registryKeysByMarker[MARKERS[1]];
  const decisions = new Map();

  async function decide(customer) {
    const binding = createBindingStore(store);
    // A verified delegated read can reuse an existing binding, but cannot claim/mint/relink it.
    const bindingStore = customer.delegated ? {
      get: binding.get, put: async () => null, remove: async () => false,
    } : binding;
    const provider = createIdServiceBindingProvider({
      orgId: config.TARGET_ID_ORG_ID, dpid: config.TARGET_ID_DPID,
      consent: createIdLinkageConsentSource(store, { issuer: config.AUTH0_ISSUER }),
      store: bindingStore, fetchImpl, now,
      timeoutMs: configuredInt(config.TARGET_ID_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      leaseMs: configuredInt(config.TARGET_ID_LEASE_MS, DEFAULT_LEASE_MS),
    });
    return runTargetDiagnostic({
      claims: { sub: customer.sub }, params: config, bindingProvider: provider, fetchImpl, now,
      timeoutMs: configuredInt(config.TARGET_DIAG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    });
  }

  return {
    configured,
    stageContext,
    environment: config.TARGET_DIAG_ENVIRONMENT,
    async resolve({ customer, registryKey } = {}) {
      if (!configured) return unknown('stage-demo-disabled');
      if (!customer?.sub) return unknown('unauthenticated');
      if (!MARKERS.some((marker) => registryKeysByMarker[marker] === registryKey)) return unknown('unsupported-registry-key');
      try {
        // The adapter is constructed per request; never persist decisions as audience evidence.
        const key = `${customer.delegated ? 'delegated' : 'direct'}:${customer.sub}`;
        if (!decisions.has(key)) decisions.set(key, decide(customer));
        const decision = await decisions.get(key);
        if (decision.status !== 'decided') return unknown(decision.reason || 'unavailable');
        if (decision.marker === 'control') return unknown('control', decision.marker);
        if (registryKeysByMarker[decision.marker] !== registryKey) return unknown('no-qualified-marker', decision.marker);
        return result({ status: 'member', registryKey, marker: decision.marker });
      } catch {
        return unknown('unavailable');
      }
    },
  };
}

module.exports = { createStageLiveAudienceProvider };
