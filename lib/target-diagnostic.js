/**
 * Stage-only Adobe Target diagnostic for the AAM pilot audiences (OFFLINE PREPARATION — no action,
 * manifest entry or deployment yet). See docs/TARGET-AAM-DIAGNOSTIC.md.
 *
 * Asks Target (remote decisioning, Delivery API) which experience of the isolated diagnostic activity
 * a verified shopper falls into, and reports only an inert marker. A Target decision is NOT audience
 * evidence: no complete:true, source timestamps, merge rule, version or TTL claims; "control" or no
 * decision never means not-qualified. Never read by promotions, cart pricing or shopper-audiences.
 *
 * Trust: the customer ID is always the Auth0-verified `sub`; the ECID, DCS location hint and AAM blob
 * come only from a server-side binding provider. Caller-supplied identity, location, property, mbox or
 * offer values are never read. Without a trusted binding the result is `unavailable`.
 */
const crypto = require('node:crypto');
const { shopperKey } = require('./recovery-policy');

const REQUEST_SCHEMA = 'wknd.target-aam-diagnostic/v1';
const RESULT_SCHEMA = 'wknd.target-aam-diagnostic-result/v1';
const MBOX = 'wknd-aam-stage-eligibility-v1';
const MARKERS = Object.freeze(['climbing-planner', 'climbing-interest', 'control']);
const INTEGRATION_CODE = 'wkndCustomerId';
const OFFER_KEYS = ['environment', 'financialAuthorization', 'marker', 'schema'];
const DEFAULT_TIMEOUT_MS = 2000;

const ECID = /^\d{38}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_CODE = /^[a-z0-9]{1,64}$/i;

/** Default provider: no supported trusted ECID issuance is verified yet, so nothing resolves. */
const unavailableBindingProvider = Object.freeze({ resolve: async () => null });

function base(extra = {}) {
  return {
    schema: RESULT_SCHEMA,
    environment: 'stage',
    evidence: false,
    financialAuthorization: false,
    ...extra,
  };
}
const unavailable = (reason, extra = {}) => base({ status: 'unavailable', reason, ...extra });

/**
 * Server configuration only. Refuses anything but an explicitly enabled Stage namespace.
 * @returns {{ ok: true, config: object } | { ok: false, reason: string }}
 */
function diagnosticConfig(params = {}) {
  if (params.TARGET_DIAG_ENABLED !== 'true') return { ok: false, reason: 'disabled' };
  const namespace = params.__OW_NAMESPACE || process.env.__OW_NAMESPACE || '';
  if (params.TARGET_DIAG_ENVIRONMENT !== 'stage' || !namespace.endsWith('-stage')) {
    return { ok: false, reason: 'not-stage' };
  }
  const clientCode = params.TARGET_CLIENT_CODE;
  const propertyToken = params.TARGET_PROPERTY_TOKEN;
  const allowlist = String(params.TARGET_DIAG_SHOPPER_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!CLIENT_CODE.test(clientCode || '') || !UUID.test(propertyToken || '') || !allowlist.length) {
    return { ok: false, reason: 'not-configured' };
  }
  return {
    ok: true,
    config: {
      clientCode, propertyToken, allowlist, endpoint: `https://${clientCode}.tt.omtrdc.net/rest/v1/delivery`,
    },
  };
}

/** Validates a server-issued binding; any defect makes the whole binding unusable. */
function validBinding(binding) {
  if (!binding || typeof binding !== 'object' || binding.source !== 'server-issued') return null;
  const { ecid, locationHint, blob } = binding;
  if (!ECID.test(String(ecid || '')) || !Number.isInteger(locationHint) || locationHint < 1
    || typeof blob !== 'string' || !blob || Buffer.byteLength(blob, 'utf8') > 1024) return null;
  return { ecid: String(ecid), locationHint, blob };
}

/** Builds the Delivery API request. `customerId` is the verified sub; nothing comes from the caller. */
function buildDeliveryRequest({
  config, binding, customerId, requestId, sessionId,
}) {
  return {
    url: `${config.endpoint}?client=${encodeURIComponent(config.clientCode)}&sessionId=${encodeURIComponent(sessionId)}`,
    body: {
      requestId,
      context: { channel: 'web' },
      property: { token: config.propertyToken },
      id: {
        marketingCloudVisitorId: binding.ecid,
        customerIds: [{ id: customerId, integrationCode: INTEGRATION_CODE, authenticatedState: 'authenticated' }],
      },
      experienceCloud: { audienceManager: { locationHint: binding.locationHint, blob: binding.blob } },
      execute: { mboxes: [{ index: 0, name: MBOX }] },
    },
  };
}

function isDiagnosticOffer(content) {
  return Boolean(content) && typeof content === 'object' && !Array.isArray(content)
    && Object.keys(content).sort().join() === OFFER_KEYS.join()
    && content.schema === REQUEST_SCHEMA && content.environment === 'stage'
    && content.financialAuthorization === false && MARKERS.includes(content.marker);
}

/** Exactly one well-formed JSON diagnostic offer for the diagnostic mbox, or unavailable. */
function parseDecision(body) {
  const mboxes = (body?.execute?.mboxes || []).filter((m) => m?.name === MBOX);
  if (mboxes.length !== 1) return { status: 'unavailable', reason: 'no-decision' };
  const options = mboxes[0].options || [];
  if (options.length === 0) return { status: 'unavailable', reason: 'no-decision' };
  if (options.length > 1) return { status: 'unavailable', reason: 'ambiguous-decision' };
  const [option] = options;
  if (option?.type !== 'json' || !isDiagnosticOffer(option.content)) {
    return { status: 'unavailable', reason: 'unexpected-offer' };
  }
  return { status: 'decided', marker: option.content.marker };
}

/**
 * @param {object} input
 * @param {{ sub: string }} input.claims Auth0-verified claims (caller must have verified the token)
 * @param {object} input.params server action params (configuration)
 * @param {{ resolve: Function }} [input.bindingProvider] server-side trusted ECID binding
 * @param {Function} [input.fetchImpl]
 * @returns {Promise<object>} result with marker or unavailable reason; never identifiers
 */
async function runTargetDiagnostic({
  claims, params = {}, bindingProvider = unavailableBindingProvider, fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS, randomUUID = crypto.randomUUID, now = Date.now,
}) {
  const configured = diagnosticConfig(params);
  if (!configured.ok) return unavailable(configured.reason);
  const { config } = configured;
  const sub = claims?.sub;
  if (typeof sub !== 'string' || !sub.trim() || sub.length > 256 || !params.AUTH0_ISSUER) {
    return unavailable('unauthenticated');
  }
  const key = shopperKey(params.AUTH0_ISSUER, sub);
  if (!config.allowlist.includes(key)) return unavailable('not-allowlisted');

  let binding;
  try {
    binding = validBinding(await bindingProvider.resolve({ shopperKey: key, sub }));
  } catch {
    binding = null;
  }
  if (!binding) return unavailable('no-trusted-binding');

  const requestId = randomUUID();
  const request = buildDeliveryRequest({
    config, binding, customerId: sub, requestId, sessionId: randomUUID(),
  });
  const started = now();
  try {
    const res = await fetchImpl(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = now() - started;
    if (!res.ok) return unavailable('target-error', { requestId, latencyMs });
    const decision = parseDecision(await res.json());
    return base({ ...decision, requestId, latencyMs });
  } catch {
    return unavailable('target-unreachable', { requestId, latencyMs: now() - started });
  }
}

module.exports = {
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  MBOX,
  MARKERS,
  INTEGRATION_CODE,
  unavailableBindingProvider,
  diagnosticConfig,
  buildDeliveryRequest,
  parseDecision,
  runTargetDiagnostic,
};
