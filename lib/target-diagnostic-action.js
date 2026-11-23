/**
 * Environment-bound, allowlisted, authenticated Target AAM diagnostic + ID-linkage consent endpoint
 * (actions/target-diagnostic). DISABLED BY DEFAULT: every gate below is server configuration (manifest
 * inputs, `final`, raw web action, so callers cannot set or override them) and is checked before any
 * store, ID Service or Target call.
 *
 *   POST { op:'consent-status' }                              → { status:'ok', consent }
 *   POST { op:'consent', optIn, wordingVersion?, source? }    → { status:'ok', consent, changed }
 *   POST { op:'decide' }                                      → inert diagnostic result (lib/target-diagnostic)
 *
 * Gate order (fail closed, nothing touched on refusal):
 * 1. TARGET_DIAG_ENABLED, configured environment and verified exact Runtime namespace, Auth0 + allowlist.
 * 2. Not a delegated agent request; a valid Auth0 RS256 access token (lib/auth.js verifyToken).
 * 3. shopperKey(AUTH0_ISSUER, sub) is allowlisted; the body has only known fields.
 * 4. Grants: TARGET_ID_LINKAGE_ENABLED and an approved wording version.
 *    Decide: linkage enabled, TARGET_ID_BINDING_STORE_APPROVED, TARGET_ID_SERVICE_ENABLED, org, DPID,
 *    bounded lease/timeouts and Target client/property configuration.
 * Responses and logs carry fixed categories only: no tokens, subs, shopper keys, ECIDs or blobs.
 * The result is never read by promotions, cart, orders or shopper-audiences (no financial use).
 */
const { bearer, verifyToken } = require('./auth');
const { shopperKey } = require('./recovery-policy');
const { diagnosticConfig, runTargetDiagnostic } = require('./target-diagnostic');
const {
  createIdServiceBindingProvider, DEFAULT_LEASE_MS, DEFAULT_TIMEOUT_MS, TIMEOUT_BOUNDS, LEASE_BOUNDS,
} = require('./target-id-binding');
const { createBindingStore } = require('./target-binding-store');
const { PARTNER, createIdRetirementService } = require('./target-id-retirement');
const { ENVIRONMENTS, environmentGate } = require('./target-environment');
const {
  IdLinkageError, linkageConfig, setIdLinkageConsent, createIdLinkageConsentSource,
} = require('./id-linkage-consent');

/** The only parameters the handler reads; everything else (incl. __ow_*) is request data. */
const CONFIG_KEYS = Object.freeze([
  'LOG_LEVEL', 'AUTH0_ISSUER', 'AUTH0_AUDIENCE',
  'TARGET_DIAG_ENABLED', 'TARGET_DIAG_ENVIRONMENT', 'TARGET_DIAG_ALLOWED_ORIGINS', 'TARGET_DIAG_SHOPPER_KEYS',
  'TARGET_DIAG_STAGE_NAMESPACE', 'TARGET_DIAG_PRODUCTION_NAMESPACE', 'TARGET_DIAG_TARGET_CONFIG_APPROVED',
  'TARGET_CLIENT_CODE', 'TARGET_PROPERTY_TOKEN', 'TARGET_DIAG_TIMEOUT_MS',
  'TARGET_ID_LINKAGE_ENABLED', 'TARGET_ID_LINKAGE_WORDING_VERSIONS', 'TARGET_ID_BINDING_STORE_APPROVED',
  'TARGET_ID_SERVICE_ENABLED', 'TARGET_ID_ORG_ID', 'TARGET_ID_DPID', 'TARGET_ID_LEASE_MS', 'TARGET_ID_TIMEOUT_MS',
  'TARGET_ID_RETIREMENT_ENABLED',
  // Runtime-injected credentials for App Builder Database Storage (include-ims-credentials).
  '__ims_oauth_s2s', '__ims_env', 'DB_REGION',
]);
const BODY_KEYS = Object.freeze({
  'consent-status': [],
  consent: ['optIn', 'wordingVersion', 'source'],
  decide: [],
  retirement: ['step'],
});
const ORG_ID = /^[0-9A-F]{24}@AdobeOrg$/;
const DPID = /^\d{1,10}$/;
const MAX_BODY_BYTES = 4096;
const LINKAGE_ERROR_STATUS = Object.freeze({
  SIGN_IN_REQUIRED: [401, 'unauthenticated'],
  DIRECT_SIGN_IN_REQUIRED: [403, 'delegated-not-allowed'],
  INVALID: [400, 'invalid-request'],
  DISABLED: [403, 'linkage-disabled'],
  WORDING_NOT_APPROVED: [403, 'wording-not-approved'],
  NO_CUSTOMER: [404, 'no-customer'],
  CONFLICT: [409, 'conflict'],
  EVIDENCE_FAILED: [503, 'evidence-failed'],
  ACTIVATION_PENDING: [503, 'activation-pending'],
});

function serverConfig(params, namespace) {
  const config = Object.fromEntries(CONFIG_KEYS.filter((k) => params[k] !== undefined).map((k) => [k, params[k]]));
  config.__OW_NAMESPACE = namespace || '';
  return config;
}

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function baseGate(config) {
  if (config.TARGET_DIAG_ENABLED !== 'true') return 'disabled';
  const environmentError = environmentGate(config, config.__OW_NAMESPACE);
  if (environmentError) return environmentError;
  if (!config.AUTH0_ISSUER || !config.AUTH0_AUDIENCE || !csv(config.TARGET_DIAG_SHOPPER_KEYS).length) return 'not-configured';
  return null;
}

/** Bounded integer config: empty means the documented default; anything else must be in range. */
function boundedInt(raw, fallback, [lo, hi]) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,6}$/.test(String(raw))) return NaN;
  const n = Number(raw);
  return n >= lo && n <= hi ? n : NaN;
}

/** First unapproved live gate for `decide`, by name (never values), or null. */
function decideGate(config) {
  if (!linkageConfig(config).enabled) return 'TARGET_ID_LINKAGE_ENABLED';
  if (!linkageConfig(config).wordingVersions.length) return 'TARGET_ID_LINKAGE_WORDING_VERSIONS';
  if (config.TARGET_DIAG_ENVIRONMENT === 'production' && config.TARGET_DIAG_TARGET_CONFIG_APPROVED !== 'true') {
    return 'TARGET_DIAG_TARGET_CONFIG_APPROVED';
  }
  if (config.TARGET_ID_BINDING_STORE_APPROVED !== 'true') return 'TARGET_ID_BINDING_STORE_APPROVED';
  if (config.TARGET_ID_SERVICE_ENABLED !== 'true') return 'TARGET_ID_SERVICE_ENABLED';
  if (!ORG_ID.test(config.TARGET_ID_ORG_ID || '')) return 'TARGET_ID_ORG_ID';
  if (!DPID.test(config.TARGET_ID_DPID || '')) return 'TARGET_ID_DPID';
  const timeoutMs = boundedInt(config.TARGET_ID_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, TIMEOUT_BOUNDS);
  const leaseMs = boundedInt(config.TARGET_ID_LEASE_MS, DEFAULT_LEASE_MS, LEASE_BOUNDS);
  if (Number.isNaN(timeoutMs)) return 'TARGET_ID_TIMEOUT_MS';
  if (Number.isNaN(leaseMs) || leaseMs < 2 * timeoutMs) return 'TARGET_ID_LEASE_MS';
  if (Number.isNaN(boundedInt(config.TARGET_DIAG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, TIMEOUT_BOUNDS))) return 'TARGET_DIAG_TIMEOUT_MS';
  if (!diagnosticConfig(config).ok) return 'TARGET_CLIENT_CODE/TARGET_PROPERTY_TOKEN';
  return null;
}

function retirementGate(config) {
  if (config.TARGET_ID_RETIREMENT_ENABLED !== 'true') return 'TARGET_ID_RETIREMENT_ENABLED';
  if (config.TARGET_ID_BINDING_STORE_APPROVED !== 'true') return 'TARGET_ID_BINDING_STORE_APPROVED';
  if (config.TARGET_ID_ORG_ID !== PARTNER.orgId) return 'TARGET_ID_ORG_ID';
  if (!DPID.test(config.TARGET_ID_DPID || '')) return 'TARGET_ID_DPID';
  const timeoutMs = boundedInt(config.TARGET_ID_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, TIMEOUT_BOUNDS);
  const leaseMs = boundedInt(config.TARGET_ID_LEASE_MS, DEFAULT_LEASE_MS, LEASE_BOUNDS);
  if (Number.isNaN(timeoutMs)) return 'TARGET_ID_TIMEOUT_MS';
  if (Number.isNaN(leaseMs) || leaseMs < 2 * timeoutMs) return 'TARGET_ID_LEASE_MS';
  return null;
}

/** Strict JSON body: a single object, size-capped. Anything else is null (a 400, never `{}`). */
function parseBody(params) {
  const raw = params.__ow_body;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  if (typeof raw !== 'string' || raw.length > MAX_BODY_BYTES * 2) return null;
  const candidates = [raw];
  if (!/^\s*\{/.test(raw)) candidates.push(Buffer.from(raw, 'base64').toString('utf8'));
  for (let i = 0; i < candidates.length; i += 1) {
    const text = candidates[i];
    if (Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES && /^\s*\{/.test(text)) {
      try {
        const v = JSON.parse(text);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch { /* not JSON: falls through to the 400 below */ }
    }
  }
  return null;
}

function headerOf(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function cors(config, origin) {
  const allowed = csv(config.TARGET_DIAG_ALLOWED_ORIGINS).filter((o) => o !== '*');
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

/**
 * @param {object} deps injectable effects (tests); production uses the real ones
 */
function createTargetDiagnosticHandler({
  getStore, verify = verifyToken, fetchImpl = fetch, logger, namespace = () => process.env.__OW_NAMESPACE,
  now = Date.now, randomUUID,
} = {}) {
  const log = (level, fields) => logger?.[level]?.(JSON.stringify({ event: 'target-diagnostic', ...fields }));

  return async function handle(params = {}) {
    const config = serverConfig(params, namespace());
    const headers = params.__ow_headers || {};
    const method = String(params.__ow_method || '').toLowerCase();
    // A closed endpoint looks absent: no CORS grant before the base gate passes.
    let corsHeaders = {};
    const respond = (statusCode, body, fields = {}) => {
      body = {
        environment: ENVIRONMENTS.includes(config.TARGET_DIAG_ENVIRONMENT) ? config.TARGET_DIAG_ENVIRONMENT : null,
        evidence: false,
        financialAuthorization: false,
        ...body,
      };
      log(statusCode >= 500 ? 'error' : 'info', {
        op: fields.op || null, httpStatus: statusCode, status: body.status, reason: body.reason || null,
        bindingReason: body.bindingReason || null, gate: body.gate || null,
      });
      return { statusCode, headers: { 'Content-Type': 'application/json', ...corsHeaders }, body };
    };

    const closed = baseGate(config);
    if (closed) return respond(404, { status: 'unavailable', reason: closed });
    corsHeaders = cors(config, headerOf(headers, 'origin'));
    if (method === 'options') return respond(204, { status: 'ok' });
    if (method !== 'post') return respond(405, { status: 'unavailable', reason: 'method-not-allowed' });

    if (headerOf(headers, 'x-wknd-delegation') !== undefined) {
      return respond(403, { status: 'unavailable', reason: 'delegated-not-allowed' });
    }
    const token = bearer({ authorization: headerOf(headers, 'authorization') });
    if (!token) return respond(401, { status: 'unavailable', reason: 'unauthenticated' });
    let claims;
    try {
      claims = await verify(token, config);
    } catch {
      return respond(401, { status: 'unavailable', reason: 'unauthenticated' });
    }
    const sub = claims?.sub;
    if (typeof sub !== 'string' || !sub.trim() || sub.length > 256) {
      return respond(401, { status: 'unavailable', reason: 'unauthenticated' });
    }
    if (!csv(config.TARGET_DIAG_SHOPPER_KEYS).includes(shopperKey(config.AUTH0_ISSUER, sub))) {
      return respond(403, { status: 'unavailable', reason: 'not-allowlisted' });
    }

    const body = parseBody(params);
    if (typeof body?.op !== 'string' || !Object.prototype.hasOwnProperty.call(BODY_KEYS, body.op)) {
      return respond(400, { status: 'unavailable', reason: 'invalid-request' });
    }
    const allowedKeys = BODY_KEYS[body.op];
    if (Object.keys(body).some((k) => k !== 'op' && !allowedKeys.includes(k))) {
      return respond(400, { status: 'unavailable', reason: 'invalid-request' });
    }
    const { op } = body;
    const linkage = linkageConfig(config);
    if (op === 'consent' && body.optIn === true) {
      if (!linkage.enabled) return respond(403, { status: 'unavailable', reason: 'linkage-disabled' }, { op });
      if (!linkage.wordingVersions.includes(body.wordingVersion)) {
        return respond(403, { status: 'unavailable', reason: 'wording-not-approved' }, { op });
      }
    }
    if (op === 'consent' && typeof body.optIn !== 'boolean') {
      return respond(400, { status: 'unavailable', reason: 'invalid-request' }, { op });
    }
    if (op === 'decide') {
      const gate = decideGate(config);
      if (gate) return respond(503, { status: 'unavailable', reason: 'not-approved', gate }, { op });
    }
    if (op === 'retirement') {
      if (!['submit', 'observe'].includes(body.step)) {
        return respond(400, { status: 'unavailable', reason: 'invalid-request' }, { op });
      }
      const gate = retirementGate(config);
      if (gate) return respond(503, { status: 'unavailable', reason: 'not-approved', gate }, { op });
    }

    let store;
    try {
      store = await getStore(config);
    } catch (e) {
      return respond(503, { status: 'unavailable', reason: 'store-unavailable' }, { op });
    }
    try {
      if (op === 'consent-status') {
        const c = await createIdLinkageConsentSource(store, { issuer: config.AUTH0_ISSUER })
          .lookup({ shopperKey: shopperKey(config.AUTH0_ISSUER, sub), sub });
        const consent = ['granted', 'withdrawn', 'absent'].includes(c.state) ? c.state : 'unknown';
        return respond(200, { status: 'ok', consent }, { op });
      }
      if (op === 'consent') {
        try {
          const r = await setIdLinkageConsent(store, { sub, delegated: false }, body.optIn, {
            source: body.source ?? 'account-settings',
            wordingVersion: body.wordingVersion ?? null,
            config: linkage,
            clock: now,
            ...(randomUUID ? { randomUUID } : {}),
          });
          return respond(200, { status: 'ok', consent: r.state, changed: r.changed }, { op });
        } catch (e) {
          if (!(e instanceof IdLinkageError)) throw e;
          const [code, reason] = LINKAGE_ERROR_STATUS[e.code] || [500, 'internal'];
          return respond(code, { status: 'unavailable', reason }, { op });
        }
      }
      if (op === 'retirement') {
        const retirement = createIdRetirementService({
          enabled: config.TARGET_ID_RETIREMENT_ENABLED === 'true',
          orgId: config.TARGET_ID_ORG_ID, dpid: config.TARGET_ID_DPID,
          environment: config.TARGET_DIAG_ENVIRONMENT, namespace: config.__OW_NAMESPACE,
          consent: createIdLinkageConsentSource(store, { issuer: config.AUTH0_ISSUER }),
          store: createBindingStore(store), fetchImpl, now,
          timeoutMs: boundedInt(config.TARGET_ID_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, TIMEOUT_BOUNDS),
          leaseMs: boundedInt(config.TARGET_ID_LEASE_MS, DEFAULT_LEASE_MS, LEASE_BOUNDS),
          ...(randomUUID ? { randomUUID } : {}),
        });
        return respond(200, await retirement.run({
          shopperKey: shopperKey(config.AUTH0_ISSUER, sub), sub, step: body.step,
        }), { op });
      }
      const provider = createIdServiceBindingProvider({
        orgId: config.TARGET_ID_ORG_ID,
        dpid: config.TARGET_ID_DPID,
        consent: createIdLinkageConsentSource(store, { issuer: config.AUTH0_ISSUER }),
        store: createBindingStore(store),
        fetchImpl,
        now,
        timeoutMs: boundedInt(config.TARGET_ID_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, TIMEOUT_BOUNDS),
        leaseMs: boundedInt(config.TARGET_ID_LEASE_MS, DEFAULT_LEASE_MS, LEASE_BOUNDS),
      });
      if (!provider.configured) {
        return respond(503, { status: 'unavailable', reason: 'not-approved', gate: 'binding-provider' }, { op });
      }
      const result = await runTargetDiagnostic({
        claims: { sub },
        params: config,
        bindingProvider: provider,
        fetchImpl,
        timeoutMs: boundedInt(config.TARGET_DIAG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, TIMEOUT_BOUNDS),
        now,
        ...(randomUUID ? { randomUUID } : {}),
      });
      return respond(200, result, { op });
    } catch (e) {
      log('error', { op, category: 'internal', errorName: e?.name || 'Error', errorCode: typeof e?.code === 'string' || typeof e?.code === 'number' ? e.code : null });
      return respond(500, { status: 'unavailable', reason: 'internal' }, { op });
    } finally {
      await store.close?.().catch(() => {});
    }
  };
}

module.exports = {
  CONFIG_KEYS,
  BODY_KEYS,
  serverConfig,
  baseGate,
  decideGate,
  retirementGate,
  parseBody,
  createTargetDiagnosticHandler,
};
